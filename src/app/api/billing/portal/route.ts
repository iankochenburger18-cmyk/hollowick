import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

// Starts a Stripe Billing Portal session for an account that already has an
// active paid subscription — this is how they cancel, or switch to a
// different tier, rather than through /api/billing/checkout (which always
// starts a brand-new subscription, and would create a duplicate one for
// someone who already has an active plan). See GET /api/billing/status,
// which is what tells the frontend whether a given account should be routed
// here instead of to Checkout.
//
// One-time setup this depends on: Stripe Dashboard → Settings → Billing →
// Customer portal needs the four plan Prices added as subscription options
// (and cancellation enabled) for customers to actually see anything useful
// once they land here — otherwise the portal opens to a bare, mostly-empty
// page.
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const subscription = await prisma.subscription.findUnique({
    where: { userId: session.user.id },
  });
  if (!subscription?.stripeCustomerId) {
    return NextResponse.json(
      { error: "No billing account on file for this account yet." },
      { status: 404 }
    );
  }

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  let portalSession;
  try {
    portalSession = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: `${appUrl}/dashboard`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stripe billing portal failed to start.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  return NextResponse.json({ url: portalSession.url });
}
