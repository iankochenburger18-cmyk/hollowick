export interface VideoGenerateParams {
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  [key: string]: unknown;
}

export interface VideoGenerateResult {
  jobId: string;
}

export type VideoJobStatus = "pending" | "processing" | "completed" | "failed";

export interface VideoStatusResult {
  status: VideoJobStatus;
  videoUrl?: string;
  // Set instead of videoUrl by a provider whose "finished" response hands
  // back the actual video bytes rather than a URL to fetch them from (e.g.
  // Gemini Omni Flash's Interactions API — see veo.ts). The worker uploads
  // whichever of the two is present; exactly one should be set on a
  // "completed" result.
  videoData?: { base64: string; mimeType: string };
  error?: string;
}

export interface VideoProvider {
  name: string;
  generate(params: VideoGenerateParams): Promise<VideoGenerateResult>;
  getStatus(jobId: string): Promise<VideoStatusResult>;
}

/** Thrown by provider adapters for both config problems (missing API key) and API-level failures (auth, bad request). */
export class VideoProviderError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "VideoProviderError";
    this.code = code;
  }
}
