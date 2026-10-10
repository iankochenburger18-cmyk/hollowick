import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generationQueue } from "@/lib/queue";
import { getVideoProvider, resolveProviderName, VideoProviderError } from "@/lib/video-providers";
import { PLAN_CONFIG, computeCurrentPeriod, creditCostForModel, hasActiveAccess, isModelAllowed, type PlanTierName } from "@/lib/plans";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : null;
  const model = typeof body?.model === "string" ? body.model : null;
  // `provider` is kept as a back-compat/manual-override escape hatch — the
  // studio UI sends `model` (the dropdown label) and lets MODEL_TO_PROVIDER
  // resolve which adapter actually serves it.
  const explicitProvider = typeof body?.provider === "string" ? body.provider : null;
  const providerName = resolveProviderName(model, explicitProvider);
  const duration = typeof body?.duration === "number" ? body.duration : undefined;
  const aspectRatio = typeof body?.aspectRatio === "string" ? body.aspectRatio : undefined;
  // Only used by reference-driven models like Genjutsu (see MODEL_TO_PROVIDER
  // and higgsfield.ts) — ignored by every other provider's generate().
  const videoUrl = typeof body?.videoUrl === "string" ? body.videoUrl : undefined;
  const imageUrls = Array.isArray(body?.imageUrls)
    ? body.imageUrls.filter((url: unknown): url is string => typeof url === "string" && url.length > 0)
    : undefined;
  // Singular reference image, only used by image-to-video models like
  // Kling 2.5 (see MODEL_TO_PROVIDER and higgsfield.ts) — ignored otherwise.
  const imageUrl = typeof body?.imageUrl === "string" ? body.imageUrl : undefined;
  const resolution = typeof body?.resolution === "string" ? body.resolution : undefined;

  if (!prompt) {
    return NextResponse.json({ error: "prompt is required." }, { status: 400 });
  }

  // --- Plan gating: which models this account can use, and whether it has
  // enough credits left this period. Every billable generation must go
  // through a recognized model name (MODEL_CREDIT_COST) — the bare
  // `provider` override still resolves an adapter above for back-compat,
  // but it can't be charged or plan-checked, so it's rejected here.
  const subscription = await prisma.subscription.findUnique({
    where: { userId: session.user.id },
  });
  if (!subscription) {
    return NextResponse.json(
      { error: "No plan found for this account. Contact support to get a plan assigned." },
      { status: 403 }
    );
  }

  const tier = subscription.planTier as PlanTierName;
  const plan = PLAN_CONFIG[tier];
  const period = computeCurrentPeriod(tier, subscription.currentPeriodStart);

  // Blocks an expired trial same as before, and now also blocks a paid tier
  // whose Stripe subscription has lapsed (payment failed, cancelled, etc.)
  // — see hasActiveAccess() in src/lib/plans.ts for exactly which statuses
  // count as "active".
  if (!hasActiveAccess(tier, subscription.status, period)) {
    const message =
      tier === "TRIAL"
        ? "Your 7-day free trial has ended. Pick a plan to keep generating."
        : "Your subscription isn't active. Update your billing to keep generating.";
    return NextResponse.json({ error: message }, { status: 402 });
  }

  if (!model || !isModelAllowed(tier, model)) {
    return NextResponse.json(
      { error: `Your plan (${plan.label}) doesn't include this model.` },
      { status: 403 }
    );
  }

  const creditCost = creditCostForModel(model);
  if (creditCost === null) {
    return NextResponse.json({ error: "Unknown model." }, { status: 400 });
  }

  // Lazy monthly rollover for paid tiers — persist the advanced window the
  // first time a request lands after it elapsed, so Supabase reads (and
  // this same calculation next time) see the up-to-date period.
  if (period.start.getTime() !== subscription.currentPeriodStart.getTime()) {
    await prisma.subscription.update({
      where: { userId: session.user.id },
      data: { currentPeriodStart: period.start, currentPeriodEnd: period.end },
    });
  }

  const usage = await prisma.generationJob.aggregate({
    _sum: { costCents: true },
    where: {
      userId: session.user.id,
      createdAt: { gte: period.start },
      status: { not: "FAILED" },
    },
  });
  const creditsUsed = usage._sum.costCents ?? 0;
  const creditsRemaining = plan.monthlyCredits - creditsUsed;

  if (creditsRemaining < creditCost) {
    return NextResponse.json(
      {
        error: `Not enough credits left this period (${creditsRemaining} remaining, this generation costs ${creditCost}).`,
      },
      { status: 402 }
    );
  }

  let provider;
  try {
    provider = getVideoProvider(providerName);
  } catch (err) {
    const message = err instanceof VideoProviderError ? err.message : "Unknown video provider.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const job = await prisma.generationJob.create({
    data: {
      userId: session.user.id,
      provider: providerName,
      prompt,
      status: "QUEUED",
      costCents: creditCost,
    },
  });

  try {
    const { jobId: providerJobId } = await provider.generate({ prompt, duration, aspectRatio, videoUrl, imageUrls, imageUrl, resolution });

    await prisma.generationJob.update({
      where: { id: job.id },
      data: { providerJobId },
    });

    await generationQueue.add(
      "poll",
      { jobId: job.id },
      { attempts: 1, removeOnComplete: true, removeOnFail: false }
    );

    return NextResponse.json({ id: job.id, status: "QUEUED" }, { status: 201 });
  } catch (err) {
    const message =
      err instanceof VideoProviderError
        ? err.message
        : `Failed to start generation: ${err instanceof Error ? err.message : String(err)}`;

    await prisma.generationJob.update({
      where: { id: job.id },
      data: { status: "FAILED", error: message },
    });

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
