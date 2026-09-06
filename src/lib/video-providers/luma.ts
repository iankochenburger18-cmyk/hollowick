import type { VideoGenerateParams, VideoGenerateResult, VideoProvider, VideoStatusResult } from "./types";
import { VideoProviderError } from "./types";

// Luma Agents API — https://docs.agents.lumalabs.ai
// (api.lumalabs.ai/dream-machine is a legacy host that returns a blanket "Not
// authenticated" 403 for this account regardless of key validity — confirmed
// live against the account's own dashboard-provided snippet.)
const LUMA_API_BASE = "https://agents.lumalabs.ai/v1";
const LUMA_VIDEO_MODEL = "ray-3.2";
const DEFAULT_RESOLUTION = "540p";
const DEFAULT_DURATION = "5s";

interface LumaGenerationResponse {
  id: string;
  state: string;
  failure_reason?: string | null;
  failure_code?: string | null;
  output?: Array<{ type: string; url?: string }> | null;
}

function requireApiKey(): string {
  const apiKey = process.env.LUMA_API_KEY;
  if (!apiKey) {
    throw new VideoProviderError(
      "LUMA_API_KEY is not set — add it to the environment before generating with the luma provider",
      "missing_api_key"
    );
  }
  return apiKey;
}

async function lumaRequest(path: string, init: RequestInit): Promise<LumaGenerationResponse> {
  const apiKey = requireApiKey();

  let response: Response;
  try {
    response = await fetch(`${LUMA_API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...init.headers,
      },
    });
  } catch (err) {
    throw new VideoProviderError(
      `Failed to reach Luma API: ${err instanceof Error ? err.message : String(err)}`,
      "network_error"
    );
  }

  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(
      `Luma API rejected the request as unauthorized (HTTP ${response.status}) ${body} — check that LUMA_API_KEY is valid and the account is active/funded`.trim(),
      "auth_error"
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(`Luma API request failed: HTTP ${response.status} ${body}`.trim(), "request_failed");
  }

  return response.json() as Promise<LumaGenerationResponse>;
}

function mapState(state: string): VideoStatusResult["status"] {
  switch (state) {
    case "queued":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      // Covers in-progress states the API may report between queued and
      // completed (observed/documented names vary — treat anything else
      // as still running rather than guessing at an exhaustive enum).
      return "processing";
  }
}

export const lumaProvider: VideoProvider = {
  name: "luma",

  async generate(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    const { prompt, aspectRatio, duration, resolution, ...rest } = params;

    if (!prompt) {
      throw new VideoProviderError("prompt is required", "invalid_params");
    }

    const body = await lumaRequest("/generations", {
      method: "POST",
      body: JSON.stringify({
        model: LUMA_VIDEO_MODEL,
        type: "video",
        prompt,
        aspect_ratio: aspectRatio ?? "16:9",
        video: {
          resolution: typeof resolution === "string" ? resolution : DEFAULT_RESOLUTION,
          duration: duration !== undefined ? (typeof duration === "number" ? `${duration}s` : duration) : DEFAULT_DURATION,
        },
        ...rest,
      }),
    });

    return { jobId: body.id };
  },

  async getStatus(jobId: string): Promise<VideoStatusResult> {
    const body = await lumaRequest(`/generations/${jobId}`, { method: "GET" });
    const status = mapState(body.state);

    if (status === "failed") {
      return {
        status,
        error: body.failure_reason ?? "Luma reported a generation failure with no reason given",
      };
    }

    if (status === "completed") {
      const video = body.output?.find((asset) => asset.type === "video");
      return { status, videoUrl: video?.url ?? undefined };
    }

    return { status };
  },
};
