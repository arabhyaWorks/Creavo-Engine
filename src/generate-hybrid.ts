#!/usr/bin/env node
/**
 * Hybrid pipeline (Route B+, the CLAUDE.md default):
 *
 *   1. Gemini generates a TEXT-FREE background plate
 *      (cream texture + product garment + soft shadow — nothing else)
 *   2. Renderer composites the plate under the archetype HTML:
 *      all text is real Noto-font glyphs, logo is the real SVG
 *   3. QA verifier shows the final PNG to Gemini vision against a rubric
 *      derived from the spec; plate-level failures trigger regeneration
 *      (max 2 retries with corrections appended)
 *
 * Usage:
 *   npm run generate-hybrid -- --brief briefs/demo_krt001.json
 *
 * Env: GEMINI_API_KEY, GEMINI_IMAGE_MODEL, GEMINI_VISION_MODEL (optional)
 */

import { resolve, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import type { Brief } from './types/brief.js';
import type { BrandKit } from './types/brand.js';
import type { DesignSpec, ImageLayer } from './types/spec.js';
import { generateImage } from './gemini.js';
import { verifyImage, type QaReport } from './qa.js';
import { renderSpecObject } from './renderer.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const MAX_PLATE_RETRIES = 2;

function fatal(msg: string): never {
  console.error(`[hybrid] error: ${msg}`);
  process.exit(1);
}

function parseBriefPath(argv: string[]): string {
  const idx = argv.indexOf('--brief');
  if (idx === -1 || !argv[idx + 1]) fatal('--brief <path> is required');
  const raw = argv[idx + 1]!;
  const p = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(p)) fatal(`brief not found: ${p}`);
  return p;
}

function loadJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

function resolveFromRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(ROOT, p);
}

// ─── Plate prompt ─────────────────────────────────────────────────────────────

function buildPlatePrompt(opts: {
  brand: BrandKit;
  spec: DesignSpec;
  productDesc: string;
  hasReference: boolean;
  corrections: string[];
}): string {
  const { brand, spec, productDesc, hasReference, corrections } = opts;
  const bg     = brand.identity.palette.find(p => p.role === 'background');
  const subtle = brand.identity.palette.find(p => p.name === 'warm_cream');
  const { w, h } = spec.dimensions;

  const sections = [
    `Create a ${w}×${h} portrait EDITORIAL FASHION PHOTOGRAPH for a luxury Indian brand's ` +
    'Instagram post. Headline typography, a price line, a button and a logo will be ' +
    'composited on top later by a separate system — so the photograph itself must contain ' +
    'ABSOLUTELY NO text, NO letters, NO numbers, NO words, NO logos, NO watermarks, ' +
    'NO badges, NO buttons, NO graphic overlays. Pure photography only.',

    [
      'SCENE & COMPOSITION:',
      `- Setting: a warm ivory hand-plastered limewash wall (tones around ${bg?.hex ?? '#F5EDD6'} ` +
      `to ${subtle?.hex ?? '#EDE3C8'}) with subtle organic texture — an old Lucknow haveli feel`,
      '- The one garment: ' + productDesc,
      '- Presented ghost-mannequin / invisible-mannequin style with natural drape and slight ' +
      'movement in the fabric, photorealistic, front view, centered horizontally',
      '- WIDE SHOT with generous negative space: the garment is deliberately SMALL in frame — ' +
      'total garment height about 42% of canvas height. The shoulders begin BELOW the 30% ' +
      'height line and the hem ends ABOVE the 68% height line. Large expanses of empty wall ' +
      'above and below the garment. This is critical: do NOT fill the frame with the garment.',
      '- LIGHT: warm golden-hour sunlight raking in from the upper left, casting a soft, ' +
      'elongated natural shadow of the garment on the wall to the lower right; gentle light ' +
      'falloff toward the bottom of the frame; the embroidery catches the light',
      '- The top 28% of the canvas: only the calm textured wall in soft shadow, completely empty',
      '- The bottom 30% of the canvas: only calm wall and the soft shadow gradient, completely empty',
      '- EXACTLY ONE garment in the entire image. The background must NOT contain any faded ' +
      'garment, ghost image, watermark or echo of the product — no phantom sleeves, collars, ' +
      'buttons or hems.',
    ].join('\n'),

    [
      'STYLE:',
      '- High-end editorial fashion photography (Vogue India editorial, heritage-craft story)',
      '- Shallow, natural film-like grade; warm, rich, atmospheric — NOT a flat catalog cutout',
      '- No props, no people, no furniture, no hangers, no plants',
      '- No borders, no frames, no heavy vignettes',
    ].join('\n'),
  ];

  if (hasReference) {
    sections.push(
      'REFERENCE IMAGE: the attached image shows the exact garment (close-up). Reproduce the ' +
      'garment faithfully — silhouette, fabric color, embroidery — but place it at the SIZE and ' +
      'POSITION specified above (small in frame, wide shot). Do NOT copy the reference framing ' +
      'or zoom level, and do NOT copy any text or background from the reference.',
    );
  }

  if (corrections.length > 0) {
    sections.push(
      ['CORRECTIONS — the previous attempt failed QA, you MUST fix these:',
        ...corrections.map(c => `- ${c}`)].join('\n'),
    );
  }

  return sections.join('\n\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) fatal('GEMINI_API_KEY env var is not set');

  const imageModel  = process.env['GEMINI_IMAGE_MODEL'] ?? 'gemini-2.5-flash-image';
  const visionModel = process.env['GEMINI_VISION_MODEL'] ?? 'gemini-2.5-flash';

  const brief = loadJson<Brief>(parseBriefPath(process.argv.slice(2)));

  const brandPath = resolveFromRoot(`brands/${brief.brand_id}/brand.json`);
  if (!existsSync(brandPath)) fatal(`brand not found: ${brandPath}`);
  const brand = loadJson<BrandKit>(brandPath);

  const product = brand.products.find(p => p.sku === brief.sku);
  if (!product) fatal(`sku ${brief.sku} not found in brand ${brief.brand_id}`);
  if (product.stock_state === 'OUT_OF_STOCK') fatal(`sku ${brief.sku} is OUT_OF_STOCK`);

  const specPath = resolveFromRoot(`brands/${brief.brand_id}/specs/${brief.archetype_id}.json`);
  if (!existsSync(specPath)) fatal(`spec not found: ${specPath}`);
  const baseSpec = loadJson<DesignSpec>(specPath);

  const postId = brief.post_id ?? `${brief.brand_id}.${brief.archetype_id}.${brief.sku}.${Date.now()}`;
  const outDir = resolve(ROOT, 'output', postId);
  mkdirSync(outDir, { recursive: true });

  console.log(`[hybrid] post_id      : ${postId}`);
  console.log(`[hybrid] image model  : ${imageModel}`);
  console.log(`[hybrid] vision model : ${visionModel}`);

  // ── Garment reference: real product photo if available, else the best prior
  //    generation of this SKU, else none (prompt describes the garment).
  const refCandidates = [
    ...product.images,
    `output/demo.product_hero.${brief.sku}.1781287987654/final.png`,
  ];
  let reference: { mimeType: string; base64: string } | null = null;
  for (const cand of refCandidates) {
    const abs = resolveFromRoot(cand);
    if (existsSync(abs) && /\.(png|jpe?g|webp)$/i.test(abs)) {
      reference = { mimeType: 'image/png', base64: (await readFile(abs)).toString('base64') };
      console.log(`[hybrid] reference    : ${cand}`);
      break;
    }
  }

  const productDesc =
    `${product.name_ml['en'] ?? product.sku} — ${product.description_ml?.['en'] ?? ''} ` +
    '(warm champagne-gold pure silk kurta with fine white hand-embroidered chikankari ' +
    'floral jaal, mandarin collar, buttoned placket)';

  // ── Generate → render → QA loop ───────────────────────────────────────────
  const { w, h } = baseSpec.dimensions;
  const corrections: string[] = [];
  let attempt = 0;
  let qa: QaReport | null = null;
  let platePrompt = '';
  let finalPath = '';

  while (attempt <= MAX_PLATE_RETRIES) {
    attempt++;
    const useReference = reference !== null && attempt <= 2; // last retry: drop reference
    platePrompt = buildPlatePrompt({
      brand,
      spec: baseSpec,
      productDesc,
      hasReference: useReference,
      corrections,
    });

    console.log(`[hybrid] attempt ${attempt}: generating plate…`);
    const gen = await generateImage({
      apiKey,
      model: imageModel,
      prompt: platePrompt,
      referenceImages: useReference && reference ? [reference] : [],
    });

    const platePath = resolve(outDir, `plate.attempt${attempt}.png`);
    const plate = await sharp(gen.imageBytes)
      .resize(w, h, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
    writeFileSync(platePath, plate);
    console.log(`[hybrid] plate        → ${platePath}`);

    // Resolved spec: plate replaces the catalog product layer (the plate carries
    // the product); text + logo layers stay for the deterministic renderer.
    const resolvedSpec: DesignSpec = {
      ...baseSpec,
      spec_version: postId,
      layers: [
        {
          id: 'plate',
          type: 'image',
          role: 'background',
          source: 'generated',
          asset_ref: platePath,
          recipe_ref: 'recipe.json',
        } satisfies ImageLayer,
        ...baseSpec.layers.filter(
          l => !(l.type === 'image' && (l as ImageLayer).source === 'catalog'),
        ),
      ],
    };
    writeFileSync(resolve(outDir, 'spec.json'), JSON.stringify(resolvedSpec, null, 2));

    console.log('[hybrid] rendering (Playwright, Noto fonts)…');
    finalPath = await renderSpecObject(resolvedSpec, outDir);
    console.log(`[hybrid] render       → ${finalPath}`);

    console.log('[hybrid] QA: Gemini vision checking rubric…');
    qa = await verifyImage({
      apiKey,
      model: visionModel,
      spec: resolvedSpec,
      imageBase64: readFileSync(finalPath).toString('base64'),
    });
    writeFileSync(resolve(outDir, 'qa.json'), JSON.stringify(qa, null, 2));

    for (const item of qa.items) {
      console.log(`[hybrid]   ${item.pass ? '✓' : '✗'} ${item.id}${item.pass ? '' : ` — ${item.note}`}`);
    }

    if (qa.verdict === 'pass') break;

    // Only plate-level failures are retryable; text glyphs are deterministic.
    const plateFailures = qa.items.filter(
      i => !i.pass && ['no_stray_text', 'product_quality', 'single_garment', 'no_collisions', 'composition'].includes(i.id),
    );
    if (plateFailures.length === 0) {
      console.warn('[hybrid] QA failed on non-plate items — not retryable here, see qa.json');
      break;
    }
    if (attempt > MAX_PLATE_RETRIES) break;
    corrections.push(...plateFailures.map(f => `${f.check} (previous failure: ${f.note})`));
    console.log(`[hybrid] QA failed — retrying plate (${attempt}/${MAX_PLATE_RETRIES + 1})`);
  }

  // ── Recipe ──────────────────────────────────────────────────────────────────
  const recipe = {
    post_id: postId,
    generated_at: new Date().toISOString(),
    route: 'hybrid',
    image_model: imageModel,
    vision_model: visionModel,
    plate_prompt: platePrompt,
    plate_attempts: attempt,
    reference_used: reference !== null,
    spec_version: postId,
    brand_id: brand.id,
    sku: brief.sku,
    qa_verdict: qa?.verdict ?? 'not_run',
  };
  writeFileSync(resolve(outDir, 'recipe.json'), JSON.stringify(recipe, null, 2));

  console.log(`[hybrid] recipe       → ${resolve(outDir, 'recipe.json')}`);
  console.log(`[hybrid] QA verdict   : ${qa?.verdict ?? 'not_run'}`);
  console.log(`[hybrid] done         → ${finalPath}`);
}

run().catch((err: unknown) => {
  console.error('[hybrid] fatal:', err);
  process.exit(1);
});
