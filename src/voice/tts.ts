import { spawn } from 'node:child_process';
import { config } from '../config';
import { createLogger } from '../logger';
import { getVoiceConfig, type VoiceConfig } from './voiceConfig';

const logger = createLogger('voice:tts');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiInlineData {
  mimeType?: string;
  data?: string;
}

/**
 * Synthesizes speech from text as a WhatsApp-ready OGG/Opus voice note.
 *
 * Gemini TTS returns raw PCM (signed 16-bit little-endian, mono, usually
 * 24 kHz), which WhatsApp cannot play as a voice note, so ffmpeg re-encodes
 * it to OGG/Opus. Returns null when TTS is not configured or any step fails -
 * the caller then falls back to sending the reply as plain text.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  const voice = await getVoiceConfig();

  if (!voice.ttsApiKey) {
    logger.warn('Gemini API key not set - skipping speech synthesis');

    return null;
  }

  const pcm = await requestGeminiPcm(text, voice);

  if (!pcm) {
    return null;
  }

  try {
    return await pcmToOpusOgg(pcm.buffer, pcm.sampleRate);
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : error }, 'ffmpeg PCM->Opus conversion failed');

    return null;
  }
}

async function requestGeminiPcm(text: string, voice: VoiceConfig): Promise<{ buffer: Buffer; sampleRate: number } | null> {
  const url = `${GEMINI_BASE}/${voice.ttsModel}:generateContent?key=${voice.ttsApiKey}`;

  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.ttsVoice } },
      },
    },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text();
      logger.warn({ status: response.status, detail: detail.slice(0, 300) }, 'Gemini TTS request failed');

      return null;
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { inlineData?: GeminiInlineData }[] } }[];
    };

    const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;

    if (!inline?.data) {
      logger.warn('Gemini TTS response contained no audio data');

      return null;
    }

    return {
      buffer: Buffer.from(inline.data, 'base64'),
      sampleRate: parseSampleRate(inline.mimeType),
    };
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : error }, 'Gemini TTS request errored');

    return null;
  }
}

/** Extracts "rate=NNNNN" from a mime type like "audio/L16;codec=pcm;rate=24000". */
function parseSampleRate(mimeType: string | undefined): number {
  const match = mimeType?.match(/rate=(\d+)/);

  return match ? Number(match[1]) : 24000;
}

function pcmToOpusOgg(pcm: Buffer, sampleRate: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(config.voice.ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ac', '1',
      '-i', 'pipe:0',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-f', 'ogg',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ff.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(errChunks).toString().slice(0, 300)}`));
      }
    });

    ff.stdin.on('error', () => {
      // Ignore EPIPE if ffmpeg closed early; the close handler reports the real error.
    });
    ff.stdin.write(pcm);
    ff.stdin.end();
  });
}
