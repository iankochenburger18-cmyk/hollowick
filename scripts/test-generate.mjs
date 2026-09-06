#!/usr/bin/env node
// End-to-end smoke test for the generate pipeline: signup -> login -> POST /api/generate
// -> poll GenerationJob until COMPLETED/FAILED.
//
// Run from inside the app container, where localhost:3000 is the app itself and
// DATABASE_URL points at the real Postgres service:
//
//   docker compose exec app node scripts/test-generate.mjs
//
// Optional env overrides: TEST_APP_URL (default http://localhost:3000),
// TEST_PROVIDER (default luma), TEST_PROMPT, TEST_POLL_TIMEOUT_MS (default 360000).

import { PrismaClient } from "@prisma/client";

const APP_URL = process.env.TEST_APP_URL ?? "http://localhost:3000";
const PROVIDER = process.env.TEST_PROVIDER ?? "luma";
const PROMPT = process.env.TEST_PROMPT ?? "A calm ocean at sunrise, cinematic drone shot";
const POLL_TIMEOUT_MS = Number(process.env.TEST_POLL_TIMEOUT_MS ?? 6 * 60 * 1000);
const POLL_INTERVAL_MS = 5000;

// Mixed-case on purpose: regression test for the register/authorize email
// case-normalization mismatch (see src/lib/auth.ts).
const TEST_EMAIL = `Test.Generate.${Date.now()}@Hollowick-Test.local`;
const TEST_PASSWORD = "TestPassword123!";

class CookieJar {
  #cookies = new Map();

  capture(response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const pair = raw.split(";", 1)[0];
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      this.#cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
  }

  header() {
    return [...this.#cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

const jar = new CookieJar();

async function request(path, init = {}) {
  const response = await fetch(`${APP_URL}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      ...init.headers,
      Cookie: jar.header(),
    },
  });
  jar.capture(response);
  return response;
}

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

async function main() {
  log("signup", `Registering ${TEST_EMAIL}`);
  const registerRes = await request("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (registerRes.status !== 201) {
    const body = await registerRes.text();
    throw new Error(`Signup failed: HTTP ${registerRes.status} ${body}`);
  }
  log("signup", "OK");

  log("login", "Fetching CSRF token");
  const csrfRes = await request("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  if (!csrfToken) throw new Error("No CSRF token returned from /api/auth/csrf");

  log("login", "Submitting credentials");
  const loginRes = await request("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      csrfToken,
      callbackUrl: APP_URL,
      json: "true",
    }),
  });
  if (loginRes.status >= 400) {
    const body = await loginRes.text();
    throw new Error(`Login request failed: HTTP ${loginRes.status} ${body}`);
  }

  const sessionRes = await request("/api/auth/session");
  const session = await sessionRes.json().catch(() => null);
  if (!session?.user?.email) {
    throw new Error(
      "Login did not establish a session (this is the signup/auto-login bug if it reproduces here)."
    );
  }
  log("login", `OK, session established for ${session.user.email}`);

  log("generate", `Calling POST /api/generate (provider=${PROVIDER})`);
  const genRes = await request("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: PROMPT, provider: PROVIDER }),
  });
  const genBody = await genRes.json().catch(() => ({}));

  if (genRes.status !== 201) {
    console.error(`[generate] FAILED at request time: HTTP ${genRes.status}`, genBody);
    process.exitCode = 1;
    return;
  }

  const jobId = genBody.id;
  log("generate", `Job queued: ${jobId}`);

  const prisma = new PrismaClient();
  try {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let lastStatus = null;

    while (Date.now() < deadline) {
      const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
      if (!job) throw new Error(`GenerationJob ${jobId} disappeared from the DB`);

      if (job.status !== lastStatus) {
        log("poll", `status=${job.status}`);
        lastStatus = job.status;
      }

      if (job.status === "COMPLETED") {
        log("result", `SUCCESS — video stored at: ${job.resultUrl}`);
        return;
      }

      if (job.status === "FAILED") {
        log("result", `FAILED — ${job.error ?? "no error message recorded"}`);
        process.exitCode = 1;
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    log("result", `TIMED OUT after ${POLL_TIMEOUT_MS / 1000}s waiting for job ${jobId} to finish`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Test script error:", err);
  process.exitCode = 1;
});
