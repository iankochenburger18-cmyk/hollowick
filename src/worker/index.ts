import { Worker } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "@/lib/prisma";
import { uploadVideoFromUrl } from "@/lib/storage";
import { GENERATION_QUEUE_NAME, type GenerationJobData } from "@/lib/queue";
import { getVideoProvider, VideoProviderError } from "@/lib/video-providers";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 30 * 60 * 1000; // 30 minutes

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          err instanceof VideoProviderError
            ? err.message
            : `Provider status check failed: ${err instanceof Error ? err.message : String(err)}`;
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
          await failJob(
            jobId,
            `Generation succeeded but upload to storage failed: ${err instanceof Error ? err.message : String(err)}`
          );
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
