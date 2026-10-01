#!/usr/bin/env python3
"""
Make every offering plan's pages searchable: OCR scanned pages and fill in
plans that were never stored.

Default mode — PDFs already in Supabase Storage (bucket `plans`):
  documents.fetch_status = 'stored', empty_pages > 0, and ocr_status null,
  'running' (a run killed mid-document) or 'error…' (retried next run).
  Pages whose `body` is empty (or all pages when needs_ocr) are rasterized
  with PyMuPDF, run through Tesseract, and upserted into `pages`.

--from-ag mode — offering plans not in Storage (too large, never fetched,
  or a failed fetch): each PDF is downloaded from the AG site to a temp file,
  pages keep their own text layer where they have one, the rest are OCR'd,
  and only text is saved. The PDF is deleted afterwards.

Pages that already have text in `pages` are never overwritten.

Setup:
  brew install tesseract          # or apt install tesseract-ocr
                                  # or winget install UB-Mannheim.TesseractOCR
  pip install pymupdf pytesseract supabase
Env:
  SUPABASE_URL          https://dvywgltjqpntldlztapu.supabase.co
  SUPABASE_SERVICE_KEY  service_role key (never the anon key; keep it local)
  TESSERACT_CMD         optional path to tesseract if it is not on PATH
Run:
  python ocr-stored.py                 # stored plans with empty pages
  python ocr-stored.py --limit 5 --smallest   # quick test run
  python ocr-stored.py --scanned-only  # the 254 fully scanned plans first
  python ocr-stored.py --from-ag       # plans not in Storage, from the AG site
  python ocr-stored.py --workers 8     # parallel pages within a document
Progress (SQL):
  select split_part(ocr_status, ':', 1), count(*) from documents group by 1
"""
import argparse, io, os, shutil, socket, sys, tempfile, time
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from datetime import datetime, timezone

import httpx
import pymupdf as fitz
import pytesseract
from PIL import Image
from supabase import create_client

URL = os.environ["SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]
BUCKET = "plans"
AG = "https://offeringplandatasearch.ag.ny.gov/REF/"
DPI = 200
MAX_PX = 6000           # longest rendered side; a letter page at 200 DPI is 2200
MIN_CHARS = 20          # a page with fewer chars counts as empty
PAGE = 1000             # PostgREST returns at most this many rows per request
BATCH = 25              # pages per upsert; halved on statement timeout
# Each inserted page fires refresh_plan_tsv, which re-aggregates the whole
# plan, so big batches on big plans exceed the API's 8s statement timeout.
OFFLINE_WAIT = 60       # seconds between retries while the network is down
WIN_TESSERACT = r"C:\Program Files\Tesseract-OCR\tesseract.exe"


def tesseract_cmd():
    cmd = os.environ.get("TESSERACT_CMD") or shutil.which("tesseract")
    if not cmd and os.path.exists(WIN_TESSERACT):
        cmd = WIN_TESSERACT
    return cmd


pytesseract.pytesseract.tesseract_cmd = tesseract_cmd() or "tesseract"


def clean(text):
    # Postgres text cannot hold NUL; some PDF text layers contain it.
    return text.replace("\x00", "").strip()


def ocr_pages(args):
    # Each task opens the PDF from disk once and OCRs a run of pages, so the
    # PDF bytes are never copied into the worker processes.
    pdf_path, page_nos = args
    out = []
    doc = fitz.open(pdf_path)
    try:
        for n in page_nos:
            page = doc[n - 1]
            # Oversized sheets (site plans, drawings) at full DPI can exhaust
            # memory and kill the worker; cap the longest side instead.
            zoom = min(DPI / 72, MAX_PX / max(page.rect.width, page.rect.height, 1))
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY)
            img = Image.open(io.BytesIO(pix.tobytes("png")))
            text = pytesseract.image_to_string(img, lang="eng", config="--psm 6")
            out.append((n, clean(text)))
    finally:
        doc.close()
    return out


def chunks(seq, parts):
    size = max(1, -(-len(seq) // parts))
    return [seq[i:i + size] for i in range(0, len(seq), size)]


def fetch_all(q):
    rows, start = [], 0
    while True:
        part = q.range(start, start + PAGE - 1).execute().data
        rows += part
        if len(part) < PAGE:
            return rows
        start += PAGE


def is_pending(d):
    s = d.get("ocr_status")
    return s is None or s == "running" or s.startswith("error")


def pending_docs(sb, limit, scanned_only, smallest):
    q = (sb.table("documents")
           .select("file_id, plan_id, storage_path, num_pages, empty_pages, needs_ocr")
           .eq("fetch_status", "stored")
           .or_("ocr_status.is.null,ocr_status.eq.running,ocr_status.like.error*")
           .gt("empty_pages", 0)
           .order("empty_pages", desc=not smallest)
           .order("file_id"))
    if scanned_only:
        q = q.eq("needs_ocr", True)
    docs = fetch_all(q)
    return docs[:limit] if limit else docs


def ag_docs(sb, limit, largest):
    # Offering plans with no stored PDF, or whose stored PDF failed to parse,
    # that are not already complete. Filtered here: the conditions nest
    # deeper than one PostgREST or=().
    rows = fetch_all(sb.table("documents")
                       .select("file_id, plan_id, num_pages, empty_pages, status, "
                               "fetch_status, size_mb, ocr_status")
                       .eq("doc_kind", "offering_plan")
                       .order("file_id"))
    docs = [d for d in rows if is_pending(d)
            and (d["fetch_status"] != "stored" or d["status"] != "done")
            and (d["status"] != "done" or (d["empty_pages"] or 0) > 0)]
    docs.sort(key=lambda d: float(d["size_mb"] or 0), reverse=largest)
    return docs[:limit] if limit else docs


def existing_bodies(sb, file_id):
    rows = fetch_all(sb.table("pages").select("page_no, body")
                       .eq("file_id", file_id).order("page_no"))
    return {r["page_no"]: (r["body"] or "") for r in rows}


def empty_page_numbers(sb, file_id, num_pages, needs_ocr):
    if needs_ocr:
        return list(range(1, num_pages + 1))
    have = existing_bodies(sb, file_id)
    return [n for n in range(1, num_pages + 1) if len(have.get(n, "")) < MIN_CHARS]


def save_rows(sb, rows):
    size, j = BATCH, 0
    while j < len(rows):
        try:
            sb.table("pages").upsert(rows[j:j + size], on_conflict="file_id,page_no").execute()
            j += size
        except Exception as e:
            if "57014" not in str(e) or size == 1:
                raise
            size = max(1, size // 2)


def now():
    return datetime.now(timezone.utc).isoformat()


def set_status(sb, file_id, status, note=None):
    sb.table("documents").update({
        "ocr_status": status if note is None else f"{status}: {note[:200]}",
        "ocr_at": now(),
    }).eq("file_id", file_id).execute()


def is_network_error(e):
    return isinstance(e, (httpx.TransportError, ConnectionError, socket.gaierror)) \
        or "getaddrinfo" in str(e)


def run_ocr(pool, pdf_path, targets, workers, isolate=False):
    """Returns ({page_no: text}, [pages that crash the renderer])."""
    if isolate:
        return run_ocr_isolated(pdf_path, targets)
    # Several chunks per worker keeps the pool busy when page costs vary.
    tasks = [(pdf_path, c) for c in chunks(targets, workers * 4)]
    return dict(r for part in pool.map(ocr_pages, tasks) for r in part), []


def run_ocr_isolated(pdf_path, targets):
    # Some corrupt pages crash MuPDF itself (heap corruption), killing the
    # worker. One page at a time on a single worker pins the crash to a page,
    # which is skipped; the rest of the document still gets read.
    results, bad, todo = {}, [], list(targets)
    while todo:
        p = ProcessPoolExecutor(max_workers=1)
        try:
            while todo:
                results.update(p.submit(ocr_pages, (pdf_path, [todo[0]])).result())
                todo.pop(0)
        except BrokenProcessPool:
            bad.append(todo.pop(0))
        finally:
            p.shutdown(wait=False, cancel_futures=True)
    return results, bad


def bad_note(bad):
    return f"; renderer crashed on pages {','.join(map(str, bad))}" if bad else ""


def process_doc(sb, pool, tmp, d, workers, isolate=False):
    fid, pid = d["file_id"], d["plan_id"]
    set_status(sb, fid, "running")
    targets = empty_page_numbers(sb, fid, d["num_pages"], d["needs_ocr"])
    if not targets:
        set_status(sb, fid, "done", "no empty pages")
        return "no empty pages"
    pdf_path = os.path.join(tmp, f"{fid}.pdf")
    with open(pdf_path, "wb") as f:
        f.write(sb.storage.from_(BUCKET).download(d["storage_path"]))
    try:
        results, bad = run_ocr(pool, pdf_path, targets, workers, isolate)
    finally:
        os.remove(pdf_path)
    rows = [{"file_id": fid, "plan_id": pid, "page_no": n, "body": txt}
            for n, txt in sorted(results.items()) if len(txt) >= MIN_CHARS]
    save_rows(sb, rows)
    still_empty = len(targets) - len(rows)
    sb.table("documents").update({"empty_pages": still_empty}).eq("file_id", fid).execute()
    set_status(sb, fid, "done", f"{len(rows)}/{len(targets)} pages got text{bad_note(bad)}")
    return f"{len(rows)}/{len(targets)} pages{bad_note(bad)}"


def ag_download(client, plan_id, file_id, path):
    # Same request as the plan page's Download button for one checked file.
    client.get(AG + "planFormServlet", params={"planId": plan_id})
    with client.stream("POST", AG + "downloadPDF",
                       data={"checkedFileId": str(file_id), "checkedFileIdArray": str(file_id)}) as r:
        r.raise_for_status()
        with open(path, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
    with open(path, "rb") as f:
        head = f.read(1024)
    if b"%PDF" not in head:
        raise ValueError(f"AG returned something other than a PDF: {head[:60]!r}")


def process_ag_doc(sb, pool, tmp, client, d, workers, isolate=False):
    fid, pid = d["file_id"], d["plan_id"]
    set_status(sb, fid, "running")
    pdf_path = os.path.join(tmp, f"{fid}.pdf")
    try:
        ag_download(client, pid, fid, pdf_path)
        doc = fitz.open(pdf_path)
        try:
            n_pages = doc.page_count
            layer = {i + 1: clean(doc[i].get_text()) for i in range(n_pages)}
        finally:
            doc.close()
        have = existing_bodies(sb, fid)
        missing = [n for n in range(1, n_pages + 1) if len(have.get(n, "")) < MIN_CHARS]
        from_layer = {n: layer[n] for n in missing if len(layer[n]) >= MIN_CHARS}
        to_ocr = [n for n in missing if n not in from_layer]
        ocred, bad = run_ocr(pool, pdf_path, to_ocr, workers, isolate) if to_ocr else ({}, [])
    finally:
        if os.path.exists(pdf_path):
            os.remove(pdf_path)
    new = {**from_layer, **{n: t for n, t in ocred.items() if len(t) >= MIN_CHARS}}
    save_rows(sb, [{"file_id": fid, "plan_id": pid, "page_no": n, "body": new[n]}
                   for n in sorted(new)])
    final = {n: have.get(n, "") for n in range(1, n_pages + 1)}
    final.update(new)
    still_empty = sum(1 for t in final.values() if len(t) < MIN_CHARS)
    sb.table("documents").update({
        "num_pages": n_pages, "empty_pages": still_empty,
        "text_chars": sum(len(t) for t in final.values()),
        "status": "done", "error": None, "extracted_at": now(),
    }).eq("file_id", fid).execute()
    note = (f"ag: {len(from_layer)} text-layer + {len(new) - len(from_layer)}/{len(to_ocr)} "
            f"OCR pages, {still_empty}/{n_pages} still empty{bad_note(bad)}")
    set_status(sb, fid, "done", note)
    return note


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--scanned-only", action="store_true")
    ap.add_argument("--smallest", action="store_true", help="fewest empty pages first (quick tests)")
    ap.add_argument("--from-ag", action="store_true", help="plans not in Storage, downloaded from the AG site")
    ap.add_argument("--largest", action="store_true", help="with --from-ag: biggest files first")
    ap.add_argument("--plan", action="append", help="only these plan ids (repeatable)")
    a = ap.parse_args()

    if not tesseract_cmd():
        sys.exit("tesseract not found: install it or set TESSERACT_CMD")
    if sys.platform == "win32":
        # Keep Windows from sleeping while this process runs (released on exit).
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)

    sb = create_client(URL, KEY)
    if a.from_ag:
        docs = ag_docs(sb, a.limit, a.largest)
        print(f"{len(docs)} documents from the AG site, "
              f"{sum(float(d['size_mb'] or 0) for d in docs):,.0f} MB", flush=True)
    else:
        docs = pending_docs(sb, a.limit, a.scanned_only, a.smallest)
        print(f"{len(docs)} documents, {sum(d['empty_pages'] for d in docs):,} empty pages", flush=True)

    if a.plan:
        docs = [d for d in docs if d["plan_id"] in a.plan]
        print(f"{len(docs)} of them in --plan {' '.join(a.plan)}", flush=True)

    client = httpx.Client(timeout=httpx.Timeout(60, read=600), follow_redirects=True,
                          headers={"User-Agent": "Mozilla/5.0"})
    pool = ProcessPoolExecutor(max_workers=a.workers)
    with client, tempfile.TemporaryDirectory() as tmp:
        for i, d in enumerate(docs, 1):
            fid, pid = d["file_id"], d["plan_id"]
            t0 = time.time()
            crashes = 0
            try:
                # A dropped connection waits and retries this document instead
                # of failing every remaining document in seconds. A dead worker
                # breaks the whole pool, so it is replaced before going on.
                while True:
                    try:
                        isolate = crashes > 0
                        msg = (process_ag_doc(sb, pool, tmp, client, d, a.workers, isolate) if a.from_ag
                               else process_doc(sb, pool, tmp, d, a.workers, isolate))
                        break
                    except BrokenProcessPool:
                        pool.shutdown(wait=False, cancel_futures=True)
                        pool = ProcessPoolExecutor(max_workers=a.workers)
                        crashes += 1
                        if crashes >= 2:
                            raise
                        print(f"[{i}/{len(docs)}] {pid} {fid}: worker crashed; "
                              f"retrying one page at a time", file=sys.stderr, flush=True)
                    except Exception as e:
                        if not is_network_error(e):
                            raise
                        print(f"[{i}/{len(docs)}] {pid} {fid}: offline ({e}); "
                              f"retrying in {OFFLINE_WAIT}s", file=sys.stderr, flush=True)
                        time.sleep(OFFLINE_WAIT)
                print(f"[{i}/{len(docs)}] {pid} {fid}: {msg} in {time.time()-t0:.0f}s", flush=True)
            except Exception as e:
                print(f"[{i}/{len(docs)}] {pid} {fid}: ERROR {e}", file=sys.stderr, flush=True)
                try:
                    set_status(sb, fid, "error", str(e))
                except Exception as e2:
                    print(f"  could not record error status: {e2}", file=sys.stderr, flush=True)
    pool.shutdown(cancel_futures=True)


if __name__ == "__main__":
    main()
