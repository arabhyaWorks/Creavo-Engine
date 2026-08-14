/**
 * QA Verifier (CLAUDE.md architecture rule):
 * derive a rubric from the Design Spec, show the final PNG to Gemini vision,
 * and get a per-item pass/fail verdict as JSON.
 */

import type { DesignSpec, TextLayer } from './types/spec.js';
import { analyzeImages } from './gemini.js';

export interface QaItem {
  id: string;
  check: string;
  pass: boolean;
  note: string;
}

export interface QaReport {
  verdict: 'pass' | 'fail';
  items: QaItem[];
  model: string;
  checked_at: string;
}

export function buildRubric(spec: DesignSpec): Array<{ id: string; check: string }> {
  const rubric: Array<{ id: string; check: string }> = [];

  const textLayers = spec.layers.filter((l): l is TextLayer => l.type === 'text');
  for (const l of textLayers) {
    rubric.push({
      id: `text_${l.id}`,
      check:
        `The ${l.id} text on the image reads EXACTLY "${l.text}" — every character, ` +
        `conjunct and diacritic correct, no missing or malformed glyphs. ` +
        `(Letter CASE may differ — uppercase typographic styling is acceptable.)`,
    });
  }

  rubric.push(
    {
      id: 'no_stray_text',
      check:
        'The background scene (wall, surface, props) contains NO baked-in text, watermarks, ' +
        'or unwanted lettering. NOTE: text printed on the product label/packaging itself is ' +
        'expected and acceptable — do NOT flag it. Also acceptable: small UI copy directly ' +
        'adjacent to a text layer (e.g. "Incl. of all taxes", "500 ml" sub-labels).',
    },
    {
      id: 'single_garment',
      check:
        'EXACTLY ONE hero product is featured. The background props (bowls, spoons, flowers, ' +
        'seeds, fabric etc.) are atmospheric only — NOT additional product units. If there is ' +
        'one primary product plus natural scene props, this check PASSES.',
    },
    {
      id: 'product_quality',
      check:
        'A single photorealistic product garment is clearly visible, well-lit, centered in the ' +
        'middle of the canvas, not cropped at the edges, and looks like professional studio ' +
        'product photography (not a flat illustration or clipart).',
    },
    {
      id: 'no_collisions',
      check:
        'No element overlaps another: the price pill and CTA button do NOT touch or overlap ' +
        'the garment at all (clear gap between the hem and the price pill), and the logo does ' +
        'not overlap the CTA button.',
    },
    {
      id: 'composition',
      check:
        'Overall the post reads as premium editorial fashion content — photographic depth, ' +
        'natural light and shadow, elegant typography — and NOT like a flat generic web ' +
        'banner or template. Balanced spacing, clear hierarchy, no artifacts, no garbled regions.',
    },
  );

  return rubric;
}

function extractJson(text: string): unknown {
  // Strip markdown fences if present, then take the outermost JSON array/object
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.search(/[[{]/);
  if (start === -1) throw new Error(`QA response is not JSON: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start));
}

export async function verifyImage(opts: {
  apiKey: string;
  model: string;
  spec: DesignSpec;
  imageBase64: string;
  mimeType?: string;
}): Promise<QaReport> {
  const { apiKey, model, spec, imageBase64, mimeType = 'image/png' } = opts;
  const rubric = buildRubric(spec);

  const prompt = [
    'You are a meticulous design QA reviewer for an Indian D2C brand. ',
    'Inspect the attached social media post image against each rubric item. ',
    'Read all Devanagari text character by character — spelling mistakes and dropped ',
    'conjuncts (halant clusters) are automatic failures.',
    '',
    'RUBRIC:',
    ...rubric.map(r => `- id "${r.id}": ${r.check}`),
    '',
    'Respond with ONLY a JSON array, one object per rubric item:',
    '[{"id": "...", "pass": true|false, "note": "short reason, quote any wrong text you see"}]',
  ].join('\n');

  const responseText = await analyzeImages({
    apiKey,
    model,
    prompt,
    images: [{ mimeType, base64: imageBase64 }],
  });

  const parsed = extractJson(responseText) as Array<{ id: string; pass: boolean; note?: string }>;

  const items: QaItem[] = rubric.map(r => {
    const found = parsed.find(p => p.id === r.id);
    return {
      id: r.id,
      check: r.check,
      pass: found?.pass ?? false,
      note: found?.note ?? (found ? '' : 'missing from QA response'),
    };
  });

  return {
    verdict: items.every(i => i.pass) ? 'pass' : 'fail',
    items,
    model,
    checked_at: new Date().toISOString(),
  };
}
