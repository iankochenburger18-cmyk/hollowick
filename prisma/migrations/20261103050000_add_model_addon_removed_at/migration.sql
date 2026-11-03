-- AlterTable: soft-delete column. removeModelAddon (src/lib/model-addons.ts)
-- now sets this instead of deleting the row, so an account's add-on history
-- survives removal — see admin_user_addons.sql for the reporting view this
-- is for. Null means the add-on is still active.
ALTER TABLE "ModelAddon" ADD COLUMN "removedAt" TIMESTAMP(3);

-- DropIndex: the old whole-table unique on (subscriptionId, model) made it
-- impossible to ever re-add a model that had been removed, once removal
-- stopped deleting the row. Replaced by the partial unique index below,
-- which only constrains ACTIVE rows.
DROP INDEX "ModelAddon_subscriptionId_model_key";

-- CreateIndex: at most one ACTIVE add-on per model per subscription at a
-- time (removedAt IS NULL) — same guarantee the old index gave, just scoped
-- to active rows so a model can be added, removed, and re-added over time
-- without colliding with its own now-inactive history rows.
CREATE UNIQUE INDEX "ModelAddon_active_subscriptionId_model_key" ON "ModelAddon"("subscriptionId", "model") WHERE "removedAt" IS NULL;
