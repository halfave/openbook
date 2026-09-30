# Renders PDF pages to PNG for scripts/extract-schedule-a-llm.mjs (needs PyMuPDF: pip install pymupdf).
#   python render-pages.py <pdf> count                       → prints the page count
#   python render-pages.py <pdf> <outdir> <dpi> <page> ...   → writes <outdir>/p<page>-<dpi>.png, prints each path
import os, sys, pymupdf
doc = pymupdf.open(sys.argv[1])
if sys.argv[2] == "count":
    print(doc.page_count)
    sys.exit(0)
out, dpi = sys.argv[2], int(sys.argv[3])
os.makedirs(out, exist_ok=True)
for n in map(int, sys.argv[4:]):
    if 1 <= n <= doc.page_count:
        path = os.path.join(out, f"p{n:04d}-{dpi}.png")
        if not os.path.exists(path):
            doc[n - 1].get_pixmap(dpi=dpi).save(path)
        print(path)
