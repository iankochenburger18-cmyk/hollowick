import type { VideoGenerateParams, VideoGenerateResult, VideoProvider, VideoStatusResult } from "./types";
import { VideoProviderError } from "./types";

// Google Gemini Omni Flash — https://ai.google.dev/gemini-api/docs/omni
//
// Replaces veo-3.1-generate-preview, which Google shut down on
// October 22, 2026 (confirmed against
// https://ai.google.dev/gemini-api/docs/models/veo-3.1-generate-preview and
// multiple independent sources — the old predictLongRunning endpoint this
// file used to call is gone, not just deprecated).
//
// This is the Interactions API, a completely different shape from the old
// Veo operations pattern: POST /v1beta/interactions with `background: true`
// returns an interaction id immediately (status "in_progress"), and
// GET /v1beta/interactions/{id} polls it — see
// https://ai.google.dev/gemini-api/docs/background-execution. That maps
// cleanly onto this app's existing generate()-kicks-off / getStatus()-polls
// contract, same as every other provider here.
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
// Preview/GA model ids move — confirm the current one at
// https://ai.google.dev/gemini-api/docs/omni before relying on this in production.
const OMNI_MODEL = "gemini-omni-1.1-flash";
// The Interactions API's background-execution endpoints require this
// header (the old long-running-operation endpoint veo.ts used to call
// didn't need one) — see the curl example at
// https://ai.google.dev/gemini-api/docs/background-execution.
const API_REVISION = "2026-05-20";

type InteractionStatus = "in_progress" | "requires_action" | "completed" | "failed" | "cancelled";

interface InteractionContentItem {
  type?: string;
  mime_type?: string;
  data?: string; // base64 — what GET currently always returns, even when delivery: "uri" was requested
  uri?: string;
}

interface InteractionStep {
  type?: string;
  content?: InteractionContentItem[];
}

interface InteractionResponse {
  id: string;
  status?: InteractionStatus;
  steps?: InteractionStep[];
  error?: { message?: string };
}

function requireApiKey(): string {
  const apiKey = process.env.GOOGLE_VEO_API_KEY;
  if (!apiKey) {
    throw new VideoProviderError(
      "GOOGLE_VEO_API_KEY is not set — add it to the environment before generating with the veo provider",
      "missing_api_key"
    );
  }
  return apiKey;
}

async function omniRequest(path: string, init: RequestInit): Promise<InteractionResponse> {
  const apiKey = requireApiKey();

  let response: Response;
  try {
    response = await fetch(`${GEMINI_API_BASE}${path}`, {
      ...init,
      // See the matching comment in fal.ts — Next.js patches global fetch()
      // for its Data Cache, which has been observed breaking POSTs to
      // third-party queue APIs. Opt out of that patching here.
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        "Api-Revision": API_REVISION,
        ...init.headers,
      },
    });
  } catch (err) {
    throw new VideoProviderError(
      `Failed to reach the Gemini API: ${err instanceof Error ? err.message : String(err)}`,
      "network_error"
    );
  }

  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(
      `Gemini API rejected the request as unauthorized (HTTP ${response.status}) ${body} — check that GOOGLE_VEO_API_KEY is valid and Omni Flash access is enabled for this key`.trim(),
      "auth_error"
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(`Gemini API request failed: HTTP ${response.status} ${body}`.trim(), "request_failed");
  }

  return response.json() as Promise<InteractionResponse>;
}

// Omni Flash only supports these two aspect ratios — no 1:1, which the
// studio UI still offers (it's a global option, not filtered per model; see
// DURATION_LOCKED_MODELS's sibling note in studio.js). Rather than failing
// the whole generation over a ratio this provider can't produce, fold 1:1
// into the nearer of the two square-ish options, same spirit as Runway's
// own ratio validation elsewhere in this codebase.
function resolveAspectRatio(aspectRatio: string | undefined): "16:9" | "9:16" {
  return aspectRatio === "9:16" ? "9:16" : "16:9";
}

export const veoProvider: VideoProvider = {
  name: "veo",

  async generate(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    const { prompt, aspectRatio } = params;

    if (!prompt) {
      throw new VideoProviderError("prompt is required", "invalid_params");
    }

    const body = await omniRequest(`/interactions`, {
      method: "POST",
      body: JSON.stringify({
        model: OMNI_MODEL,
        input: prompt,
        // Runs the generation in the background and returns the interaction
        // id right away instead of blocking this request until the video is
        // fully rendered — required so this fits the kick-off/poll pattern
        // every other provider adapter here uses, rather than tying up the
        // /api/generate request for as long as rendering takes.
        background: true,
        response_format: {
          type: "video",
          aspect_ratio: resolveAspectRatio(aspectRatio),
          resolution: "720p",
          delivery: "uri",
        },
        generation_config: {
          video_config: { task: "text_to_video" },
        },
      }),
    });

    if (!body.id) {
      throw new VideoProviderError("Gemini API did not return an interaction id for this generation", "request_failed");
    }

    return { jobId: body.id };
  },

  async getStatus(jobId: string): Promise<VideoStatusResult> {
    // jobId is the bare interaction id (e.g. "v1_abc123") — unlike the old
    // Veo operations, which were polled at their own full resource path.
    const body = await omniRequest(`/interactions/${jobId}`, { method: "GET" });

    const status = body.status ?? "in_progress";

    if (status === "in_progress") {
      return { status: "processing" };
    }

    if (status === "requires_action") {
      // Only reachable if Omni Flash ever pauses an interaction for tool
      // input — this adapter never sends tool definitions, so this should
      // never actually happen. Surfaced as a failure rather than left to
      // poll forever if it somehow does.
      return {
        status: "failed",
        error: "Omni Flash paused the interaction waiting for client input, which this adapter doesn't support.",
      };
    }

    if (status === "failed" || status === "cancelled") {
      return {
        status: "failed",
        error: body.error?.message ?? `Omni Flash reported status "${status}" with no reason given`,
      };
    }

    // status === "completed"
    const outputStep = body.steps?.find((step) => step.type === "model_output");
    const videoContent = outputStep?.content?.find((item) => item.type === "video");

    if (!videoContent) {
      return { status: "failed", error: "Omni Flash reported completion but returned no video output" };
    }

    // Per Google's own docs, GET /v1beta/interactions/{id} currently always
    // inlines base64 data even when delivery: "uri" was requested in
    // generate() above — but check for a real uri first in case that
    // changes, since a URL avoids re-encoding/transferring the bytes twice.
    if (videoContent.uri) {
      return { status: "completed", videoUrl: videoContent.uri };
    }

    if (videoContent.data) {
      return {
        status: "completed",
        videoData: { base64: videoContent.data, mimeType: videoContent.mime_type || "video/mp4" },
      };
    }

    return { status: "failed", error: "Omni Flash reported completion but returned neither a video URI nor inline data" };
  },
};
