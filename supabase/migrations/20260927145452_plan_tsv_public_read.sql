-- plan_tsv was created (migration plan_tsv_table, 2026-09-26) with row security on and no
-- read policy, so search_plans_v2 (security invoker) saw no rows through the public key and
-- every site search returned 0 plans. Same public read rule as plans, pages, documents, facts.
create policy read_plan_tsv on public.plan_tsv for select using (true);
