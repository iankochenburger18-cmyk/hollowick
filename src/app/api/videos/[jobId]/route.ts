import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getVideoObject } from "@/lib/storage";

// Streams a completed generation's video through our own domain rather than
// pointing the browser straight at the storage provider's own hostname. See
// the comment on getVideoObject() in storage.ts for why: browsers (not
// curl) were getting an outright TLS handshake reset talking directly to
// *.your-objectstorage.com, reproduced across three different TLS stacks on
// two unrelated networks. The key is always `videos/{jobId}.mp4` — that's
// exactly what the worker (src/worker/index.ts) uploaded it under, so this
// needs no new column and works for every already-completed job too.
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated." }, { status: 401 });
  }

  const { jobId } = await params;

  const job = await prisma.generationJob.findUnique({
    where: { id: jobId },
    select: { id: true, userId: true, status: true },
  });

  // Same 404 for "doesn't exist", "isn't yours", and "isn't done yet" —
  // don't leak which one, and the frontend only ever links here once it's
  // already seen status === COMPLETED from /api/generations/[id].
  if (!job || job.userId !== session.user.id || job.status !== "COMPLETED") {
    return Response.json({ error: "Video not found." }, { status: 404 });
  }

  // Passing the browser's own Range header straight through to S3 lets the
  // <video> element seek/scrub without us reimplementing byte-range logic.
  const range = request.headers.get("range") ?? undefined;

  let object;
  try {
    object = await getVideoObject(`videos/${job.id}.mp4`, range);
  } catch (err) {
    console.error(`/api/videos/${job.id}: failed to read video from storage`, err);
    return Response.json({ error: "Could not load this video right now." }, { status: 502 });
  }

  if (!object.body) {
    return Response.json({ error: "Could not load this video right now." }, { status: 502 });
  }

  const headers = new Headers({
    "Content-Type": object.contentType ?? "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  });
  if (object.contentLength !== undefined) headers.set("Content-Length", String(object.contentLength));
  if (object.contentRange) headers.set("Content-Range", object.contentRange);

  return new Response(object.body, { status: object.statusCode, headers });
}
