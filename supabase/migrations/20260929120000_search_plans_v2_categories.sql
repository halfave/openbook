-- search_plans_v2: optional p_categories filter on plans.category (residential, commercial, parking).
-- Null (the default) filters nothing, so existing callers are unchanged. The old signature is dropped so
-- PostgREST sees one function, not two overloads.
drop function if exists public.search_plans_v2(text,text,integer,integer,integer,integer,text[],text[],integer,integer,integer,integer,integer,date,date,date,date,text[],text[],text[],text,text,text,text[],numeric,numeric,text[],text[],boolean,numeric,text,boolean,text,integer);

CREATE OR REPLACE FUNCTION public.search_plans_v2(q text DEFAULT NULL::text, p_borough text DEFAULT NULL::text, p_max_units integer DEFAULT NULL::integer, p_min_units integer DEFAULT NULL::integer, p_min_parking integer DEFAULT NULL::integer, p_limit integer DEFAULT 50, p_boroughs text[] DEFAULT NULL::text[], p_zips text[] DEFAULT NULL::text[], p_max_parking integer DEFAULT NULL::integer, p_min_commercial integer DEFAULT NULL::integer, p_max_commercial integer DEFAULT NULL::integer, p_min_storage integer DEFAULT NULL::integer, p_max_storage integer DEFAULT NULL::integer, p_accepted_from date DEFAULT NULL::date, p_accepted_to date DEFAULT NULL::date, p_submitted_from date DEFAULT NULL::date, p_submitted_to date DEFAULT NULL::date, p_construction text[] DEFAULT NULL::text[], p_status text[] DEFAULT NULL::text[], p_plan_type text[] DEFAULT NULL::text[], p_sponsor text DEFAULT NULL::text, p_counsel text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_plan_ids text[] DEFAULT NULL::text[], p_min_price numeric DEFAULT NULL::numeric, p_max_price numeric DEFAULT NULL::numeric, p_parking_arrangement text[] DEFAULT NULL::text[], p_tax_program text[] DEFAULT NULL::text[], p_has_affordable boolean DEFAULT NULL::boolean, p_min_reserve_fund numeric DEFAULT NULL::numeric, p_managing_agent text DEFAULT NULL::text, p_has_text boolean DEFAULT NULL::boolean, p_sort text DEFAULT 'hits'::text, p_offset integer DEFAULT 0, p_categories text[] DEFAULT NULL::text[])
 RETURNS TABLE(plan_id text, name text, address text, borough text, zip text, units_residential integer, units_parking integer, units_commercial integer, units_storage integer, accepted_date date, submitted_date date, status text, construction text, plan_type text, sponsor text, law_firm text, price_current numeric, docs_posted integer, docs_indexed integer, has_text boolean, amendments_listed integer, latest_amendment_no integer, ag_url text, parking_arrangement text, tax_program text, reserve_fund numeric, managing_agent text, hits integer, snippets jsonb, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with tq as materialized (
    select case when coalesce(q,'') = '' then null else websearch_to_tsquery('english', fold_text(q)) end as t
  ),
  -- first pass: plan-level match (1.5k rows, fully indexed)
  -- plan_tsv has no word positions, so phrases are matched loosely there, then confirmed on real pages
  tq_loose as materialized (
    select case when (select t from tq) is null then null
      else regexp_replace((select t from tq)::text, '<(-|\d+)>', '&', 'g')::tsquery end as t
  ),
  pm0 as materialized (
    select pt.plan_id, ts_rank(pt.tsv, (select t from tq_loose)) as prank
    from plan_tsv pt where (select t from tq_loose) is not null and pt.tsv @@ (select t from tq_loose)
  ),
  pm as materialized (
    select pm0.* from pm0
    where (select t from tq)::text !~ '<(-|\d+)>'
       or exists (select 1 from pages pg where pg.plan_id = pm0.plan_id and pg.tsv @@ (select t from tq))
  ),
  fx as materialized (
    select f.plan_id,
      max(f.value_text) filter (where f.field='parking_arrangement') as parking_arrangement,
      max(f.value_text) filter (where f.field='tax_program') as tax_program,
      max(f.value_num)  filter (where f.field='reserve_fund') as reserve_fund,
      max(f.value_text) filter (where f.field='managing_agent') as managing_agent,
      bool_or(f.field='affordable_housing') as has_affordable
    from facts f group by f.plan_id
  ),
  filt as materialized (
    select p.plan_id, p.name, p.address, p.borough, p.zip,
      p.units_residential, p.units_parking, p.units_commercial, p.units_storage,
      p.accepted_date, p.submitted_date, p.status, p.construction, p.plan_type,
      p.sponsor, p.law_firm, p.price_current, p.docs_posted,
      p.amendments_listed, p.latest_amendment_no, p.ag_url,
      fx.parking_arrangement, fx.tax_program, fx.reserve_fund, fx.managing_agent,
      coalesce(pm.prank, 0) as prank,
      exists (select 1 from documents d where d.plan_id = p.plan_id and d.status='done' and coalesce(d.needs_ocr,false) = false) as has_text
    from plans p
    left join pm on pm.plan_id = p.plan_id
    left join fx on fx.plan_id = p.plan_id
    where (p_borough is null or p.borough = upper(p_borough))
      and (p_boroughs is null or p.borough = any(select upper(x) from unnest(p_boroughs) x))
      and (p_zips is null or p.zip = any(p_zips))
      and (p_max_units is null or p.units_residential <= p_max_units)
      and (p_min_units is null or p.units_residential >= p_min_units)
      and (p_min_parking is null or p.units_parking >= p_min_parking)
      and (p_max_parking is null or p.units_parking <= p_max_parking)
      and (p_min_commercial is null or p.units_commercial >= p_min_commercial)
      and (p_max_commercial is null or p.units_commercial <= p_max_commercial)
      and (p_min_storage is null or p.units_storage >= p_min_storage)
      and (p_max_storage is null or p.units_storage <= p_max_storage)
      and (p_accepted_from is null or p.accepted_date >= p_accepted_from)
      and (p_accepted_to is null or p.accepted_date <= p_accepted_to)
      and (p_submitted_from is null or p.submitted_date >= p_submitted_from)
      and (p_submitted_to is null or p.submitted_date <= p_submitted_to)
      and (p_construction is null or p.construction = any(select upper(x) from unnest(p_construction) x))
      and (p_status is null or p.status = any(select upper(x) from unnest(p_status) x))
      and (p_plan_type is null or p.plan_type = any(select upper(x) from unnest(p_plan_type) x))
      and (p_sponsor is null or p.sponsor ilike '%' || p_sponsor || '%')
      and (p_counsel is null or p.law_firm ilike '%' || p_counsel || '%')
      and (p_address is null or (coalesce(p.name,'') || ' ' || coalesce(p.address,'')) ilike '%' || p_address || '%')
      and (p_plan_ids is null or p.plan_id = any(p_plan_ids))
      and (p_min_price is null or p.price_current >= p_min_price)
      and (p_max_price is null or p.price_current <= p_max_price)
      and (p_parking_arrangement is null or fx.parking_arrangement = any(p_parking_arrangement))
      and (p_tax_program is null or exists (select 1 from unnest(p_tax_program) t where fx.tax_program ilike t || '%'))
      and (p_has_affordable is null or coalesce(fx.has_affordable,false) = p_has_affordable)
      and (p_min_reserve_fund is null or fx.reserve_fund >= p_min_reserve_fund)
      and (p_managing_agent is null or fx.managing_agent ilike '%' || p_managing_agent || '%')
      and (p_categories is null or coalesce(p.category, 'residential') = any(select lower(x) from unnest(p_categories) x))
      and ((select t from tq) is null or pm.plan_id is not null)
  ),
  filt2 as materialized (select f.* from filt f where p_has_text is null or f.has_text = p_has_text),
  top as materialized (
    select f.*, count(*) over () as total_count from filt2 f
    order by
      case when p_sort = 'hits' then f.prank end desc nulls last,
      case when p_sort = 'accepted_desc' or p_sort = 'hits' then f.accepted_date end desc nulls last,
      case when p_sort = 'accepted_asc' then f.accepted_date end asc nulls last,
      case when p_sort = 'units_asc' then f.units_residential end asc nulls last,
      case when p_sort = 'units_desc' then f.units_residential end desc nulls last,
      case when p_sort = 'price_asc' then f.price_current end asc nulls last,
      case when p_sort = 'price_desc' then f.price_current end desc nulls last,
      f.plan_id
    limit greatest(p_limit,1) offset greatest(p_offset,0)
  ),
  -- second pass: pages only for the window of plans
  m as materialized (
    select pg.plan_id, pg.file_id, pg.page_no, ts_rank(pg.tsv, (select t from tq)) as rank
    from pages pg join top on top.plan_id = pg.plan_id
    where (select t from tq) is not null and pg.tsv @@ (select t from tq)
  ),
  cnt as materialized (select m.plan_id, count(*)::int as hits from m group by m.plan_id),
  best as materialized (
    select y.* from (
      select m.*, row_number() over (partition by m.plan_id order by m.rank desc, m.file_id, m.page_no) as rn from m
    ) y where y.rn <= 3
  ),
  agg as materialized (
    select b.plan_id,
      jsonb_agg(jsonb_build_object('file_id', b.file_id, 'doc', d.filename, 'page', b.page_no, 'pdf_url', d.pdf_url,
        'text', ts_headline('english', pg.body, (select t from tq), 'MaxFragments=1, MaxWords=40, MinWords=15, StartSel=<<, StopSel=>>'))
        order by b.rank desc) as snippets
    from best b join documents d on d.file_id = b.file_id join pages pg on pg.file_id = b.file_id and pg.page_no = b.page_no
    group by b.plan_id
  )
  select top.plan_id, top.name, top.address, top.borough, top.zip,
    top.units_residential, top.units_parking, top.units_commercial, top.units_storage,
    top.accepted_date, top.submitted_date, top.status, top.construction, top.plan_type,
    top.sponsor, top.law_firm, top.price_current,
    top.docs_posted,
    (select count(*)::int from documents d where d.plan_id = top.plan_id and d.status = 'done'),
    top.has_text,
    top.amendments_listed, top.latest_amendment_no, top.ag_url,
    top.parking_arrangement, top.tax_program, top.reserve_fund, top.managing_agent,
    coalesce(cnt.hits, 0), coalesce(agg.snippets, '[]'::jsonb), top.total_count
  from top left join cnt on cnt.plan_id = top.plan_id left join agg on agg.plan_id = top.plan_id
  order by
      case when p_sort = 'hits' then top.prank end desc nulls last,
      case when p_sort = 'accepted_desc' or p_sort = 'hits' then top.accepted_date end desc nulls last,
      case when p_sort = 'accepted_asc' then top.accepted_date end asc nulls last,
      case when p_sort = 'units_asc' then top.units_residential end asc nulls last,
      case when p_sort = 'units_desc' then top.units_residential end desc nulls last,
      case when p_sort = 'price_asc' then top.price_current end asc nulls last,
      case when p_sort = 'price_desc' then top.price_current end desc nulls last,
      top.plan_id;
$function$;

grant execute on function public.search_plans_v2(text,text,integer,integer,integer,integer,text[],text[],integer,integer,integer,integer,integer,date,date,date,date,text[],text[],text[],text,text,text,text[],numeric,numeric,text[],text[],boolean,numeric,text,boolean,text,integer,text[]) to anon, authenticated, service_role;
