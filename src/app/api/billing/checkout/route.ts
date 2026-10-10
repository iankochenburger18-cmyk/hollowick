import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, priceIdForTier, type PaidPlanTier } from "@/lib/stripe";

const PAID_TIERS: PaidPlanTier[] = ["STARTER", "CREATOR", "PRO", "STUDIO"];

function isPaidTier(value: unknown): value is PaidPlanTier {
  return typeof value === "string" && (PAID_TIERS as string[]).includes(value);
}

// Starts a Stripe Checkout session for an existing account to subscribe (or
// switch) to one of the four paid tiers. Returns the session URL for the
// client to redirect to — see PlanCheckoutButton in src/app/dashboard.
// Actually granting access happens later, when Stripe calls our webhook
// (src/app/api/billing/webhook/route.ts) once the payment actually goes
// through — this route only ever starts the purchase.
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const tier = body?.tier;
  if (!isPaidTier(tier)) {
    return NextResponse.json(
      { error: "tier must be one of STARTER, CREATOR, PRO, STUDIO." },
      { status: 400 }
    );
  }

  const subscription = await prisma.subscription.findUnique({
    where: { userId: session.user.id },
  });
  if (!subscription) {
    return NextResponse.json(
      { error: "No plan found for this account. Contact support to get a plan assigned." },
      { status: 403 }
    );
  }

  // Reuse the existing Stripe Customer if this account already has one
  // (e.g. switching plans, or re-subscribing after a cancellation) —
  // otherwise Stripe would end up with a duplicate customer per purchase.
  let customerId = subscription.stripeCustomerId ?? undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: session.user.email,
      metadata: { userId: session.user.id },
    });
    customerId = customer.id;
    await prisma.subscription.update({
      where: { userId: session.user.id },
      data: { stripeCustomerId: customerId },
    });
  }

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  let checkoutSession;
  try {
    checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceIdForTier(tier), quantity: 1 }],
      success_url: `${appUrl}/dashboard?checkout=success`,
      cancel_url: `${appUrl}/dashboard?checkout=cancelled`,
      // Carried onto the Subscription Stripe creates too (subscription_data
      // below), not just the Checkout Session — the webhook's
      // checkout.session.completed handler reads this to know which of our
      // accounts just paid, with no other reliable lookup available yet at
      // that point (see src/lib/stripe.ts's syncSubscriptionFromStripe).
      subscription_data: {
        metadata: { userId: session.user.id },
      },
      metadata: { userId: session.user.id },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stripe checkout failed to start.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (!checkoutSession.url) {
    return NextResponse.json({ error: "Stripe didn't return a checkout URL." }, { status: 502 });
  }

  return NextResponse.json({ url: checkoutSession.url });
}
