import { Worker } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "@/lib/prisma";
import { uploadVideoFromUrl } from "@/lib/storage";
import { GENERATION_QUEUE_NAME, type GenerationJobData } from "@/lib/queue";
import { getVideoProvider, VideoProviderError } from "@/lib/video-providers";
import { lifecycleEmailQueue, LIFECYCLE_EMAIL_QUEUE_NAME } from "@/lib/lifecycle-queue";
import { scanAndSendLifecycleEmails } from "@/worker/lifecycle-emails";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 30 * 60 * 1000; // 30 minutes

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// AWS SDK v3 errors against non-AWS S3-compatible endpoints often carry a
// useless generic .message (e.g. "UnknownError") while .name has the real
// code (e.g. "InvalidAccessKeyId") — surface both when they differ.
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== "Error" ? err.name : null;
    return name && name !== err.message ? `${name}: ${err.message}` : err.message;
  }
  return String(err);
}

async function failJob(jobId: string, error: string) {
  await prisma.generationJob.update({
    where: { id: jobId },
    data: { status: "FAILED", error },
  });
}

const worker = new Worker<GenerationJobData>(
  GENERATION_QUEUE_NAME,
  async (job) => {
    const { jobId } = job.data;

    const record = await prisma.generationJob.findUnique({ where: { id: jobId } });
    if (!record) {
      console.error(`worker: generation job ${jobId} not found in DB, skipping`);
      return;
    }

    if (!record.provider || !record.providerJobId) {
      await failJob(jobId, "Job is missing provider or providerJobId — cannot poll for status.");
      return;
    }

    let provider;
    try {
      provider = getVideoProvider(record.provider);
    } catch (err) {
      await failJob(jobId, err instanceof VideoProviderError ? err.message : "Unknown video provider.");
      return;
    }

    await prisma.generationJob.update({ where: { id: jobId }, data: { status: "RUNNING" } });

    const deadline = Date.now() + MAX_POLL_DURATION_MS;

    while (true) {
      let result;
      try {
        result = await provider.getStatus(record.providerJobId);
      } catch (err) {
        const message =
          err instanceof VideoProviderError ? err.message : `Provider status check failed: ${describeError(err)}`;
        await failJob(jobId, message);
        return;
      }

      if (result.status === "failed") {
        await failJob(jobId, result.error ?? "Provider reported generation failure with no reason given.");
        return;
      }

      if (result.status === "completed") {
        if (!result.videoUrl) {
          await failJob(jobId, "Provider reported completion but returned no video URL.");
          return;
        }

        try {
          const storedUrl = await uploadVideoFromUrl(result.videoUrl, `videos/${jobId}.mp4`);
          await prisma.generationJob.update({
            where: { id: jobId },
            data: { status: "COMPLETED", resultUrl: storedUrl },
          });
        } catch (err) {
          await failJob(jobId, `Generation succeeded but upload to storage failed: ${describeError(err)}`);
        }
        return;
      }

      if (Date.now() > deadline) {
        await failJob(jobId, `Timed out waiting for provider to finish generation after ${MAX_POLL_DURATION_MS / 1000}s.`);
        return;
      }

      await sleep(POLL_INTERVAL_MS);
    }
  },
  { connection }
);

worker.on("ready", () => {
  console.log("worker: connected to redis, waiting for jobs");
});

worker.on("error", (err) => {
  console.error("worker error:", err);
});

worker.on("failed", (job, err) => {
  console.error(`worker: job ${job?.id} failed:`, err);
});

// Trial lifecycle emails ("your trial ends in 2 days" / "your trial has
// ended") — a second, independent Worker on its own queue, processing one
// scan job an hour (see src/worker/lifecycle-emails.ts for the actual
// logic). Sharing this process's redis `connection` across both Workers is
// the normal BullMQ pattern — each duplicates it internally as needed for
// blocking ops, rather than this process opening a second real connection.
const lifecycleWorker = new Worker(
  LIFECYCLE_EMAIL_QUEUE_NAME,
  async () => {
    await scanAndSendLifecycleEmails();
  },
  { connection }
);

lifecycleWorker.on("error", (err) => {
  console.error("lifecycle-emails worker error:", err);
});

lifecycleWorker.on("failed", (job, err) => {
  console.error(`lifecycle-emails: scan job ${job?.id} failed:`, err);
});

// upsertJobScheduler is idempotent by its given id — safe to call every
// time this process starts (every deploy, every container restart) without
// piling up duplicate hourly schedules or duplicate repeat jobs.
lifecycleEmailQueue
  .upsertJobScheduler("hourly-lifecycle-email-scan", { every: 60 * 60 * 1000 }, { name: "scan" })
  .then(() => console.log("worker: hourly lifecycle-email scan scheduled"))
  .catch((err) => {
    console.error("lifecycle-emails: failed to schedule hourly scan:", err);
  });
