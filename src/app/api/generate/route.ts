import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generationQueue } from "@/lib/queue";
import { getVideoProvider, resolveProviderName, VideoProviderError } from "@/lib/video-providers";

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
