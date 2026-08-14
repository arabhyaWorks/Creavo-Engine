/**
 * Design Thinker Agent
 *
 * Given a brand kit, product details, product image and logo, generates a
 * world-class image generation prompt for Gemini's image model.
 *
 * The same prompt structure is used for both GPT-4o and Gemini Flash so
 * the outputs are a fair A/B comparison of design thinking quality.
 */

import type { BrandKit } from './types/brand.js';
import { callOpenAI }    from './openai.js';
import { analyzeImages } from './gemini.js';

export interface DesignThinkingInput {
  brand: BrandKit;
  productName: string;
  productDesc: string;
  priceFormatted: string;
  rating: string;
  reviewCount: string;
  keyClaim: string;
  size: string;
  canvasW: number;
  canvasH: number;
  language: 'en' | 'hi';
  productImageBase64: string;
  productMimeType: 'image/png' | 'image/jpeg';
  logoBase64: string;
  logoMimeType: 'image/png' | 'image/jpeg';
}

export interface DesignThinkingOutput {
  prompt: string;
  rationale: string;
  model: string;
}

// ─── Shared system prompt ─────────────────────────────────────────────────────

const SYSTEM = `You are the world's best creative director for premium Indian D2C brand social media.
You have 20 years directing editorial campaigns for Vogue India, premium FMCG, and artisan food brands.

You will be given brand palette, product details, the ACTUAL product photograph, and the brand logo.

YOUR JOB: Write a SHORT, PUNCHY image generation prompt (under 180 words) for Gemini's image model. The prompt must read like you are DESCRIBING A PHOTOGRAPH THAT ALREADY EXISTS — not giving instructions to a designer.

IMPORTANT CONSTRAINT: Long structured prompts cause the image model to cherry-pick and drop text elements. Short, vivid, complete descriptions work far better.

Return ONLY valid JSON: { "prompt": "...", "rationale": "2 sentences" }

PROMPT STRUCTURE — write it as ONE flowing description using this exact order:

PARAGRAPH 1 — MANDATORY TEXT (write this first so the model prioritises it):
"This image shows the following text rendered clearly: [CTA in quotes] in a gold pill button at the bottom-center, [price in quotes] in large bold gold serif just above the CTA, [product name in quotes] in bold cream serif centered at the top, and [claim in quotes] in small cream text below the product name."

PARAGRAPH 2 — PRODUCT:
The attached [product type] is centered, photorealistic, occupying the middle 40% of the 1080×1350 portrait canvas.

PARAGRAPH 3 — SCENE (3-4 sentences max):
Dark [surface/background]. Props. Lighting. The scene creates naturally dark areas at top and bottom where the text sits legibly.

PARAGRAPH 4 — STYLE (1 sentence):
Editorial mood reference + brand colors.

RULES:
- Every text string in double quotes, ≤ 15 characters each
- 4 text elements MAXIMUM (CTA + price + product name + 1 claim)
- Price and CTA are MANDATORY — if you drop any element, drop the claim not the price/CTA
- Bold serif for product name and price; pill button shape for CTA
- Logo placement: brand logo emblem in the top-right corner, small, in cream/white`;

// ─── User message builder ─────────────────────────────────────────────────────

function buildUserMessage(inp: DesignThinkingInput): string {
  const { brand, productName, productDesc, priceFormatted, rating, reviewCount,
          keyClaim, size, canvasW, canvasH } = inp;

  const palette = brand.identity.palette
    .map(p => `${p.name}: ${p.hex} (${p.role})`)
    .join(', ');

  const darkSwatch   = brand.identity.palette.find(p => p.role === 'dark');
  const primarySwatch = brand.identity.palette.find(p => p.role === 'primary');
  const lightSwatch  = brand.identity.palette.find(p => p.role === 'light');

  const darkHex   = darkSwatch?.hex    ?? '#1A0A00';
  const accentHex = primarySwatch?.hex ?? '#FFD800';
  const lightHex  = lightSwatch?.hex   ?? '#FFFAF0';

  // Split long product names into two short lines for accurate text rendering
  function splitProductName(name: string): { line1: string; line2: string } {
    if (name.length <= 14) return { line1: name, line2: '' };
    const words = name.split(' ');
    let line1 = '';
    let i = 0;
    while (i < words.length && (line1 + (line1 ? ' ' : '') + words[i]!).length <= 12) {
      line1 += (line1 ? ' ' : '') + words[i]!;
      i++;
    }
    const line2 = words.slice(i).join(' ');
    return { line1: line1 || name.slice(0, 12), line2 };
  }

  const { line1: nameLine1, line2: nameLine2 } = splitProductName(productName);
  const claimShort = (keyClaim || brand.usps[0] || '').split('·')[0]!.trim().slice(0, 16);

  return `Write a SHORT image generation prompt (under 200 words) for this Instagram post:

BRAND: ${brand.name} — "${brand.tagline ?? brand.usps[0]}"
PRODUCT: ${productName}, ${size}

MANDATORY TEXT — all 5 elements must appear in your final prompt:
  1. TOP-CENTER, cream bold serif: "${nameLine1}" on line 1${nameLine2 ? `, "${nameLine2}" on line 2` : ''}
  2. Below name, cream light italic: "${claimShort}"
  3. BOTTOM area, large bold color ${accentHex} serif: "${priceFormatted}"
  4. BELOW PRICE, pill button with ${accentHex} border + ${accentHex} text: "Shop Now"
  5. TOP-RIGHT corner, small cream emblem: brand logo (from attached image)

KEY COLORS: dark background=${darkHex}, accent=${accentHex}, light text=${lightHex}
TONE: ${brand.voice.tone_words.slice(0, 3).join(', ')}
IMAGES ATTACHED: (1) photorealistic product jar — render EXACTLY as shown, centered; (2) brand logo — top-right corner

CRITICAL: Start your prompt text by describing ALL text elements and their positions. Then describe the scene. Keep total under 200 words.

Output JSON only: { "prompt": "...", "rationale": "..." }`;
}

// ─── GPT-4o design thinker ────────────────────────────────────────────────────

export async function thinkWithGPT(opts: {
  apiKey: string;
  model: string;
  input: DesignThinkingInput;
}): Promise<DesignThinkingOutput> {
  const { apiKey, model, input } = opts;

  const raw = await callOpenAI({
    apiKey,
    model,
    systemPrompt: SYSTEM,
    userText: buildUserMessage(input),
    images: [
      { mimeType: input.productMimeType, base64: input.productImageBase64 },
      { mimeType: input.logoMimeType,    base64: input.logoBase64 },
    ],
    maxTokens: 2000,
  });

  return parseOutput(raw, model);
}

// ─── Gemini Flash design thinker ──────────────────────────────────────────────

export async function thinkWithGemini(opts: {
  apiKey: string;
  model: string;
  input: DesignThinkingInput;
}): Promise<DesignThinkingOutput> {
  const { apiKey, model, input } = opts;

  const prompt = SYSTEM + '\n\n---\n\n' + buildUserMessage(input);

  const raw = await analyzeImages({
    apiKey,
    model,
    prompt,
    images: [
      { mimeType: input.productMimeType, base64: input.productImageBase64 },
      { mimeType: input.logoMimeType,    base64: input.logoBase64 },
    ],
  });

  return parseOutput(raw, model);
}

// ─── Parse JSON from LLM response ────────────────────────────────────────────

function escapeJsonStringValues(raw: string): string {
  // Escape literal newlines/tabs/CR inside JSON string values (LLMs often omit this)
  let inStr = false, esc = false, out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (esc)            { esc = false; out += c; continue; }
    if (c === '\\')     { esc = true;  out += c; continue; }
    if (c === '"')      { inStr = !inStr; out += c; continue; }
    if (inStr) {
      if (c === '\n')   { out += '\\n'; continue; }
      if (c === '\r')   { out += '\\r'; continue; }
      if (c === '\t')   { out += '\\t'; continue; }
    }
    out += c;
  }
  return out;
}

function parseOutput(raw: string, model: string): DesignThinkingOutput {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cleaned = (fenced ? fenced[1] : raw).trim();
  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}') + 1;
  if (start === -1) throw new Error(`Design thinker (${model}) returned no JSON:\n${raw.slice(0, 300)}`);

  const sanitized = escapeJsonStringValues(cleaned.slice(start, end));
  let parsed: { prompt?: string; rationale?: string };
  try {
    parsed = JSON.parse(sanitized) as { prompt?: string; rationale?: string };
  } catch (e) {
    throw new Error(`Design thinker (${model}) JSON parse failed: ${(e as Error).message}\nRaw (first 500): ${raw.slice(0, 500)}`);
  }

  if (!parsed.prompt) throw new Error(`Design thinker (${model}) returned no prompt field`);

  return {
    prompt: parsed.prompt,
    rationale: parsed.rationale ?? '',
    model,
  };
}
