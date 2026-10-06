-- Admin insights view: every registered user, their plan, and their usage
-- for the current billing/trial period, in one queryable place.
--
-- This is meant to be read straight out of Supabase Studio — open
-- Table Editor (views show up there alongside tables) or the SQL editor
-- and query `admin_user_insights` directly. It answers exactly what was
-- asked for: "see all registered users and what plan they are currently
-- on... the number of generations they did in the current month and the
-- number they have left... and I also want to see their email."
--
-- Run this once in the Supabase SQL editor after `prisma migrate deploy`
-- has created the User/Subscription/GenerationJob tables. Re-run it any
-- time you want to pick up a change to this file (CREATE OR REPLACE VIEW
-- is safe to re-run).
--
-- Note on "period_start": paid-tier rollover happens lazily, the next time
-- that user calls POST /api/generate after their period elapses (see
-- src/lib/plans.ts + src/app/api/generate/route.ts). So for a user who
-- hasn't generated anything in a while, period_start/period_end here may
-- reflect their last *recorded* period rather than what it would roll
-- over to right now — credits_remaining_this_period is still accurate
-- against that recorded window, it just hasn't been advanced yet.

create or replace view admin_user_insights as
select
  u.id as user_id,
  u.email,
  u."createdAt" as signed_up_at,
  s."planTier" as plan,
  s."currentPeriodStart" as period_start,
  s."currentPeriodEnd" as period_end,
  case s."planTier"
    when 'TRIAL' then 320
    when 'STARTER' then 2400
    when 'CREATOR' then 5100
    when 'PRO' then 10400
    when 'STUDIO' then 21900
  end as monthly_credits,
  coalesce(
    sum(g."costCents") filter (
      where g."createdAt" >= s."currentPeriodStart" and g.status != 'FAILED'
    ),
    0
  ) as credits_used_this_period,
  case s."planTier"
    when 'TRIAL' then 320
    when 'STARTER' then 2400
    when 'CREATOR' then 5100
    when 'PRO' then 10400
    when 'STUDIO' then 21900
  end - coalesce(
    sum(g."costCents") filter (
      where g."createdAt" >= s."currentPeriodStart" and g.status != 'FAILED'
    ),
    0
  ) as credits_remaining_this_period,
  count(g.id) filter (
    where g."createdAt" >= s."currentPeriodStart" and g.status != 'FAILED'
  ) as generations_this_period
from "User" u
left join "Subscription" s on s."userId" = u.id
left join "GenerationJob" g on g."userId" = u.id
group by u.id, u.email, u."createdAt", s."planTier", s."currentPeriodStart", s."currentPeriodEnd"
order by u."createdAt" desc;
