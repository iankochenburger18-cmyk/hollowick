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

// Currency-specific AND price-specific: a Stripe Subscription requires
// every item on it to share one currency, and that currency is set by
// whichever Price the base plan was checked out with (see priceIdForTier in
// stripe.ts — those Prices were created by hand in the Dashboard, not
// pinned to USD here) — it can differ per account. Baking currency into the
// key means an add-on bought by a USD subscription and one bought by a CHF
// subscription never collide on the same Stripe Price (which would either
// crash, like the bug that fixed, or silently charge the wrong amount for
// one of the two).
//
// Price is baked in too, and that part matters for a different reason:
// Stripe Prices are immutable — you can't edit unit_amount on an existing
// one. Without priceCents in the key, changing MODEL_ADDON_PRICE_CENTS in
// plans.ts would silently do nothing for any model that already has an
// active Price under its lookup_key (getOrCreateAddonPrice would just keep
// finding and reusing the old amount forever). With it, a price change in
// plans.ts changes the lookup_key, so it's automatically treated as "no
// Price exists yet" and a fresh one gets created at the new amount — no
// manual archiving in the Stripe Dashboard needed after a repricing. This
// also matches the snapshot-at-purchase-time behavior ModelAddon.priceCents
// already documents in plans.ts: an old Price stays around unused rather
// than disappearing, same as it always has.
function lookupKeyForModel(model: string, currency: string, priceCents: number): string {
  return `model_addon_${slugForModel(model)}_${currency}_${priceCents}`;
}

// Finds the Stripe Price for this model's add-on, in the given currency and
// at its current plans.ts price, if one was already created (by an earlier
// purchase of this same model, in this same currency, at this same price,
// by anyone), or creates it. Using `lookup_key` this way means we never
// need our own table mapping models to Stripe Price IDs — Stripe's
// lookup_key index is that table.
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

  const lookupKey = lookupKeyForModel(model, currency, priceCents);

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

export interface AddModelAddonResult {
  modelAddon: Awaited<ReturnType<typeof prisma.modelAddon.create>>;
  // Both needed by the caller to send the "you just added this" email
  // (src/lib/email.ts's sendModelAddonPurchasedEmail, called from the
  // route) without it having to re-fetch anything from Stripe itself.
  currency: string;
  nextBillingDate: Date;
}

// Adds one model add-on to an account's existing Stripe Subscription and
// records it. Throws (with a message safe to surface to the caller) if the
// account has no live Stripe subscription to attach it to, if the model
// isn't add-on-eligible, or if it's already included in the account's plan
// or already added.
export async function addModelAddon(
  subscription: { id: string; planTier: string; stripeSubscriptionId: string | null },
  model: string
): Promise<AddModelAddonResult> {
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

  const modelAddon = await prisma.modelAddon.create({
    data: {
      subscriptionId: subscription.id,
      model,
      priceCents,
      stripeSubscriptionItemId: item.id,
    },
  });

  // current_period_end lives on the item Stripe just handed back (see the
  // comment on syncSubscriptionFromStripe in stripe.ts) — this is the date
  // the pending proration this add actually created (see getOrCreateAddonPrice's
  // comment above) will get folded into a real invoice and charged, which
  // is exactly what the confirmation email needs to tell the account.
  return { modelAddon, currency, nextBillingDate: new Date(item.current_period_end * 1000) };
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
