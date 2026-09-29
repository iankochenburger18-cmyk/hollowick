import type { VideoProvider } from "./types";
import { VideoProviderError } from "./types";
import { lumaProvider } from "./luma";
import { veoProvider } from "./veo";
import { klingProvider } from "./kling";
import { runwayProvider } from "./runway";
import { falModelProviders } from "./fal";

// Add a new direct provider by writing its adapter file (matching
// VideoProvider) and registering it here — nothing else in the app needs to
// change. Add a new fal.ai-backed provider instead by adding one line to
// FAL_MODEL_IDS in fal.ts — falModelProviders() picks it up automatically.
const registry: Record<string, VideoProvider> = {
  luma: lumaProvider,
  veo: veoProvider,
  kling: klingProvider,
  runway: runwayProvider,
  ...falModelProviders(),
};

// UI-facing model names (as shown in the studio's model dropdown) mapped to
// the provider registry key that actually serves them. Keep this in sync
// with the MODELS array in the frontend's studio.js.
export const MODEL_TO_PROVIDER: Record<string, string> = {
  Ray3: "luma",
  "Veo 3.1": "veo",
  "Kling 3.0": "kling",
  "Gen-4.5": "runway",
  "Seedance 2.5": "seedance-2.5",
  "PixVerse v6": "pixverse-v6",
  "MiniMax H3 Max Turbo": "minimax-h3-max-turbo",
  "Wan 3.0 Prime": "wan-3.0-prime",
};

export function resolveProviderName(model: string | null | undefined, fallbackProvider: string | null | undefined): string {
  if (model && MODEL_TO_PROVIDER[model]) return MODEL_TO_PROVIDER[model];
  if (fallbackProvider) return fallbackProvider;
  return "luma";
}

export function getVideoProvider(name: string): VideoProvider {
  const provider = registry[name];
  if (!provider) {
    throw new VideoProviderError(
      `Unknown video provider "${name}" — available providers: ${Object.keys(registry).join(", ")}`,
      "unknown_provider"
    );
  }
  return provider;
}

export * from "./types";
