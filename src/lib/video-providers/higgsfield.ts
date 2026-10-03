import type { VideoGenerateParams, VideoGenerateResult, VideoProvider, VideoStatusResult } from "./types";
import { VideoProviderError } from "./types";

// Higgsfield — https://higgsfield.ai — runs its own developer API at
// api.higgsfield.ai, separate from fal.ai. One key pair covers every model
// registered in HIGGSFIELD_MODEL_PATHS below (mirrors the fal.ts aggregator
// pattern), so adding another Higgsfield model later is a one-line addition
// here rather than a new file.
//
// Auth and the async submit/poll shape below are Higgsfield's documented
// REST protocol (https://docs.higgsfield.ai/docs) — verify against their
// docs before relying on this in production, since exact fields can change.
const HIGGSFIELD_API_BASE = "https://api.higgsfield.ai";

export const HIGGSFIELD_MODEL_PATHS: Record<string, string> = {
  // Motion transfer: copies motion from a reference video onto one or more
  // character/product images. Unlike every other provider in this codebase,
  // this model does NOT work from a plain text prompt alone — generate()
  // below requires `videoUrl` and `imageUrls` in the params too. The studio
  // frontend only collects/sends those when the selected model is
  // "Genjutsu" (see MODEL_TO_PROVIDER in index.ts and the
  // data-hw-genjutsu-fields block in studio.js).
  genjutsu: "higgsfield/genjutsu/motion-transfer/v1.0",
  // Cinema Studio 4.0: plain text-to-video with automatic scene direction.
  // Takes prompt/duration/resolution/aspect_ratio/generate_audio like any
  // other prompt-driven model — reference image/video inputs are optional
  // extras it supports but that the studio UI doesn't send yet.
  "cinema-studio-4.0": "higgsfield/cinema-studio/4.0",
};

// Models whose generate() requires videoUrl + imageUrls rather than working
// from a plain text prompt (motion-transfer style, like Genjutsu). Every
// other Higgsfield model here is plain prompt-driven.
const REQUIRES_REFERENCE = new Set(["genjutsu"]);

interface HiggsfieldSubmitResponse {
  status: string;
  request_id?: string;
}

interface HiggsfieldStatusResponse {
  status: "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled" | string;
  video?: { url?: string };
  error?: string;
}

// console.higgsfield.ai currently issues ONE key that already comes
// formatted as "<key-id>:<key-secret>" (its own setup snippet says
// HF_KEY=your-api-key-id:your-api-key-secret) — you copy that whole string
// as a single value, there's no separate secret field to grab. Some accounts
// may instead be issued the id/secret as two separate values, so fall back
// to combining those if that's what's set.
function requireAuthHeader(): string {
  const singleKey = process.env.HIGGSFIELD_API_KEY;
  if (singleKey) return `Key ${singleKey}`;

  const keyId = process.env.HIGGSFIELD_API_KEY_ID;
  const keySecret = process.env.HIGGSFIELD_API_KEY_SECRET;
  if (keyId && keySecret) return `Key ${keyId}:${keySecret}`;

  throw new VideoProviderError(
    "No Higgsfield credentials set — set HIGGSFIELD_API_KEY to the single key from console.higgsfield.ai (already formatted as key-id:key-secret), or HIGGSFIELD_API_KEY_ID + HIGGSFIELD_API_KEY_SECRET if your account issued them separately",
    "missing_api_key"
  );
}

async function higgsfieldRequest<T>(url: string, init: RequestInit): Promise<T> {
  const authHeader = requireAuthHeader();

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
        ...init.headers,
      },
    });
  } catch (err) {
    throw new VideoProviderError(
      `Failed to reach the Higgsfield API: ${err instanceof Error ? err.message : String(err)}`,
      "network_error"
    );
  }

  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(
      `Higgsfield API rejected the request as unauthorized (HTTP ${response.status}) ${body} — check HIGGSFIELD_API_KEY_ID/HIGGSFIELD_API_KEY_SECRET`.trim(),
      "auth_error"
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(`Higgsfield API request failed: HTTP ${response.status} ${body}`.trim(), "request_failed");
  }

  return response.json() as Promise<T>;
}

function mapStatus(status: string): VideoStatusResult["status"] {
  switch (status) {
    case "queued":
      return "pending";
    case "in_progress":
      return "processing";
    case "completed":
      return "completed";
    default:
      // failed | nsfw | canceled | anything unrecognized — Higgsfield treats
      // all of these as terminal-but-not-successful, so surface as failed
      // rather than hang polling forever.
      return "failed";
  }
}

/**
 * Builds a VideoProvider backed by one Higgsfield model path. Register the
 * result under whatever key you like in the provider registry (index.ts) —
 * that key is what /api/generate's model→provider map should point at.
 */
export function createHiggsfieldProvider(name: string, modelPath: string): VideoProvider {
  const requiresReference = REQUIRES_REFERENCE.has(name);

  return {
    name,

    async generate(params: VideoGenerateParams): Promise<VideoGenerateResult> {
      const { prompt } = params;

      const videoUrl = typeof params.videoUrl === "string" ? params.videoUrl : undefined;
      const imageUrls = Array.isArray(params.imageUrls)
        ? params.imageUrls.filter((url): url is string => typeof url === "string" && url.length > 0)
        : [];
      const resolution = params.resolution === "480p" ? "480p" : "720p";

      let requestBody: Record<string, unknown>;

      if (requiresReference) {
        if (!videoUrl) {
          throw new VideoProviderError("videoUrl (a reference video URL) is required for this model", "invalid_params");
        }
        if (imageUrls.length === 0) {
          throw new VideoProviderError("imageUrls (one or more character/product image URLs) is required for this model", "invalid_params");
        }
        requestBody = {
          video_url: videoUrl,
          image_urls: imageUrls,
          prompt: prompt || undefined,
          resolution,
        };
      } else {
        // Plain prompt-driven model (e.g. Cinema Studio 4.0). Reference
        // inputs are optional extras it supports but aren't required —
        // include them only if the caller happened to supply any.
        requestBody = {
          prompt,
          duration: params.duration ?? 5,
          resolution,
          aspect_ratio: params.aspectRatio || "16:9",
          generate_audio: true,
        };
        if (videoUrl) requestBody.video_url = videoUrl;
        if (imageUrls.length > 0) requestBody.image_urls = imageUrls;
      }

      const body = await higgsfieldRequest<HiggsfieldSubmitResponse>(`${HIGGSFIELD_API_BASE}/${modelPath}`, {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      if (!body.request_id) {
        throw new VideoProviderError(`Higgsfield API did not return a request_id for ${modelPath}`, "request_failed");
      }

      return { jobId: body.request_id };
    },

    async getStatus(jobId: string): Promise<VideoStatusResult> {
      const body = await higgsfieldRequest<HiggsfieldStatusResponse>(
        `${HIGGSFIELD_API_BASE}/requests/${jobId}/status`,
        { method: "GET" }
      );

      const status = mapStatus(body.status);

      if (status === "failed") {
        return { status, error: body.error ?? `Higgsfield reported status "${body.status}"` };
      }

      if (status === "completed") {
        if (!body.video?.url) {
          return { status: "failed", error: "Higgsfield reported completion but returned no video URL" };
        }
        return { status, videoUrl: body.video.url };
      }

      return { status };
    },
  };
}

/** Builds one VideoProvider per entry in HIGGSFIELD_MODEL_PATHS, keyed by the same name. */
export function higgsfieldModelProviders(): Record<string, VideoProvider> {
  return Object.fromEntries(
    Object.entries(HIGGSFIELD_MODEL_PATHS).map(([name, modelPath]) => [name, createHiggsfieldProvider(name, modelPath)])
  );
}
