-- The AG overwrites submitted_date with each amendment's submission date, so a plan's original submission
-- date is lost once it's amended. Keep the first one seen in original_submitted_date and never overwrite it.
-- The trigger fills it on insert and on the first update that finds it empty, so ingest needs no change.
alter table plans add column if not exists original_submitted_date date;

update plans set original_submitted_date = submitted_date
where original_submitted_date is null
  and submitted_date is not null
  and coalesce(amendments_listed,0) = 0
  and (accepted_date is null or submitted_date <= accepted_date);

create or replace function plans_keep_original_submitted() returns trigger language plpgsql
set search_path = public as $$
begin
  if TG_OP = 'UPDATE' and old.original_submitted_date is not null then
    new.original_submitted_date := old.original_submitted_date;
  elsif new.original_submitted_date is null
    and new.submitted_date is not null
    and coalesce(new.amendments_listed,0) = 0
    and (new.accepted_date is null or new.submitted_date <= new.accepted_date) then
    new.original_submitted_date := new.submitted_date;
  end if;
  return new;
end $$;

drop trigger if exists trg_plans_original_submitted on plans;
create trigger trg_plans_original_submitted
before insert or update on plans
for each row execute function plans_keep_original_submitted();
