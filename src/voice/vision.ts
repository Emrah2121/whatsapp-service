import { createLogger } from '../logger';
import { getVoiceConfig } from './voiceConfig';

const logger = createLogger('voice:vision');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Describes a WhatsApp image with Gemini vision so the conversation can
 * continue in text. The description is written in Azerbaijani and includes any
 * visible text/products, letting the company's AI answer questions about the
 * photo. Returns null when vision is not configured or the call fails.
 */
export async function analyzeImage(image: Buffer, mimetype: string, caption?: string): Promise<string | null> {
  const voice = await getVoiceConfig();

  if (!voice.visionApiKey) {
    logger.warn('Gemini API key not set - skipping image analysis');

    return null;
  }

  const instruction = caption
    ? `İstifadəçi bu şəkli göndərdi və yazdı: "${caption}". Şəkli ətraflı təsvir et, üzərindəki bütün mətn/rəqəm/məhsul adlarını çıxar. Cavabı Azərbaycan dilində, qısa və aydın yaz.`
    : 'İstifadəçi bu şəkli göndərdi. Şəkli ətraflı təsvir et, üzərindəki bütün mətn/rəqəm/məhsul adlarını çıxar. Cavabı Azərbaycan dilində, qısa və aydın yaz.';

  const url = `${GEMINI_BASE}/${voice.visionModel}:generateContent?key=${voice.visionApiKey}`;

  const body = {
    contents: [
      {
        parts: [
          { text: instruction },
          { inline_data: { mime_type: mimetype, data: image.toString('base64') } },
        ],
      },
    ],
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text();
      logger.warn({ status: response.status, detail: detail.slice(0, 300) }, 'Gemini vision request failed');

      return null;
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    const text = data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('')
      .trim();

    return text && text.length > 0 ? text : null;
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : error }, 'Gemini vision request errored');

    return null;
  }
}
