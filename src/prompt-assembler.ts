/**
 * Prompt Assembler for Route A (Gemini image generation).
 *
 * Constructs a generation prompt from four elements (PRD §13.1):
 *   1. Archetype grammar  — visual layout intent for the image model
 *   2. Brand tokens       — palette hexes, tone words, USPs
 *   3. Quoted exact strings — the copy that MUST appear on the image, in quotes
 *   4. Reference image note — indicates the product cutout is attached
 */

import type { DesignSpec, TextLayer } from './types/spec.js';
import type { BrandKit } from './types/brand.js';

export interface PromptContext {
  spec: DesignSpec;
  brand: BrandKit;
  productImageAttached: boolean;
}

export function assemblePrompt(ctx: PromptContext): string {
  const { spec, brand, productImageAttached } = ctx;
  const { identity, voice, usps, name } = brand;

  const primary    = identity.palette.find(p => p.role === 'primary');
  const secondary  = identity.palette.find(p => p.role === 'secondary');
  const bg         = identity.palette.find(p => p.role === 'background');
  const accent     = identity.palette.find(p => p.role === 'accent');

  const { w, h } = spec.dimensions;

  // Collect text layers in layer order (bottom → top)
  const textLayers = spec.layers.filter((l): l is TextLayer => l.type === 'text');

  // Build quoted-string lines — each exact string the model must render
  const quotedLines = textLayers.map(l => {
    const role = l.badge ? `(${l.badge.shape} badge)` : `(${l.id})`;
    return `  • ${role}: "${l.text}"`;
  });

  // Palette description
  const paletteDesc = identity.palette
    .map(p => `${p.name} ${p.hex} [${p.role}]`)
    .join(', ');

  const sections: string[] = [];

  // ── 1. Opening / archetype grammar ───────────────────────────────────────────
  sections.push(
    `Create a high-quality Instagram portrait post image (${w}×${h} pixels, 4:5 ratio) ` +
    `for "${name}", a traditional handcrafted Indian kurta brand from Lucknow.`,
  );

  sections.push(
    [
      `VISUAL COMPOSITION — ${spec.archetype_id} archetype:`,
      `- Header band (top ~22% of canvas): deep ${primary?.name ?? 'burgundy'} gradient ` +
        `from ${primary?.hex ?? '#7A1F2B'} to ${secondary?.hex ?? '#4D1219'}, with a soft ` +
        'elliptical curve at the bottom edge',
      `- Main canvas body: warm ${bg?.name ?? 'cream'} (${bg?.hex ?? '#F5EDD6'}) background`,
      `- Thin ${accent?.name ?? 'gold'} (${accent?.hex ?? '#C9A84C'}) horizontal rule at ` +
        'the very top and very bottom of the image (6 px)',
      '- Large product garment centered, occupying ~55% of canvas height, with a soft shadow',
      `- Price displayed in a rounded pill shape using ${accent?.hex ?? '#C9A84C'} fill, ` +
        `dark ${primary?.hex ?? '#7A1F2B'} text, positioned below the garment`,
      `- Wide CTA (call-to-action) button in ${primary?.hex ?? '#7A1F2B'} near the bottom`,
      '- NO logo anywhere on the image — it will be composited separately',
    ].join('\n'),
  );

  // ── 2. Brand tokens ───────────────────────────────────────────────────────────
  sections.push(
    [
      'BRAND PALETTE (use these exact hex values):',
      `  ${paletteDesc}`,
      '',
      `BRAND TONE: ${voice.tone_words.join(', ')}.`,
      'Heritage Lucknowi craftsmanship. Traditional yet aspirational.',
      '',
      'KEY SELLING POINTS (inform the visual mood, do not print these):',
      usps.slice(0, 3).map(u => `  - ${u}`).join('\n'),
    ].join('\n'),
  );

  // ── 3. Quoted exact strings ───────────────────────────────────────────────────
  sections.push(
    [
      'EXACT TEXT TO RENDER — render every line exactly as quoted, correct script and diacritics:',
      ...quotedLines,
      '',
      'Hindi text uses Devanagari script; render it accurately with correct conjuncts.',
      'English text uses clean sans-serif.',
    ].join('\n'),
  );

  // ── 4. Reference image note ───────────────────────────────────────────────────
  if (productImageAttached) {
    sections.push(
      'REFERENCE IMAGE: The attached image shows the exact product garment. ' +
      'Use it as the central subject — preserve its silhouette, color, and embroidery detail.',
    );
  }

  // ── Style guardrails ─────────────────────────────────────────────────────────
  sections.push(
    [
      'STYLE REQUIREMENTS:',
      '- Studio product photography aesthetic, clean and professional',
      '- Luxury artisanal Indian brand look',
      '- No watermarks, no borders, no stock-photo artifacts',
      '- Colors must match the brand palette precisely',
      '- Single product only, no people',
    ].join('\n'),
  );

  return sections.join('\n\n');
}
