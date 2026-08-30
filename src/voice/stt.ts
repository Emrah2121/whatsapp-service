import { createLogger } from '../logger';
import { getVoiceConfig } from './voiceConfig';

const logger = createLogger('voice:stt');

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * Transcribes a WhatsApp voice note (OGG/Opus) to text via Groq Whisper.
 * Whisper accepts the ogg/opus container directly, so no re-encoding is
 * needed here. Returns null when STT is not configured or the call fails -
 * callers treat that as "no usable text" and skip the message.
 */
export async function transcribeAudio(audio: Buffer, mimetype: string): Promise<string | null> {
  const voice = await getVoiceConfig();

  if (!voice.sttApiKey) {
    logger.warn('Groq API key not set - skipping voice transcription');

    return null;
  }

  const extension = mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mp4') || mimetype.includes('m4a') ? 'm4a' : 'bin';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimetype }), `audio.${extension}`);
  form.append('model', voice.sttModel);
  form.append('response_format', 'json');

  if (voice.sttLanguage) {
    form.append('language', voice.sttLanguage);
  }

  try {
    const response = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${voice.sttApiKey}` },
      body: form,
    });

    if (!response.ok) {
      const detail = await response.text();
      logger.warn({ status: response.status, detail: detail.slice(0, 300) }, 'Groq transcription failed');

      return null;
    }

    const data = (await response.json()) as { text?: string };
    const text = data.text?.trim();

    return text && text.length > 0 ? text : null;
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : error }, 'Groq transcription request errored');

    return null;
  }
}
