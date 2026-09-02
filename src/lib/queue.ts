import { Queue } from "bullmq";
import IORedis from "ioredis";

const globalForQueue = globalThis as unknown as {
  redisConnection: IORedis | undefined;
  generationQueue: Queue | undefined;
};

const connection =
  globalForQueue.redisConnection ??
  new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });

export const GENERATION_QUEUE_NAME = "generation-jobs";

export const generationQueue =
  globalForQueue.generationQueue ?? new Queue(GENERATION_QUEUE_NAME, { connection });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.redisConnection = connection;
  globalForQueue.generationQueue = generationQueue;
}

export interface GenerationJobData {
  jobId: string;
}
