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
  // Cinema Studio 4.0: Higgsfield's own text-to-video model with automatic
  // scene direction.
  "cinema-studio-4.0": "higgsfield/cinema-studio/4.0",
  // Kling 2.6 Pro: a third-party model Higgsfield resells (not under the
  // "higgsfield/" namespace, unlike the two above) — wired up here instead
  // of through the fal.ai aggregator because it's cheaper per-clip on
  // Higgsfield at time of writing. Price-check both before adding another
  // reseller model either way; it can flip.
  "kling-2.6-pro": "kling-video/v2.6/pro/text-to-video",

  // Batch of 9 more resold third-party models, all routed through
  // Higgsfield rather than fal.ai per an explicit decision to skip
  // per-model price-checking for this batch (the endpoints were already
  // gathered here) — revisit per-model if pricing becomes a concern later.
  "kling-2.5-standard": "kling-video/v2.5-turbo/standard/image-to-video",
  "seedance-2.0": "bytedance/seedance-2.0/text-to-video",
  "wan-3.0": "alibaba/wan-3.0/text-to-video",
  "wan-2.7": "wan/v2.7/text-to-video",
  "minimax-hailuo-2.3": "minimax/hailuo-2.3/standard/text-to-video",
  "ltx-2.5-fast": "lightricks/ltx-2.5/text-to-video/fast",
  "ltx-2.5-pro": "lightricks/ltx-2.5/text-to-video/pro",
  "happy-horse-1.1": "alibaba/happy-horse/v1.1/text-to-video",
  "happy-horse-1.0": "alibaba/happy-horse/text-to-video",
};

// Each Higgsfield model expects a different request-body shape (this is a
// grab-bag aggregator covering Higgsfield's own models plus resold
// third-party ones, and every provider has its own parameter names) — so
// every entry in HIGGSFIELD_MODEL_PATHS needs a matching builder here.
// createHiggsfieldProvider() below fails fast at startup if one is missing,
// rather than silently sending the wrong shape to a model that happens to
// accept a similar-looking body.
type HiggsfieldBodyBuilder = (params: VideoGenerateParams) => Record<string, unknown>;

/** Shared by motion-transfer-style models: requires a reference video + one or more images, not just a prompt. */
function referenceBody(params: VideoGenerateParams): Record<string, unknown> {
  const videoUrl = typeof params.videoUrl === "string" ? params.videoUrl : undefined;
  const imageUrls = Array.isArray(params.imageUrls)
    ? params.imageUrls.filter((url): url is string => typeof url === "string" && url.length > 0)
    : [];

  if (!videoUrl) {
    throw new VideoProviderError("videoUrl (a reference video URL) is required for this model", "invalid_params");
  }
  if (imageUrls.length === 0) {
    throw new VideoProviderError("imageUrls (one or more character/product image URLs) is required for this model", "invalid_params");
  }

  return {
    video_url: videoUrl,
    image_urls: imageUrls,
    prompt: params.prompt || undefined,
    resolution: params.resolution === "480p" ? "480p" : "720p",
  };
}

/** Shared by Kling 2.5 (image-to-video): requires a single reference image, not just a prompt. */
function singleImageBody(params: VideoGenerateParams): Record<string, unknown> {
  const imageUrl = typeof params.imageUrl === "string" ? params.imageUrl : undefined;
  if (!imageUrl) {
    throw new VideoProviderError("imageUrl (a reference image URL) is required for this model", "invalid_params");
  }
  return {
    prompt: params.prompt,
    duration: params.duration ?? 5,
    cfg_scale: 0.5,
    image_url: imageUrl,
    negative_prompt: "",
  };
}

/** Plain text-to-video shape shared by Cinema Studio 4.0 and Seedance 2.0. */
function plainAudioBody(params: VideoGenerateParams): Record<string, unknown> {
  return {
    prompt: params.prompt,
    duration: params.duration ?? 5,
    resolution: params.resolution === "480p" ? "480p" : "720p",
    aspect_ratio: params.aspectRatio || "16:9",
    generate_audio: true,
  };
}

/** Plain text-to-video shape shared by the two LTX 2.5 tiers (fast/pro differ only by modelPath). */
function ltxBody(params: VideoGenerateParams): Record<string, unknown> {
  return {
    prompt: params.prompt,
    duration: params.duration ?? 5,
    resolution: params.resolution === "480p" ? "480p" : "720p",
    aspect_ratio: params.aspectRatio || "16:9",
    fps: 25,
  };
}

/** Plain text-to-video shape shared by the two Happy Horse versions (1.1/1.0 differ only by modelPath) — no audio field. */
function happyHorseBody(params: VideoGenerateParams): Record<string, unknown> {
  return {
    prompt: params.prompt,
    duration: params.duration ?? 5,
    resolution: params.resolution === "480p" ? "480p" : "720p",
    aspect_ratio: params.aspectRatio || "16:9",
  };
}

const HIGGSFIELD_MODEL_BODIES: Record<string, HiggsfieldBodyBuilder> = {
  genjutsu: referenceBody,

  "cinema-studio-4.0": plainAudioBody,

  "kling-2.6-pro": (params) => ({
    prompt: params.prompt,
    duration: params.duration ?? 5,
    aspect_ratio: params.aspectRatio || "16:9",
    sound: "on",
    cfg_scale: 0.5,
  }),

  "kling-2.5-standard": singleImageBody,

  "seedance-2.0": plainAudioBody,

  "wan-3.0": (params) => ({
    prompt: params.prompt,
    duration: params.duration ?? 5,
    resolution: params.resolution === "480p" ? "480p" : "720p",
    aspect_ratio: params.aspectRatio || "16:9",
    generate_audio: true,
    enable_thinking: false,
  }),

  "wan-2.7": (params) => ({
    prompt: params.prompt,
    duration: params.duration ?? 5,
    resolution: params.resolution === "480p" ? "480p" : "720p",
    aspect_ratio: params.aspectRatio || "16:9",
    prompt_extend: false,
    negative_prompt: "",
  }),

  "minimax-hailuo-2.3": (params) => ({
    prompt: params.prompt,
    duration: params.duration ?? 6,
    prompt_optimizer: true,
  }),

  "ltx-2.5-fast": ltxBody,
  "ltx-2.5-pro": ltxBody,

  "happy-horse-1.1": happyHorseBody,
  "happy-horse-1.0": happyHorseBody,
};

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
  const buildBody = HIGGSFIELD_MODEL_BODIES[name];
  if (!buildBody) {
    throw new Error(
      `No request-body builder registered for Higgsfield model "${name}" — add one to HIGGSFIELD_MODEL_BODIES in higgsfield.ts`
    );
  }

  return {
    name,

    async generate(params: VideoGenerateParams): Promise<VideoGenerateResult> {
      const requestBody = buildBody(params);

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
