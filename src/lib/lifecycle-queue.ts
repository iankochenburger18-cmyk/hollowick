import { Queue } from "bullmq";
import IORedis from "ioredis";

// Separate queue from src/lib/queue.ts (generation jobs) — this one only
// ever holds the hourly trial-lifecycle-email scan (see
// src/worker/lifecycle-emails.ts), so it's never touched by any HTTP route,
// only scheduled and processed by the worker process itself
// (src/worker/index.ts).
const globalForQueue = globalThis as unknown as {
  lifecycleRedisConnection: IORedis | undefined;
  lifecycleEmailQueue: Queue | undefined;
};

const connection =
  globalForQueue.lifecycleRedisConnection ??
  new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });

export const LIFECYCLE_EMAIL_QUEUE_NAME = "lifecycle-emails";

export const lifecycleEmailQueue =
  globalForQueue.lifecycleEmailQueue ?? new Queue(LIFECYCLE_EMAIL_QUEUE_NAME, { connection });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.lifecycleRedisConnection = connection;
  globalForQueue.lifecycleEmailQueue = lifecycleEmailQueue;
}
