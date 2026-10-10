-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "firstPaidAt" TIMESTAMP(3);

-- Automatically stamp firstPaidAt the first time an account's planTier
-- moves off TRIAL onto any paid tier. Fires on every UPDATE of
-- Subscription regardless of what causes the change — a future billing
-- webhook, or (today) a manual edit in Supabase's Table Editor — so
-- "when did they become a paying customer" stays accurate without the
-- application needing to remember to set it itself every call site.
CREATE OR REPLACE FUNCTION set_subscription_first_paid_at()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."planTier" = 'TRIAL' AND NEW."planTier" != 'TRIAL' AND NEW."firstPaidAt" IS NULL THEN
    NEW."firstPaidAt" := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_subscription_first_paid_at ON "Subscription";

CREATE TRIGGER trg_subscription_first_paid_at
BEFORE UPDATE ON "Subscription"
FOR EACH ROW
EXECUTE FUNCTION set_subscription_first_paid_at();
