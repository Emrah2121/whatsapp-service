import axios from 'axios';
import { config } from '../config';
import { createLogger } from '../logger';

const logger = createLogger('media:config');

export interface MediaConfig {
  voiceEnabled: boolean;
  visionEnabled: boolean;
}

const client = axios.create({
  baseURL: config.laravelApiBaseUrl,
  timeout: 5000,
  headers: { Authorization: `Bearer ${config.internalApiSecret}` },
});

// Per-company toggles change rarely, so a short per-company cache keeps media
// handling snappy without a round trip on every message.
const CACHE_TTL_MS = 60_000;
const cache = new Map<number, { value: MediaConfig; at: number }>();

/**
 * Per-company voice/vision toggles. On any failure we default to enabled so a
 * Laravel blip never silently drops a customer's media message.
 */
export async function getMediaConfig(companyId: number): Promise<MediaConfig> {
  const hit = cache.get(companyId);

  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.value;
  }

  const fallback: MediaConfig = { voiceEnabled: true, visionEnabled: true };

  try {
    const response = await client.get(`/internal/whatsapp/sessions/${companyId}/media-config`);
    const data = (response.data?.data ?? {}) as Partial<Record<string, boolean>>;

    const value: MediaConfig = {
      voiceEnabled: data.voice_enabled !== false,
      visionEnabled: data.vision_enabled !== false,
    };

    cache.set(companyId, { value, at: Date.now() });

    return value;
  } catch (error) {
    logger.warn(
      { companyId, err: error instanceof Error ? error.message : error },
      'Failed to fetch media config from Laravel; assuming enabled',
    );
    cache.set(companyId, { value: fallback, at: Date.now() });

    return fallback;
  }
}
