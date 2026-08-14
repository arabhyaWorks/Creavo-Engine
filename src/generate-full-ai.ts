#!/usr/bin/env node
/**
 * Full-AI pipeline — zero HTML templates.
 *
 * Two Design Thinker agents run IN PARALLEL:
 *   A) GPT-4o   analyses product + logo → writes image gen prompt
 *   B) Gemini Flash analyses product + logo → writes image gen prompt
 *
 * Both prompts go to the SAME Gemini image model.
 * Outputs: final_gpt.png, final_gemini.png, compare.png, report.json
 *
 * Usage:
 *   npm run generate-full-ai -- --brief briefs/rosier_ghe001.json
 *
 * Env:
 *   GEMINI_API_KEY, GEMINI_IMAGE_MODEL, GEMINI_VISION_MODEL
 *   OPENAI_API_KEY, OPENAI_DESIGN_MODEL
 */

import { resolve, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import type { Brief }    from './types/brief.js';
import type { BrandKit } from './types/brand.js';
import type { DesignSpec } from './types/spec.js';
import { generateImage }  from './gemini.js';
import { thinkWithGPT, thinkWithGemini, type DesignThinkingInput, type DesignThinkingOutput } from './design-thinker.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

function fatal(msg: string): never { console.error(`[full-ai] ❌ ${msg}`); process.exit(1); }

function parseBriefPath(argv: string[]): string {
  const idx = argv.indexOf('--brief');
  if (idx === -1 || !argv[idx + 1]) fatal('--brief <path> is required');
  const raw = argv[idx + 1]!;
  const p = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(p)) fatal(`brief not found: ${p}`);
  return p;
}

function loadJson<T>(p: string): T { return JSON.parse(readFileSync(p, 'utf8')) as T; }
function abs(p: string) { return isAbsolute(p) ? p : resolve(ROOT, p); }

async function toBase64(path: string): Promise<{ base64: string; mimeType: 'image/png' | 'image/jpeg' }> {
  const buf = await readFile(path);
  const ext = path.split('.').pop()?.toLowerCase() ?? 'jpg';
  return { base64: buf.toString('base64'), mimeType: ext === 'png' ? 'image/png' : 'image/jpeg' };
}

// ─── QA (lightweight text check only — vision QA on full-AI is advisory) ─────

async function visionCheck(opts: {
  apiKey: string; model: string;
  imageBase64: string; expectedTexts: string[];
}): Promise<{ score: number; notes: string[] }> {
  const { apiKey, model, imageBase64, expectedTexts } = opts;
  const { analyzeImages } = await import('./gemini.js');

  const prompt = [
    'Evaluate this social media post image as a senior art director. For each question reply pass/fail + one sentence.',
    '',
    ...expectedTexts.map((t, i) => `Q${i + 1}: Is the text "${t}" clearly visible and correctly spelled/rendered?`),
    `Q${expectedTexts.length + 1}: Is the product the clear hero of the image (photorealistic, well-lit, not illustrated)?`,
    `Q${expectedTexts.length + 2}: Does the overall composition look premium and editorial, not generic or template-like?`,
    `Q${expectedTexts.length + 3}: Is the layout balanced with good visual hierarchy (brand → product → price → CTA)?`,
    '',
    'Respond as JSON: { "results": [{"q": "Q1", "pass": true, "note": "..."},...], "score": <0-10> }',
  ].join('\n');

  try {
    const raw = await analyzeImages({ apiKey, model, prompt, images: [{ mimeType: 'image/png', base64: imageBase64 }] });
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}') + 1;
    const parsed = JSON.parse(raw.slice(start, end)) as { results: Array<{ q: string; pass: boolean; note: string }>; score: number };
    const notes = parsed.results.filter(r => !r.pass).map(r => `${r.q}: ${r.note}`);
    return { score: parsed.score ?? 0, notes };
  } catch {
    return { score: 0, notes: ['QA parse error'] };
  }
}

// ─── Side-by-side comparison image ───────────────────────────────────────────

async function makeComparison(pathA: string, pathB: string, labelA: string, labelB: string): Promise<Buffer> {
  const gap = 24;
  const labelH = 0; // keep it clean, labels go in report.json
  const [bufA, bufB] = await Promise.all([
    sharp(pathA).png().toBuffer(),
    sharp(pathB).png().toBuffer(),
  ]);
  const mA = await sharp(bufA).metadata();
  const mB = await sharp(bufB).metadata();
  const w = (mA.width ?? 1080) + gap + (mB.width ?? 1080);
  const h = Math.max(mA.height ?? 1350, mB.height ?? 1350) + labelH;

  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 18, g: 18, b: 18 } },
  }).png().composite([
    { input: bufA, left: 0,                                top: labelH },
    { input: bufB, left: (mA.width ?? 1080) + gap,        top: labelH },
  ]).png().toBuffer();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const geminiKey = process.env['GEMINI_API_KEY'];
  const openaiKey = process.env['OPENAI_API_KEY'];
  if (!geminiKey) fatal('GEMINI_API_KEY not set');

  const imageModel  = process.env['GEMINI_IMAGE_MODEL']  ?? 'gemini-2.5-flash-image';
  const visionModel = process.env['GEMINI_VISION_MODEL'] ?? 'gemini-2.5-flash';
  const oaiModel    = process.env['OPENAI_DESIGN_MODEL'] ?? 'gpt-4o';
  const gflashModel = visionModel; // Gemini Flash for design thinking

  const brief   = loadJson<Brief>(parseBriefPath(process.argv.slice(2)));
  const brandPath = abs(`brands/${brief.brand_id}/brand.json`);
  if (!existsSync(brandPath)) fatal(`brand not found: ${brandPath}`);
  const brand = loadJson<BrandKit>(brandPath);

  const specPath = abs(`brands/${brief.brand_id}/specs/${brief.archetype_id}.json`);
  const baseSpec = existsSync(specPath) ? loadJson<DesignSpec>(specPath) : null;
  const { w, h } = baseSpec?.dimensions ?? { w: 1080, h: 1350 };

  const product = brand.products.find(p => p.sku === brief.sku);
  if (!product) fatal(`sku ${brief.sku} not found`);
  if (product.stock_state === 'OUT_OF_STOCK') fatal('product is OUT_OF_STOCK');

  const postId = `${brief.brand_id}.full_ai.${brief.sku}.${Date.now()}`;
  const outDir = resolve(ROOT, 'output', postId);
  mkdirSync(outDir, { recursive: true });

  console.log(`\n[full-ai] post_id      : ${postId}`);
  console.log(`[full-ai] image model  : ${imageModel}`);
  console.log(`[full-ai] design A     : GPT-4o (${oaiModel})`);
  console.log(`[full-ai] design B     : Gemini Flash (${gflashModel})`);

  // ── Load images ────────────────────────────────────────────────────────────
  const productImgPath = abs(product.images[0] ?? '');
  if (!existsSync(productImgPath)) fatal(`product image not found: ${productImgPath}`);
  const logoPath = abs(brand.identity.logo_assets.dark ?? brand.identity.logo_assets.png ?? '');
  if (!existsSync(logoPath)) fatal(`logo not found: ${logoPath}`);

  const [productImg, logoImg] = await Promise.all([toBase64(productImgPath), toBase64(logoPath)]);

  const thinkingInput: DesignThinkingInput = {
    brand,
    productName: product.name_ml[brief.language] ?? product.name_ml['en'] ?? product.sku,
    productDesc: product.description_ml?.[brief.language] ?? product.description_ml?.['en'] ?? '',
    priceFormatted: `₹${product.price.toLocaleString('en-IN')}`,
    rating: String(product.rating ?? '4.9'),
    reviewCount: (product.review_count ?? 0).toLocaleString('en-IN'),
    keyClaim: product.key_claim ?? brand.usps[0] ?? '',
    size: product.size ?? '',
    canvasW: w,
    canvasH: h,
    language: (brief.language === 'hi' ? 'hi' : 'en') as 'en' | 'hi',
    productImageBase64: productImg.base64,
    productMimeType: productImg.mimeType,
    logoBase64: logoImg.base64,
    logoMimeType: logoImg.mimeType,
  };

  // ── Step 1: Run both design thinkers IN PARALLEL ──────────────────────────
  console.log('\n[full-ai] ⟳  design thinking (GPT-4o + Gemini Flash in parallel)…');

  const [thinkA, thinkB] = await Promise.allSettled([
    openaiKey
      ? thinkWithGPT({ apiKey: openaiKey, model: oaiModel, input: thinkingInput })
      : Promise.reject(new Error('OPENAI_API_KEY not set — skipping GPT version')),
    thinkWithGemini({ apiKey: geminiKey, model: gflashModel, input: thinkingInput }),
  ]);

  const resultA = thinkA.status === 'fulfilled' ? thinkA.value : null;
  const resultB = thinkB.status === 'fulfilled' ? thinkB.value : null;

  if (thinkA.status === 'rejected') console.warn(`[full-ai] ⚠  GPT skipped: ${thinkA.reason}`);
  if (thinkB.status === 'rejected') fatal(`Gemini design thinking failed: ${thinkB.reason}`);

  if (resultA) {
    writeFileSync(resolve(outDir, 'prompt_gpt.txt'), resultA.prompt);
    console.log(`[full-ai] GPT rationale : ${resultA.rationale}`);
  }
  writeFileSync(resolve(outDir, 'prompt_gemini.txt'), resultB!.prompt);
  console.log(`[full-ai] Gemini rationale : ${resultB!.rationale}`);

  // ── Step 2: Generate images IN PARALLEL ───────────────────────────────────
  console.log('\n[full-ai] ⟳  image generation (both prompts in parallel)…');

  const versions: Array<{ label: string; design: DesignThinkingOutput; filename: string }> = [];
  if (resultA) versions.push({ label: 'GPT-4o',        design: resultA, filename: 'final_gpt.png' });
  if (resultB) versions.push({ label: 'Gemini Flash',  design: resultB, filename: 'final_gemini.png' });

  const generated = await Promise.allSettled(
    versions.map(async ({ label, design, filename }) => {
      console.log(`[full-ai]   → generating (${label})…`);
      const gen = await generateImage({
        apiKey: geminiKey,
        model: imageModel,
        prompt: design.prompt,
        referenceImages: [productImg, logoImg],
      });
      const finalBuf = await sharp(gen.imageBytes)
        .resize(w, h, { fit: 'cover', position: 'centre' })
        .png()
        .toBuffer();
      const finalPath = resolve(outDir, filename);
      writeFileSync(finalPath, finalBuf);
      console.log(`[full-ai]   ✓ ${label} → ${filename}`);
      return { label, filename, finalPath, finalBuf };
    })
  );

  const successfulVersions = generated
    .filter((r): r is PromiseFulfilledResult<{ label: string; filename: string; finalPath: string; finalBuf: Buffer }> => r.status === 'fulfilled')
    .map(r => r.value);

  if (successfulVersions.length === 0) fatal('Both image generations failed');

  // ── Step 3: QA both IN PARALLEL ───────────────────────────────────────────
  console.log('\n[full-ai] ⟳  QA vision check (both in parallel)…');
  const expectedTexts = [
    product.name_ml[brief.language] ?? product.name_ml['en'] ?? '',
    `₹${product.price.toLocaleString('en-IN')}`,
    'Shop Now',
  ].filter(Boolean);

  const qaResults = await Promise.all(
    successfulVersions.map(async ({ label, finalPath }) => {
      const imageBase64 = readFileSync(finalPath).toString('base64');
      const qa = await visionCheck({ apiKey: geminiKey, model: visionModel, imageBase64, expectedTexts });
      console.log(`[full-ai]   ${label}: score ${qa.score}/10${qa.notes.length ? ' — ' + qa.notes.join('; ') : ' ✓'}`);
      return { label, ...qa };
    })
  );

  // ── Step 4: Side-by-side comparison ───────────────────────────────────────
  if (successfulVersions.length === 2) {
    const compare = await makeComparison(
      successfulVersions[0].finalPath,
      successfulVersions[1].finalPath,
      successfulVersions[0].label,
      successfulVersions[1].label,
    );
    writeFileSync(resolve(outDir, 'compare.png'), compare);
    console.log(`\n[full-ai] compare      → compare.png`);
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const report = {
    post_id: postId,
    generated_at: new Date().toISOString(),
    route: 'full_ai',
    image_model: imageModel,
    versions: successfulVersions.map(v => {
      const qa = qaResults.find(q => q.label === v.label);
      const design = versions.find(vv => vv.label === v.label)?.design;
      return {
        label: v.label,
        design_model: design?.model ?? '',
        rationale: design?.rationale ?? '',
        prompt_file: v.label === 'GPT-4o' ? 'prompt_gpt.txt' : 'prompt_gemini.txt',
        output_file: v.filename,
        qa_score: qa?.score ?? 0,
        qa_notes: qa?.notes ?? [],
      };
    }),
  };
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`[full-ai] report       → report.json`);

  const winner = [...qaResults].sort((a, b) => b.score - a.score)[0];
  console.log(`\n[full-ai] ★  Higher QA score: ${winner?.label ?? '—'} (${winner?.score ?? 0}/10)`);
  console.log(`[full-ai] done         → output/${postId}/\n`);
}

run().catch((err: unknown) => { console.error('[full-ai] fatal:', err); process.exit(1); });
