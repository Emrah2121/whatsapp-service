import 'dotenv/config';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  internalApiSecret: required('INTERNAL_API_SECRET'),
  laravelApiBaseUrl: required('LARAVEL_API_BASE_URL').replace(/\/+$/, ''),
  sessionsDir: path.resolve(process.cwd(), process.env.SESSIONS_DIR ?? './storage/sessions'),
  voice: {
    // STT (speech-to-text) via Groq Whisper. When the key is absent, incoming
    // voice notes are skipped instead of transcribed.
    groqApiKey: process.env.GROQ_API_KEY ?? '',
    groqSttModel: process.env.GROQ_STT_MODEL ?? 'whisper-large-v3-turbo',
    // Language hint for Whisper (ISO-639-1). Without it, auto-detection often
    // mislabels short Azerbaijani clips as Turkish/other. Empty = auto-detect.
    sttLanguage: process.env.GROQ_STT_LANGUAGE ?? 'az',
    // TTS (text-to-speech) via Gemini. When the key is absent, replies to voice
    // notes fall back to plain text instead of a spoken reply.
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    geminiTtsModel: process.env.GEMINI_TTS_MODEL ?? 'gemini-2.5-flash-preview-tts',
    geminiTtsVoice: process.env.GEMINI_TTS_VOICE ?? 'Kore',
    // Image analysis (vision) reuses the Gemini key; only the model differs.
    geminiVisionModel: process.env.GEMINI_VISION_MODEL ?? 'gemini-flash-latest',
    // Uses the FFMPEG_PATH env var if set; otherwise falls back to the
    // static ffmpeg binary bundled by the ffmpeg-static package, so no
    // system install or PATH setup is needed on any OS (Windows dev machine
    // or Linux server alike). 'ffmpeg' is the last-resort fallback in case
    // the bundled binary is ever unavailable (e.g. an unsupported platform).
    ffmpegPath: process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg',
  },
};
