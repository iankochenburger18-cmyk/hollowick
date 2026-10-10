import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PLAN_CONFIG, computeCurrentPeriod, hasActiveAccess, type PlanTierName } from "@/lib/plans";
import { PlanCheckoutButton } from "./PlanCheckoutButton";

const PAID_TIERS: PlanTierName[] = ["STARTER", "CREATOR", "PRO", "STUDIO"];

export default async function DashboardPage() {
  const session = await auth();
  if (!session) {
    redirect("/signin");
  }

  const subscription = await prisma.subscription.findUnique({
    where: { userId: session.user.id },
  });

  const tier = (subscription?.planTier ?? "TRIAL") as PlanTierName;
  const plan = PLAN_CONFIG[tier];
  // computeCurrentPeriod is pure (no DB write) — this is a read-only view,
  // so a paid tier whose period technically elapsed since the user's last
  // generation will show last-known figures until their next generate()
  // call rolls it forward for real (see src/app/api/generate/route.ts).
  const period = subscription ? computeCurrentPeriod(tier, subscription.currentPeriodStart) : null;
  const trialExpired = tier === "TRIAL" && Boolean(period?.elapsed);
  const active = period ? hasActiveAccess(tier, subscription?.status ?? null, period) : false;
  // A paid tier whose Stripe subscription was cancelled or lapsed (payment
  // failed, etc.) still shows its last-known plan label — see
  // customer.subscription.deleted in src/app/api/billing/webhook/route.ts —
  // but access itself is blocked until they pick a plan again.
  const subscriptionInactive = tier !== "TRIAL" && !active;

  let creditsUsed = 0;
  if (period && active) {
    const usage = await prisma.generationJob.aggregate({
      _sum: { costCents: true },
      where: {
        userId: session.user.id,
        createdAt: { gte: period.start },
        status: { not: "FAILED" },
      },
    });
    creditsUsed = usage._sum.costCents ?? 0;
  }
  const creditsRemaining = Math.max(plan.monthlyCredits - creditsUsed, 0);

  const showPlanPicker = trialExpired || subscriptionInactive || tier === "TRIAL";

  return (
    <main>
      <h1>Dashboard</h1>
      <p>Signed in as {session.user.email}</p>
      <p>
        Plan: {plan.label}
        {tier === "TRIAL" && !trialExpired ? " (free trial)" : ""}
      </p>
      {trialExpired ? (
        <p>Your free trial has ended. Pick a plan to keep generating.</p>
      ) : subscriptionInactive ? (
        <p>Your subscription isn&apos;t active. Pick a plan below to restore access.</p>
      ) : (
        <>
          <p>
            Generations credits used this period: {creditsUsed} / {plan.monthlyCredits}
          </p>
          <p>Credits remaining: {creditsRemaining}</p>
          {period ? <p>Period ends: {period.end.toLocaleDateString()}</p> : null}
        </>
      )}

      {showPlanPicker ? (
        <section>
          <h2>Choose a plan</h2>
          {PAID_TIERS.map((paidTier) => {
            if (paidTier === tier && active) return null;
            const paidPlan = PLAN_CONFIG[paidTier];
            const priceLabel =
              paidPlan.priceCents !== null ? `$${(paidPlan.priceCents / 100).toFixed(0)}/mo` : "";
            return (
              <PlanCheckoutButton
                key={paidTier}
                tier={paidTier}
                label={`${paidPlan.label}${priceLabel ? ` — ${priceLabel}` : ""}`}
              />
            );
          })}
        </section>
      ) : null}

      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      >
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
