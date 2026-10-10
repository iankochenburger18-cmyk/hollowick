// Stripe client + the small amount of mapping logic that connects our
// PlanTier enum to Stripe's world (Products/Prices created by hand in the
// Stripe Dashboard, identified here only by their Price IDs via env vars).
//
// Used by src/app/api/billing/checkout/route.ts (starts a purchase) and
// src/app/api/billing/webhook/route.ts (keeps our Subscription row in sync
// with whatever Stripe says actually happened — payment succeeded, renewed,
// cancelled, etc.).

import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import type { PlanTierName } from "@/lib/plans";

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  // Don't throw at import time — plenty of code paths (e.g. the worker
  // process) import things that transitively touch this file without ever
  // actually needing to call Stripe. The billing routes themselves will
  // fail loudly and obviously the moment they try to use `stripe` for real.
  console.warn(
    "STRIPE_SECRET_KEY is not set — billing routes will fail until it's added to .env."
  );
}

export const stripe = new Stripe(secretKey ?? "sk_test_missing_STRIPE_SECRET_KEY");

export type PaidPlanTier = Exclude<PlanTierName, "TRIAL">;

const PRICE_ENV_VAR: Record<PaidPlanTier, string> = {
  STARTER: "STRIPE_PRICE_STARTER",
  CREATOR: "STRIPE_PRICE_CREATOR",
  PRO: "STRIPE_PRICE_PRO",
  STUDIO: "STRIPE_PRICE_STUDIO",
};

export function priceIdForTier(tier: PaidPlanTier): string {
  const envVar = PRICE_ENV_VAR[tier];
  const priceId = process.env[envVar];
  if (!priceId) {
    throw new Error(
      `${envVar} is not set — add the Stripe Price ID for the ${tier} plan to .env (Stripe Dashboard → Product catalog → that product → copy the ID starting with "price_", not the Product ID starting with "prod_").`
    );
  }
  return priceId;
}

// The reverse lookup: given a Price ID a webhook told us about, which of our
// plan tiers does it correspond to? Null if it doesn't match any configured
// price (e.g. a stale/test price from before the env vars were set).
export function tierForPriceId(priceId: string): PaidPlanTier | null {
  for (const tier of Object.keys(PRICE_ENV_VAR) as PaidPlanTier[]) {
    if (process.env[PRICE_ENV_VAR[tier]] === priceId) {
      return tier;
    }
  }
  return null;
}

/**
 * Pulls the plan tier + billing period + status off a Stripe Subscription
 * object and writes it onto our own Subscription row. Called from the
 * webhook route for every event that can change a subscription's state
 * (checkout completing, renewals, upgrades/downgrades, cancellations) —
 * same logic every time, since Stripe is the single source of truth for all
 * of this once a customer has paid at least once.
 *
 * Note: current_period_start/end live on the subscription *item*, not the
 * subscription object itself (Stripe moved them there to support multiple
 * items with independent billing cycles) — see SubscriptionItem in the
 * stripe package's own type definitions.
 *
 * `userId` is passed the first time, from Checkout Session metadata, since
 * at that point our Subscription row doesn't have a stripeSubscriptionId
 * yet to match on. On every later call we already have that id stored, so
 * we look the row up by it instead and userId can be omitted.
 */
export async function syncSubscriptionFromStripe(
  subscription: Stripe.Subscription,
  userId?: string
): Promise<void> {
  const item = subscription.items.data[0];
  if (!item) {
    console.error(`Stripe subscription ${subscription.id} has no items — can't sync it.`);
    return;
  }

  const tier = tierForPriceId(item.price.id);
  if (!tier) {
    console.error(
      `Stripe subscription ${subscription.id} is on price ${item.price.id}, which doesn't match any STRIPE_PRICE_* env var — can't map it to a plan tier.`
    );
    return;
  }

  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  const data = {
    planTier: tier as PlanTierName,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodStart: new Date(item.current_period_start * 1000),
    currentPeriodEnd: new Date(item.current_period_end * 1000),
  };

  if (userId) {
    await prisma.subscription.update({ where: { userId }, data });
    return;
  }

  const existing = await prisma.subscription.findFirst({
    where: { stripeSubscriptionId: subscription.id },
  });
  if (!existing) {
    console.error(
      `Got a Stripe webhook for subscription ${subscription.id}, but no Subscription row references it yet (and no userId was given to look one up another way).`
    );
    return;
  }
  await prisma.subscription.update({ where: { userId: existing.userId }, data });
}
