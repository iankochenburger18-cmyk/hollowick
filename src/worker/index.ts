import { Worker } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  "generation-jobs",
  async () => {
    // No provider adapters yet — jobs aren't dispatched to this queue until Phase 3.
  },
  { connection }
);

worker.on("ready", () => {
  console.log("worker: connected to redis, waiting for jobs");
});

worker.on("error", (err) => {
  console.error("worker error:", err);
});
