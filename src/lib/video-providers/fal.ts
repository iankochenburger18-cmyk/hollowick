import type { VideoGenerateParams, VideoGenerateResult, VideoProvider, VideoStatusResult } from "./types";
import { VideoProviderError } from "./types";

// fal.ai — a single aggregator API in front of many vendors' video models
// (Kling, Seedance, PixVerse, Wan, and others), so ONE adapter here can back
// several entries in the provider registry — see FAL_MODEL_IDS below and
// registerFalModels() in index.ts.
//
// The queue protocol itself (submit → status → result) is fal's stable,
// documented REST shape: https://docs.fal.ai. The exact model id string for
// any given model (the "fal-ai/..." path fal calls an "endpoint id") is NOT
// guessed here — copy it from the "API" tab on that model's own page at
// https://fal.ai/models, e.g. fal.ai/models/fal-ai/veo3.1, and add it to
// FAL_MODEL_IDS below. Model ids change as fal ships new versions, so treat
// this map as something you maintain, not a fixed list.
const FAL_QUEUE_BASE = "https://queue.fal.run";

export const FAL_MODEL_IDS: Record<string, string> = {
  // Fill in with real endpoint ids from fal.ai's dashboard, e.g.:
  // "fal-seedance": "fal-ai/bytedance/seedance/v2/text-to-video",
  // "fal-pixverse": "fal-ai/pixverse/v5/text-to-video",
  // "fal-wan": "fal-ai/wan/v3/text-to-video",
};

interface FalQueueSubmitResponse {
  request_id: string;
  status_url?: string;
  response_url?: string;
}

interface FalQueueStatusResponse {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | string;
  response_url?: string;
}

interface FalResultResponse {
  video?: { url?: string };
  error?: string;
}

function requireApiKey(): string {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) {
    throw new VideoProviderError(
      "FAL_API_KEY is not set — add it to the environment before generating with any fal-* provider",
      "missing_api_key"
    );
  }
  return apiKey;
}

async function falRequest<T>(url: string, init: RequestInit): Promise<T> {
  const apiKey = requireApiKey();

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${apiKey}`,
        ...init.headers,
      },
    });
  } catch (err) {
    throw new VideoProviderError(`Failed to reach fal.ai: ${err instanceof Error ? err.message : String(err)}`, "network_error");
  }

  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(
      `fal.ai rejected the request as unauthorized (HTTP ${response.status}) ${body} — check that FAL_API_KEY is valid`.trim(),
      "auth_error"
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(`fal.ai request failed: HTTP ${response.status} ${body}`.trim(), "request_failed");
  }

  return response.json() as Promise<T>;
}

/**
 * Builds a VideoProvider backed by one fal.ai model endpoint. Register the
 * result under whatever key you like in the provider registry (index.ts) —
 * that key is what /api/generate's model→provider map should point at.
 */
export function createFalProvider(name: string, endpointId: string): VideoProvider {
  return {
    name,

    async generate(params: VideoGenerateParams): Promise<VideoGenerateResult> {
      const { prompt, aspectRatio, duration } = params;

      if (!prompt) {
        throw new VideoProviderError("prompt is required", "invalid_params");
      }

      const body = await falRequest<FalQueueSubmitResponse>(`${FAL_QUEUE_BASE}/${endpointId}`, {
        method: "POST",
        body: JSON.stringify({
          prompt,
          aspect_ratio: aspectRatio,
          duration,
        }),
      });

      if (!body.request_id) {
        throw new VideoProviderError(`fal.ai did not return a request_id for ${endpointId}`, "request_failed");
      }

      return { jobId: body.request_id };
    },

    async getStatus(jobId: string): Promise<VideoStatusResult> {
      const statusBody = await falRequest<FalQueueStatusResponse>(
        `${FAL_QUEUE_BASE}/${endpointId}/requests/${jobId}/status`,
        { method: "GET" }
      );

      if (statusBody.status === "IN_QUEUE") return { status: "pending" };
      if (statusBody.status === "IN_PROGRESS") return { status: "processing" };

      if (statusBody.status !== "COMPLETED") {
        // fal surfaces failures as a non-2xx from the status/result call in
        // most cases, so an unrecognized status here is unexpected rather
        // than a documented "failed" state — surface it rather than hide it.
        return { status: "failed", error: `fal.ai returned an unrecognized status: ${statusBody.status}` };
      }

      const resultBody = await falRequest<FalResultResponse>(`${FAL_QUEUE_BASE}/${endpointId}/requests/${jobId}`, {
        method: "GET",
      });

      if (resultBody.error) {
        return { status: "failed", error: resultBody.error };
      }

      if (!resultBody.video?.url) {
        return { status: "failed", error: "fal.ai reported completion but returned no video URL" };
      }

      return { status: "completed", videoUrl: resultBody.video.url };
    },
  };
}

/** Builds one VideoProvider per entry in FAL_MODEL_IDS, keyed by the same name. */
export function falModelProviders(): Record<string, VideoProvider> {
  return Object.fromEntries(
    Object.entries(FAL_MODEL_IDS).map(([name, endpointId]) => [name, createFalProvider(name, endpointId)])
  );
}
