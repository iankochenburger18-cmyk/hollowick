import type { VideoProvider } from "./types";
import { VideoProviderError } from "./types";
import { lumaProvider } from "./luma";

// Add a new provider by writing its adapter file (matching VideoProvider) and
// registering it here — nothing else in the app needs to change.
const registry: Record<string, VideoProvider> = {
  luma: lumaProvider,
};

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
