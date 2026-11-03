-- AlterTable: denormalized copy of the add-on owner's email, so the raw
-- ModelAddon table reads/filters by email directly in Supabase's Table
-- Editor without joining through Subscription -> User (see
-- supabase/sql/admin_user_addons.sql for the view that already does that
-- join). Added NOT NULL DEFAULT '' so the column exists non-null for the
-- backfill step right below, same as every existing row gets a real value
-- a moment later.
ALTER TABLE "ModelAddon" ADD COLUMN "email" TEXT NOT NULL DEFAULT '';

-- Backfill every existing row from its subscription's current user.
UPDATE "ModelAddon" ma
SET "email" = u."email"
FROM "Subscription" s
JOIN "User" u ON u.id = s."userId"
WHERE s.id = ma."subscriptionId";

-- Auto-populate email on every future insert, looked up from
-- subscriptionId, regardless of what (if anything) the app passed in —
-- so this is correct even for a row added by hand in Supabase's Table
-- Editor, not just through the app's own addModelAddon (see
-- src/lib/model-addons.ts, which doesn't set this field itself; Prisma's
-- schema-level @default("") is just a placeholder this trigger always
-- overwrites before the row is actually written).
CREATE OR REPLACE FUNCTION set_model_addon_email()
RETURNS TRIGGER AS $$
BEGIN
  SELECT u."email" INTO NEW."email"
  FROM "Subscription" s
  JOIN "User" u ON u.id = s."userId"
  WHERE s.id = NEW."subscriptionId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_model_addon_set_email ON "ModelAddon";

CREATE TRIGGER trg_model_addon_set_email
BEFORE INSERT ON "ModelAddon"
FOR EACH ROW
EXECUTE FUNCTION set_model_addon_email();

-- Keep every existing ModelAddon row's email copy in sync if the owner's
-- own email ever changes (self-service, or a manual edit in Supabase) —
-- without this, every row would silently go stale the moment an account
-- changed its email, the same risk a one-time snapshot would have had.
CREATE OR REPLACE FUNCTION propagate_user_email_to_model_addons()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."email" IS DISTINCT FROM OLD."email" THEN
    UPDATE "ModelAddon"
    SET "email" = NEW."email"
    WHERE "subscriptionId" IN (
      SELECT id FROM "Subscription" WHERE "userId" = NEW."id"
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_email_propagate_to_model_addons ON "User";

CREATE TRIGGER trg_user_email_propagate_to_model_addons
AFTER UPDATE ON "User"
FOR EACH ROW
EXECUTE FUNCTION propagate_user_email_to_model_addons();
