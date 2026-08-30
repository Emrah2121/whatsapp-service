import axios from 'axios';
import { config } from '../config';
import { createLogger } from '../logger';

const logger = createLogger('voice:config');

export interface VoiceConfig {
  sttApiKey: string;
  sttModel: string;
  sttLanguage: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  visionApiKey: string;
  visionModel: string;
}

const client = axios.create({
  baseURL: config.laravelApiBaseUrl,
  timeout: 5000,
  headers: { Authorization: `Bearer ${config.internalApiSecret}` },
});

// Voice config changes rarely (super admin edits it by hand), so a short cache
// keeps voice notes snappy without hammering Laravel on every message.
const CACHE_TTL_MS = 60_000;
let cached: { value: VoiceConfig; at: number } | null = null;

/** The Node service's own env values, used when Laravel returns a blank field. */
function envFallback(): VoiceConfig {
  return {
    sttApiKey: config.voice.groqApiKey,
    sttModel: config.voice.groqSttModel,
    sttLanguage: config.voice.sttLanguage,
    ttsApiKey: config.voice.geminiApiKey,
    ttsModel: config.voice.geminiTtsModel,
    ttsVoice: config.voice.geminiTtsVoice,
    visionApiKey: config.voice.geminiApiKey,
    visionModel: config.voice.geminiVisionModel,
  };
}

/**
 * Resolves the effective voice (STT/TTS) config. Laravel is the source of
 * truth (super-admin-managed keys/models); each field falls back to this
 * service's env when Laravel returns it blank or is unreachable. Cached for a
 * minute so repeated messages don't re-fetch.
 */
export async function getVoiceConfig(): Promise<VoiceConfig> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const fallback = envFallback();

  try {
    const response = await client.get('/internal/whatsapp/voice-config');
    const data = (response.data?.data ?? {}) as Partial<Record<string, string>>;

    const value: VoiceConfig = {
      sttApiKey: data.stt_api_key || fallback.sttApiKey,
      sttModel: data.stt_model || fallback.sttModel,
      sttLanguage: data.stt_language || fallback.sttLanguage,
      ttsApiKey: data.tts_api_key || fallback.ttsApiKey,
      ttsModel: data.tts_model || fallback.ttsModel,
      ttsVoice: data.tts_voice || fallback.ttsVoice,
      visionApiKey: data.vision_api_key || fallback.visionApiKey,
      visionModel: data.vision_model || fallback.visionModel,
    };

    cached = { value, at: Date.now() };

    return value;
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : error },
      'Failed to fetch voice config from Laravel; using env fallback',
    );
    // Cache the fallback briefly too so a Laravel blip doesn't hammer it.
    cached = { value: fallback, at: Date.now() };

    return fallback;
  }
}
