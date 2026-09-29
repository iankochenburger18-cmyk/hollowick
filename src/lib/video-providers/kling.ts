import { createHmac } from "node:crypto";
import type { VideoGenerateParams, VideoGenerateResult, VideoProvider, VideoStatusResult } from "./types";
import { VideoProviderError } from "./types";

// Kling AI (Kuaishou) open platform — https://kling.ai/dev
//
// Kling actually supports two auth methods, and which one your dashboard
// hands you appears to depend on when/where you signed up:
//   - KLING_API_KEY: a single key sent as a plain bearer token. This is what
//     kling.ai/dev/api-key issues by default now — most new accounts will
//     only have this.
//   - KLING_ACCESS_KEY + KLING_SECRET_KEY: an older key-pair scheme where
//     each request is authenticated with a short-lived JWT signed using the
//     secret key. Kept here for accounts that were issued this style.
// If KLING_API_KEY is set, it's used as-is. Otherwise we fall back to
// signing a JWT from the access/secret pair. Endpoint paths and payload
// shape below follow Kling's publicly documented text-to-video flow as of
// this writing — verify against https://kling.ai/document-api before
// relying on this in production, since Kling's API has changed shape before.
const KLING_API_BASE = "https://api.klingai.com";
const KLING_MODEL = "kling-v3";
const JWT_TTL_SECONDS = 1800;

interface KlingTaskResponse {
  code: number;
  message?: string;
  data?: {
    task_id?: string;
    task_status?: string;
    task_status_msg?: string;
    task_result?: {
      videos?: Array<{ id: string; url: string; duration?: string }>;
    };
  };
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createKlingJwt(accessKey: string, secretKey: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { iss: accessKey, exp: nowSeconds + JWT_TTL_SECONDS, nbf: nowSeconds - 5 };

  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64url(Buffer.from(JSON.stringify(payload)));
  const signature = base64url(createHmac("sha256", secretKey).update(`${encodedHeader}.${encodedPayload}`).digest());

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/** Resolves whichever credential style is configured into a ready-to-send bearer token. */
function resolveAuthToken(): string {
  const apiKey = process.env.KLING_API_KEY;
  if (apiKey) return apiKey;

  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  if (accessKey && secretKey) return createKlingJwt(accessKey, secretKey);

  throw new VideoProviderError(
    "No Kling credentials set — set KLING_API_KEY (most accounts), or KLING_ACCESS_KEY + KLING_SECRET_KEY (older key-pair accounts)",
    "missing_api_key"
  );
}

async function klingRequest(path: string, init: RequestInit): Promise<KlingTaskResponse> {
  const token = resolveAuthToken();

  let response: Response;
  try {
    response = await fetch(`${KLING_API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
  } catch (err) {
    throw new VideoProviderError(
      `Failed to reach the Kling API: ${err instanceof Error ? err.message : String(err)}`,
      "network_error"
    );
  }

  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(
      `Kling API rejected the request as unauthorized (HTTP ${response.status}) ${body} — check KLING_API_KEY (or KLING_ACCESS_KEY/KLING_SECRET_KEY) and that the account is funded`.trim(),
      "auth_error"
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(`Kling API request failed: HTTP ${response.status} ${body}`.trim(), "request_failed");
  }

  const body = (await response.json()) as KlingTaskResponse;
  if (body.code && body.code !== 0) {
    throw new VideoProviderError(`Kling API returned an error: ${body.message ?? `code ${body.code}`}`, "request_failed");
  }

  return body;
}

function mapTaskStatus(status: string | undefined): VideoStatusResult["status"] {
  switch (status) {
    case "submitted":
      return "pending";
    case "processing":
      return "processing";
    case "succeed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "processing";
  }
}

export const klingProvider: VideoProvider = {
  name: "kling",

  async generate(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    const { prompt, aspectRatio, duration } = params;

    if (!prompt) {
      throw new VideoProviderError("prompt is required", "invalid_params");
    }

    const body = await klingRequest("/v1/videos/text2video", {
      method: "POST",
      body: JSON.stringify({
        model_name: KLING_MODEL,
        prompt,
        aspect_ratio: aspectRatio ?? "16:9",
        duration: duration ? String(duration) : "5",
      }),
    });

    const taskId = body.data?.task_id;
    if (!taskId) {
      throw new VideoProviderError("Kling API did not return a task_id for this generation", "request_failed");
    }

    return { jobId: taskId };
  },

  async getStatus(jobId: string): Promise<VideoStatusResult> {
    const body = await klingRequest(`/v1/videos/text2video/${jobId}`, { method: "GET" });
    const status = mapTaskStatus(body.data?.task_status);

    if (status === "failed") {
      return { status, error: body.data?.task_status_msg ?? "Kling reported a generation failure with no reason given" };
    }

    if (status === "completed") {
      const video = body.data?.task_result?.videos?.[0];
      return { status, videoUrl: video?.url };
    }

    return { status };
  },
};
