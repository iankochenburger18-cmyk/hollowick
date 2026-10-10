import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe, syncSubscriptionFromStripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";

// Stripe calls this every time something happens to a Checkout Session or
// Subscription in our account. Configure this URL (https://hollowick.app/api/
// billing/webhook) under Stripe Dashboard → Developers → Webhooks, and copy
// the signing secret it gives you into STRIPE_WEBHOOK_SECRET.
export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });
  }

  // Signature verification needs the exact raw bytes Stripe sent — reading
  // this as request.json() first (which reparses/reserializes) would break
  // the signature check, so read it as text and let Stripe's SDK parse it.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  switch (event.type) {
    // First payment on a brand-new subscription. The Checkout Session
    // itself doesn't carry the billing-period fields we need, so fetch the
    // actual Subscription object Stripe just created and sync from that.
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (!session.subscription) {
        console.error(`checkout.session.completed ${session.id} has no subscription attached.`);
        break;
      }
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : session.subscription.id;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await syncSubscriptionFromStripe(subscription, session.metadata?.userId ?? undefined);
      break;
    }

    // Covers renewals, upgrades/downgrades (plan tier or price changes),
    // and a `cancel_at_period_end` toggle — Stripe sends this for all of
    // them, and syncSubscriptionFromStripe handles them identically by just
    // re-reading the subscription's current state.
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      await syncSubscriptionFromStripe(subscription);
      break;
    }

    // The subscription actually ended (immediately, or at the end of a
    // cancel_at_period_end period). Keep planTier as the last-known paid
    // tier — admin_user_insights and firstPaidAt both rely on it staying
    // put — but flip status so hasActiveAccess() (src/lib/plans.ts) blocks
    // new generations.
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const existing = await prisma.subscription.findFirst({
        where: { stripeSubscriptionId: subscription.id },
      });
      if (existing) {
        await prisma.subscription.update({
          where: { userId: existing.userId },
          data: { status: "canceled" },
        });
      } else {
        console.error(
          `customer.subscription.deleted for ${subscription.id}, but no Subscription row references it.`
        );
      }
      break;
    }

    default:
      // Stripe sends many more event types than we act on (invoice.*,
      // payment_intent.*, etc.) — anything not handled above is expected
      // and intentionally ignored.
      break;
  }

  return NextResponse.json({ received: true });
}
