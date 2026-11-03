-- Admin add-on history view: one row per à la carte model add-on ever
-- bought (see ModelAddon in prisma/schema.prisma) — which model, what it
-- was priced at when bought, when it was added, when (if ever) it was
-- removed, whether it's still active, and how many days the account
-- actually had it for. Companion to admin_user_insights.sql, which is one
-- row per user; this is one row per add-on, so it reads cleanly even for
-- accounts that have added/removed multiple models (or the same model more
-- than once) over time.
--
-- Read straight out of Supabase Studio: open Table Editor (views show up
-- there alongside tables) or the SQL editor and query `admin_user_addons`
-- directly.
--
-- Run this in the Supabase SQL editor any time you want to (re-)create or
-- update it — CREATE OR REPLACE VIEW is safe to re-run.
--
-- History caveat: ModelAddon rows only started being kept after removal
-- (instead of deleted outright) as of the add_model_addon_removed_at
-- migration (src/lib/model-addons.ts's removeModelAddon). Any add-on
-- removed before that migration was hard-deleted and left no trace — this
-- view can only show removals from that point forward. Everything added
-- before then but still active today still shows up fine (added_at comes
-- from createdAt, which every row has always had).
--
-- Notes on a few columns:
--   price_cents — the exact amount this specific purchase was charged
--                 (snapshotted at purchase time — see ModelAddon.priceCents
--                 in schema.prisma), not today's MODEL_ADDON_PRICE_CENTS
--                 for this model, which may have changed since.
--   status      — "Active" (still unlocked today, still being billed) or
--                 "Removed" (cancelled by the user, or by the whole
--                 subscription being cancelled — see
--                 customer.subscription.deleted in
--                 src/app/api/billing/webhook/route.ts).
--   days_held   — whole days from added_at to removed_at, or to now() if
--                 still active. This is calendar time the model was
--                 unlocked for, not a measure of how much it was actually
--                 used — join against "GenerationJob" (see
--                 admin_user_insights.sql's job_totals CTE for the pattern)
--                 if usage during that window is what you're after.

create or replace view admin_user_addons as
select
  u.email,
  u.id as user_id,
  ma.model,
  ma."priceCents" as price_cents,
  ma."createdAt" as added_at,
  ma."removedAt" as removed_at,
  case when ma."removedAt" is null then 'Active' else 'Removed' end as status,
  extract(day from coalesce(ma."removedAt", now()) - ma."createdAt")::int as days_held
from "ModelAddon" ma
join "Subscription" s on s.id = ma."subscriptionId"
join "User" u on u.id = s."userId"
order by ma."createdAt" desc;
