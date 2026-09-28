import type { VideoGenerateParams, VideoGenerateResult, VideoProvider, VideoStatusResult } from "./types";
import { VideoProviderError } from "./types";

// Google Veo via the Gemini API — https://ai.google.dev/gemini-api/docs/veo
// This is a long-running-operation API: generate() kicks off an operation and
// returns its name; getStatus() polls that same operation until `done`.
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
// Google ships preview model ids that can move; confirm the current one at
// https://ai.google.dev/gemini-api/docs/veo before relying on this in production.
const VEO_MODEL = "veo-3.1-generate-preview";

interface VeoOperationResponse {
  name: string;
  done?: boolean;
  error?: { message?: string; code?: number };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string } }>;
    };
  };
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

async function veoRequest(path: string, init: RequestInit): Promise<VeoOperationResponse> {
  const apiKey = requireApiKey();

  let response: Response;
  try {
    response = await fetch(`${GEMINI_API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
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
      `Gemini API rejected the request as unauthorized (HTTP ${response.status}) ${body} — check that GOOGLE_VEO_API_KEY is valid and Veo access is enabled for this key`.trim(),
      "auth_error"
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VideoProviderError(`Gemini API request failed: HTTP ${response.status} ${body}`.trim(), "request_failed");
  }

  return response.json() as Promise<VeoOperationResponse>;
}

export const veoProvider: VideoProvider = {
  name: "veo",

  async generate(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    const { prompt, aspectRatio } = params;

    if (!prompt) {
      throw new VideoProviderError("prompt is required", "invalid_params");
    }

    const body = await veoRequest(`/models/${VEO_MODEL}:predictLongRunning`, {
      method: "POST",
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          aspectRatio: aspectRatio ?? "16:9",
        },
      }),
    });

    if (!body.name) {
      throw new VideoProviderError("Gemini API did not return an operation name for this generation", "request_failed");
    }

    return { jobId: body.name };
  },

  async getStatus(jobId: string): Promise<VideoStatusResult> {
    // jobId is the full operation name (e.g. "operations/abc123") — the
    // Gemini API exposes operations at /v1beta/{name}, not under /models/.
    const body = await veoRequest(`/${jobId}`, { method: "GET" });

    if (!body.done) {
      return { status: "processing" };
    }

    if (body.error) {
      return { status: "failed", error: body.error.message ?? "Veo reported a generation failure with no reason given" };
    }

    const uri = body.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!uri) {
      return { status: "failed", error: "Veo reported completion but returned no video URI" };
    }

    // Gemini's file download endpoints require the API key as a query param
    // when fetched without the SDK's auth headers (which is what our
    // storage.ts's plain fetch() does when it downloads this URL).
    const apiKey = requireApiKey();
    const separator = uri.includes("?") ? "&" : "?";
    return { status: "completed", videoUrl: `${uri}${separator}key=${apiKey}` };
  },
};
