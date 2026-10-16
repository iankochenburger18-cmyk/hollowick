import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getOrCreateSubscription } from "@/lib/subscription";
import { addModelAddon, removeModelAddon } from "@/lib/model-addons";
import { upgradeableModelsForTier, addonPriceForModel, type PlanTierName } from "@/lib/plans";

// Lets the pricing page (hollowick-site's pricing.js) show a signed-in
// account which models aren't included in their current plan tier, what
// each one costs to add individually, and which ones they've already
// added — see src/lib/model-addons.ts and MODEL_ADDON_PRICE_CENTS in
// src/lib/plans.ts for the pricing/mechanics behind this.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const subscription = await getOrCreateSubscription(session.user.id);
  const tier = subscription.planTier as PlanTierName;
  const addedModels = new Set(subscription.modelAddons.map((addon: { model: string }) => addon.model));

  // Naturally empty for STUDIO (already has every model) and for TRIAL
  // (same, for the length of the trial) — nothing for the pricing page to
  // offer in either case.
  const addons = upgradeableModelsForTier(tier).map((model) => ({
    model,
    priceCents: addonPriceForModel(model),
    active: addedModels.has(model),
  }));

  return NextResponse.json({ tier, addons });
}

// Adds one model to the signed-in account's plan as a recurring monthly
// add-on, billed on their existing Stripe subscription (see addModelAddon
// in src/lib/model-addons.ts for the Stripe mechanics and all of the
// pre-conditions it enforces — no active subscription, model not
// add-on-eligible, already added, etc. all surface here as 400s with that
// function's own message).
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const model = typeof body?.model === "string" ? body.model : null;
  if (!model) {
    return NextResponse.json({ error: "model is required." }, { status: 400 });
  }

  const subscription = await getOrCreateSubscription(session.user.id);

  // Buying access to a model the plan already includes is just confused,
  // not a real purchase — reject before ever touching Stripe.
  if (upgradeableModelsForTier(subscription.planTier as PlanTierName).includes(model) === false) {
    return NextResponse.json(
      { error: `"${model}" isn't available to add — it's either already included in your plan, or not a real model.` },
      { status: 400 }
    );
  }

  try {
    await addModelAddon(subscription, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not add that model.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, model }, { status: 201 });
}

// Removes a previously-added model add-on — cancels its Stripe
// SubscriptionItem (Stripe prorates automatically) and the matching
// ModelAddon row.
export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const model = typeof body?.model === "string" ? body.model : null;
  if (!model) {
    return NextResponse.json({ error: "model is required." }, { status: 400 });
  }

  const subscription = await getOrCreateSubscription(session.user.id);

  try {
    await removeModelAddon(subscription.id, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not remove that model.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, model });
}
