-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PlanTier" ADD VALUE 'TRIAL';
ALTER TYPE "PlanTier" ADD VALUE 'CREATOR';

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "currentPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
