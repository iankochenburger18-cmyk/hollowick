// À la carte model unlocks — letting an account add one specific model on
// top of their existing plan tier without upgrading the whole plan (see
// MODEL_ADDON_PRICE_CENTS in src/lib/plans.ts for how each one is priced).
// Each add-on is its own Stripe SubscriptionItem living on the account's
// existing Stripe Subscription, so it rides the same billing cycle and
// Stripe prorates the first partial period automatically — no separate
// Checkout flow needed to add or remove one.
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { addonPriceForModel } from "@/lib/plans";

// Turns a model's display name into a stable, URL/lookup_key-safe slug
// (lowercase, non-alphanumerics collapsed to single hyphens) — used so the
// same model always resolves to the same Stripe Price without us having to
// track Price IDs anywhere ourselves.
function slugForModel(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Currency-specific: a Stripe Subscription requires every item on it to
// share one currency, and that currency is set by whichever Price the base
// plan was checked out with (see priceIdForTier in stripe.ts — those Prices
// were created by hand in the Dashboard, not pinned to USD here) — it can
// differ per account. Baking currency into the key means an add-on bought
// by a USD subscription and one bought by a CHF subscription never collide
// on the same Stripe Price (which would either crash, like the bug this is
// fixing, or silently charge the wrong amount for one of the two).
function lookupKeyForModel(model: string, currency: string): string {
  return `model_addon_${slugForModel(model)}_${currency}`;
}

// Finds the Stripe Price for this model's add-on, in the given currency, if
// one was already created (by an earlier purchase of this same model in
// this same currency, by anyone), or creates it. Using `lookup_key` this
// way means we never need our own table mapping models to Stripe Price
// IDs — Stripe's lookup_key index is that table.
//
// `currency` must match the target subscription's own currency (addModelAddon
// below reads it off the live Stripe subscription) — a mismatched currency
// is exactly what used to crash this with Stripe's "doesn't match the
// expected currency" error, since every item on one subscription has to
// share a currency.
export async function getOrCreateAddonPrice(model: string, currency: string): Promise<Stripe.Price> {
  const priceCents = addonPriceForModel(model);
  if (priceCents === null) {
    throw new Error(`"${model}" isn't an add-on-eligible model.`);
  }

  const lookupKey = lookupKeyForModel(model, currency);

  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (existing.data[0]) {
    return existing.data[0];
  }

  // NOTE: priceCents (MODEL_ADDON_PRICE_CENTS in plans.ts) was set assuming
  // USD. Using the same numeric amount for a non-USD currency charges that
  // many minor units of THAT currency instead (e.g. 8500 becomes 85.00 CHF,
  // not a converted $85 equivalent) — fine while CHF and USD stay close to
  // parity, but worth real conversion if that drifts or a currency further
  // from parity shows up.
  return stripe.prices.create({
    currency,
    unit_amount: priceCents,
    recurring: { interval: "month" },
    lookup_key: lookupKey,
    product_data: { name: `${model} (add-on)` },
  });
}

// Adds one model add-on to an account's existing Stripe Subscription and
// records it. Throws (with a message safe to surface to the caller) if the
// account has no live Stripe subscription to attach it to, if the model
// isn't add-on-eligible, or if it's already included in the account's plan
// or already added.
export async function addModelAddon(
  subscription: { id: string; planTier: string; stripeSubscriptionId: string | null },
  model: string
) {
  if (!subscription.stripeSubscriptionId) {
    throw new Error("Pick a paid plan first — there's no active subscription to add this to yet.");
  }

  const priceCents = addonPriceForModel(model);
  if (priceCents === null) {
    throw new Error(`"${model}" isn't an add-on-eligible model.`);
  }

  const alreadyAdded = await prisma.modelAddon.findUnique({
    where: { subscriptionId_model: { subscriptionId: subscription.id, model } },
  });
  if (alreadyAdded) {
    throw new Error(`${model} is already added to your plan.`);
  }

  // Read the currency straight off the live Stripe subscription rather than
  // assuming USD — our own Subscription row doesn't store it, and it's set
  // by whichever Price the base plan was checked out with (see the comment
  // on getOrCreateAddonPrice above). This is what the old hardcoded "usd"
  // got wrong for any subscription whose plan Price isn't actually in USD.
  const stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
  const currency = stripeSubscription.currency;

  const price = await getOrCreateAddonPrice(model, currency);
  const item = await stripe.subscriptionItems.create({
    subscription: subscription.stripeSubscriptionId,
    price: price.id,
  });

  return prisma.modelAddon.create({
    data: {
      subscriptionId: subscription.id,
      model,
      priceCents,
      stripeSubscriptionItemId: item.id,
    },
  });
}

// Removes one previously-added model add-on — cancels its Stripe
// SubscriptionItem (Stripe prorates the refund/credit for the unused
// remainder automatically) and deletes the matching ModelAddon row. Throws
// if this account never had that add-on.
export async function removeModelAddon(subscriptionId: string, model: string): Promise<void> {
  const addon = await prisma.modelAddon.findUnique({
    where: { subscriptionId_model: { subscriptionId, model } },
  });
  if (!addon) {
    throw new Error(`${model} isn't currently added to your plan.`);
  }

  await stripe.subscriptionItems.del(addon.stripeSubscriptionItemId);
  await prisma.modelAddon.delete({ where: { id: addon.id } });
}
