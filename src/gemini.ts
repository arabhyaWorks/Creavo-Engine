/**
 * Gemini image generation REST client.
 *
 * Endpoint:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * The model receives a text prompt plus optional reference images (inline base64).
 * It returns the generated image as inline_data in the response parts.
 *
 * Model is configurable via GEMINI_IMAGE_MODEL env var.
 * Default: gemini-2.0-flash-preview-image-generation
 */

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiRequest {
  contents: Array<{ parts: GeminiPart[] }>;
  generationConfig: { responseModalities: string[] };
}

interface GeminiErrorBody {
  error?: { code: number; message: string; status: string };
}

interface GeminiResponse extends GeminiErrorBody {
  candidates?: Array<{
    content: { parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> };
    finishReason?: string;
  }>;
}

export interface ImageGenOpts {
  apiKey: string;
  model: string;
  prompt: string;
  referenceImages?: Array<{ mimeType: string; base64: string }>;
}

export interface ImageGenResult {
  imageBytes: Buffer;
  mimeType: string;
}

export async function generateImage(opts: ImageGenOpts): Promise<ImageGenResult> {
  const { apiKey, model, prompt, referenceImages = [] } = opts;

  const parts: GeminiPart[] = [{ text: prompt }];
  for (const ref of referenceImages) {
    parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.base64 } });
  }

  const body: GeminiRequest = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  };

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as GeminiResponse;

  if (!res.ok || json.error) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Gemini API error: ${msg}`);
  }

  const parts2 = json.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts2) {
    if (part.inlineData?.data) {
      return {
        imageBytes: Buffer.from(part.inlineData.data, 'base64'),
        mimeType: part.inlineData.mimeType ?? 'image/png',
      };
    }
  }

  throw new Error(
    'Gemini response contained no image data. ' +
    `finishReason=${json.candidates?.[0]?.finishReason ?? 'unknown'}`,
  );
}

export interface VisionOpts {
  apiKey: string;
  model: string;
  prompt: string;
  images: Array<{ mimeType: string; base64: string }>;
}

/** Text-out call with image inputs — used by the QA verifier. */
export async function analyzeImages(opts: VisionOpts): Promise<string> {
  const { apiKey, model, prompt, images } = opts;

  const parts: GeminiPart[] = [{ text: prompt }];
  for (const img of images) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }] }),
  });

  const json = (await res.json()) as GeminiResponse;

  if (!res.ok || json.error) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Gemini API error: ${msg}`);
  }

  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map(p => p.text ?? '')
    .join('');

  if (!text) {
    throw new Error(
      'Gemini vision response contained no text. ' +
      `finishReason=${json.candidates?.[0]?.finishReason ?? 'unknown'}`,
    );
  }
  return text;
}
