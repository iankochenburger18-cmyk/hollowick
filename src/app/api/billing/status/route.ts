import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrCreateSubscription } from "@/lib/subscription";
import { PLAN_CONFIG, computeCurrentPeriod, hasActiveAccess, type PlanTierName } from "@/lib/plans";

// Lets the separate static frontend (hollowick-site, on Vercel) know who's
// signed in and what plan they're on, so pricing/index.html can decide what
// each plan card's button should do and say: "sign in first" (no session),
// "choose this plan" via Checkout (TRIAL, or a paid plan that's lapsed), or
// "cancel"/"switch" via the Billing Portal (an active paid plan) — see
// src/app/api/billing/portal/route.ts for the last one.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ signedIn: false });
  }

  const [subscription, user] = await Promise.all([
    getOrCreateSubscription(session.user.id),
    // Only emailVerifiedAt is needed here — the session JWT already carries
    // id/email, and this keeps the query from pulling the passwordHash etc.
    prisma.user.findUnique({ where: { id: session.user.id }, select: { emailVerifiedAt: true } }),
  ]);
  const tier = subscription.planTier as PlanTierName;
  const period = computeCurrentPeriod(tier, subscription.currentPeriodStart);
  const active = hasActiveAccess(tier, subscription.status, period);

  return NextResponse.json({
    signedIn: true,
    email: session.user.email,
    // Drives the studio's "confirm your email" nudge (src/studio.js) — see
    // the AskUserQuestion decision this feature was built around: unverified
    // accounts keep full access, this is a nudge only, never a gate.
    emailVerified: Boolean(user?.emailVerifiedAt),
    tier,
    label: PLAN_CONFIG[tier].label,
    // Whether this account currently has working access on that tier — a
    // trial that hasn't expired, or a paid plan Stripe still reports as
    // active/trialing. Combined with isPaidTier below, the frontend uses
    // these two together: TRIAL (active or not) or a lapsed paid plan
    // (isPaidTier && !active) both mean "send them to Checkout — there's no
    // live subscription to manage, only one to start." An active paid plan
    // (isPaidTier && active) means "send them to the Billing Portal instead
    // — a second Checkout session would create a duplicate subscription."
    active,
    isPaidTier: tier !== "TRIAL",
    // Models unlocked individually on top of this plan — see
    // src/lib/model-addons.ts. Used by pricing.js to mark which of the
    // upgradeable models (GET /api/billing/addons) are already added.
    modelAddons: subscription.modelAddons.map((addon: { model: string }) => addon.model),
  });
}
