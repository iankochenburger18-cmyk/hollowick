-- Admin insights view: one row per registered user with everything needed
-- for a day-to-day look at the account — email, plan, credit balance,
-- signup date, when (if ever) they first went onto a paid plan, how long
-- they've been a customer / on their current plan, and their average
-- monthly credit usage.
--
-- Read straight out of Supabase Studio: open Table Editor (views show up
-- there alongside tables) or the SQL editor and query
-- `admin_user_insights` directly.
--
-- Run this in the Supabase SQL editor any time you want to (re-)create or
-- update it — CREATE OR REPLACE VIEW is safe to re-run. This replaces the
-- original, simpler version of this file; re-run it even if you already
-- created the view once before, since the columns have changed.
--
-- Notes on a few columns:
--   plan_status        — "Free trial (active)" / "Free trial (expired)" /
--                         "Paid". Trial length (7 days) is hardcoded here
--                         to match PLAN_CONFIG.TRIAL.periodDays in
--                         src/lib/plans.ts — if that ever changes, update
--                         the "+ interval '7 days'" below to match.
--   first_paid_at       — set automatically by a DB trigger (see the
--                         add_first_paid_at migration) the first time this
--                         account's plan moves off TRIAL. Null if it never
--                         has.
--   days_as_customer     — days since signup, regardless of plan.
--   days_on_current_plan — days since first_paid_at if they've ever paid,
--                         otherwise same as days_as_customer (i.e. still
--                         measuring time on the free trial).
--   avg_credits_per_month — lifetime credits used (excluding failed jobs)
--                         divided by months since signup, floored at 1
--                         month so a brand-new signup's early usage isn't
--                         wildly extrapolated into a huge monthly rate.
--   credits_used_last_30_days — a more current complement to the lifetime
--                         average, in case usage has sped up or slowed
--                         down recently.
--   credit_balance / credits_used_this_period / generations_this_period —
--                         scoped to the *current* billing or trial period
--                         (currentPeriodStart onward), same definition the
--                         app itself uses to decide whether a generation
--                         request is allowed.

create or replace view admin_user_insights as
with job_totals as (
  select
    "userId",
    sum("costCents") filter (where status != 'FAILED') as lifetime_credits_used,
    sum("costCents") filter (
      where status != 'FAILED' and "createdAt" >= now() - interval '30 days'
    ) as credits_used_last_30_days
  from "GenerationJob"
  group by "userId"
),
period_usage as (
  select
    g."userId",
    sum(g."costCents") as credits_used_this_period,
    count(g.id) as generations_this_period
  from "GenerationJob" g
  join "Subscription" s on s."userId" = g."userId"
  where g.status != 'FAILED' and g."createdAt" >= s."currentPeriodStart"
  group by g."userId"
)
select
  u.id as user_id,
  u.email,
  u."createdAt" as signed_up_at,
  s."planTier" as plan,
  case
    when s."planTier" = 'TRIAL' and now() <= s."currentPeriodStart" + interval '7 days'
      then 'Free trial (active)'
    when s."planTier" = 'TRIAL'
      then 'Free trial (expired)'
    else 'Paid'
  end as plan_status,
  s."firstPaidAt" as first_paid_at,
  extract(day from now() - u."createdAt")::int as days_as_customer,
  case
    when s."firstPaidAt" is not null then extract(day from now() - s."firstPaidAt")::int
    else extract(day from now() - u."createdAt")::int
  end as days_on_current_plan,
  s."currentPeriodStart" as period_start,
  s."currentPeriodEnd" as period_end,
  case s."planTier"
    when 'TRIAL' then 320
    when 'STARTER' then 2400
    when 'CREATOR' then 5100
    when 'PRO' then 10400
    when 'STUDIO' then 21900
  end as monthly_credits,
  coalesce(pu.credits_used_this_period, 0) as credits_used_this_period,
  case s."planTier"
    when 'TRIAL' then 320
    when 'STARTER' then 2400
    when 'CREATOR' then 5100
    when 'PRO' then 10400
    when 'STUDIO' then 21900
  end - coalesce(pu.credits_used_this_period, 0) as credit_balance,
  coalesce(pu.generations_this_period, 0) as generations_this_period,
  round(
    coalesce(jt.lifetime_credits_used, 0)::numeric
    / greatest(1, extract(day from now() - u."createdAt") / 30.0),
    1
  ) as avg_credits_per_month,
  coalesce(jt.credits_used_last_30_days, 0) as credits_used_last_30_days
from "User" u
left join "Subscription" s on s."userId" = u.id
left join job_totals jt on jt."userId" = u.id
left join period_usage pu on pu."userId" = u.id
order by u."createdAt" desc;
