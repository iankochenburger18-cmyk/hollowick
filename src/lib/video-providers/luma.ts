import type { VideoGenerateParams, VideoGenerateResult, VideoProvider, VideoStatusResult } from "./types";
import { VideoProviderError } from "./types";

// Luma Dream Machine API — https://docs.lumalabs.ai/docs/api
const LUMA_API_BASE = "https://api.lumalabs.ai/dream-machine/v1";

type LumaGenerationState = "queued" | "dreaming" | "completed" | "failed";

interface LumaGenerationResponse {
  id: string;
  state: LumaGenerationState;
  failure_reason?: string | null;
  assets?: { video?: string } | null;
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

function mapState(state: LumaGenerationState): VideoStatusResult["status"] {
  switch (state) {
    case "queued":
      return "pending";
    case "dreaming":
      return "processing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "processing";
  }
}

export const lumaProvider: VideoProvider = {
  name: "luma",

  async generate(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    const { prompt, aspectRatio, duration, ...rest } = params;

    if (!prompt) {
      throw new VideoProviderError("prompt is required", "invalid_params");
    }

    const body = await lumaRequest("/generations", {
      method: "POST",
      body: JSON.stringify({
        prompt,
        aspect_ratio: aspectRatio ?? "16:9",
        ...(duration !== undefined ? { duration: typeof duration === "number" ? `${duration}s` : duration } : {}),
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
      return { status, videoUrl: body.assets?.video ?? undefined };
    }

    return { status };
  },
};
