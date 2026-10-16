-- CreateTable
CREATE TABLE "ModelAddon" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "stripeSubscriptionItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelAddon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelAddon_stripeSubscriptionItemId_key" ON "ModelAddon"("stripeSubscriptionItemId");

-- CreateIndex
CREATE INDEX "ModelAddon_subscriptionId_idx" ON "ModelAddon"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelAddon_subscriptionId_model_key" ON "ModelAddon"("subscriptionId", "model");

-- AddForeignKey
ALTER TABLE "ModelAddon" ADD CONSTRAINT "ModelAddon_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
