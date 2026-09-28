import type { VideoGenerateParams, VideoGenerateResult, VideoProvider, VideoStatusResult } from "./types";
import { VideoProviderError } from "./types";

// Runway's developer API — https://docs.dev.runwayml.com
// Separate product from the consumer app (different billing: prepaid
// credits, not the app's subscription). The API is date-versioned via the
// X-Runway-Version header; Runway has changed both the version string and
// available models before, so confirm both against the docs above before
// relying on this in production.
const RUNWAY_API_BASE = "https://api.dev.runwayml.com/v1";
const RUNWAY_API_VERSION = "2024-11-06";
const RUNWAY_MODEL = "gen4.5";

interface RunwayTaskResponse {
  id: string;
  status?: string;
  output?: string[];
  failure?: string;
  failureCode?: string;
}

function requireApiKey(): string {
  const apiKey = process.env.RUNWAY_API_KEY;
  if (!apiKey) {
    throw new VideoProviderError(
      "RUNWAY_API_KEY is not set — add it to the environment before generating with the runway provider",
      "missing_api_key"
    );
  }
  return apiKey;
}

async function runwayRequest(path: string, init: RequestInit): Promise<RunwayTaskResponse> {
  const apiKey = requireApiKey();

  let response: Response;
  try {
    response = await fetch(`${RUNWAY_API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Runway-Version": RUNWAY_API_VERSION,
        ...init.headers,
      },
    });
  } catch (err) {
    throw new VideoProviderError(
      `Failed to reach the Runway API: ${err instanceof Error ? err.message : String(err)}`,
      "network_error"
    );
  }

  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(
      `Runway API rejected the request as unauthorized (HTTP ${response.status}) ${body} — check that RUNWAY_API_KEY is valid and the account has credits`.trim(),
      "auth_error"
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(`Runway API request failed: HTTP ${response.status} ${body}`.trim(), "request_failed");
  }

  return response.json() as Promise<RunwayTaskResponse>;
}

function mapStatus(status: string | undefined): VideoStatusResult["status"] {
  switch (status) {
    case "PENDING":
      return "pending";
    case "RUNNING":
      return "processing";
    case "SUCCEEDED":
      return "completed";
    case "FAILED":
    case "CANCELLED":
      return "failed";
    default:
      return "processing";
  }
}

export const runwayProvider: VideoProvider = {
  name: "runway",

  async generate(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    const { prompt, aspectRatio, duration } = params;

    if (!prompt) {
      throw new VideoProviderError("prompt is required", "invalid_params");
    }

    const body = await runwayRequest("/text_to_video", {
      method: "POST",
      body: JSON.stringify({
        model: RUNWAY_MODEL,
        promptText: prompt,
        ratio: aspectRatio ?? "1280:720",
        duration: duration ?? 5,
      }),
    });

    if (!body.id) {
      throw new VideoProviderError("Runway API did not return a task id for this generation", "request_failed");
    }

    return { jobId: body.id };
  },

  async getStatus(jobId: string): Promise<VideoStatusResult> {
    const body = await runwayRequest(`/tasks/${jobId}`, { method: "GET" });
    const status = mapStatus(body.status);

    if (status === "failed") {
      return { status, error: body.failure ?? body.failureCode ?? "Runway reported a generation failure with no reason given" };
    }

    if (status === "completed") {
      return { status, videoUrl: body.output?.[0] };
    }

    return { status };
  },
};
