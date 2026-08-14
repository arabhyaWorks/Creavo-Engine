#!/usr/bin/env node
/**
 * Compose pipeline:
 *
 *   1. Gemini vision analyses the real product image → composition brief
 *   2. Gemini generates a TEXT-FREE atmospheric background SCENE (no jar)
 *   3. Sharp removes the white studio background from the real product image
 *   4. Sharp composites: scene + drop-shadow + real product = plate
 *   5. Renderer composites the plate under HTML text layers (Noto/Cormorant fonts)
 *   6. Gemini vision QA loop (max 2 retries on scene failures)
 *   7. Logo composited by sharp
 *
 * Usage:
 *   npm run generate-compose -- --brief briefs/rosier_ghe001.json
 */

import { resolve, isAbsolute } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import type { Brief } from './types/brief.js';
import type { BrandKit } from './types/brand.js';
import type { DesignSpec, ImageLayer, TextLayer } from './types/spec.js';
import { generateImage, analyzeImages } from './gemini.js';
import { verifyImage, type QaReport } from './qa.js';
import { renderSpecObject } from './renderer.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const MAX_RETRIES = 2;

function fatal(msg: string): never { console.error(`[compose] error: ${msg}`); process.exit(1); }

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

// ─── Step 1: Gemini vision reads the product image → scene brief ──────────────

async function analyseProduct(opts: {
  apiKey: string; visionModel: string;
  productBase64: string; brand: BrandKit;
}): Promise<{ scene: string; productZone: string; lighting: string }> {
  const { apiKey, visionModel, productBase64, brand } = opts;
  const bg   = brand.identity.palette.find(p => p.role === 'background');
  const acc  = brand.identity.palette.find(p => p.role === 'primary');

  const prompt = `You are a premium food photography art director.

Analyse this product image and return a JSON object with exactly these keys:
{
  "scene": "One paragraph describing the ideal atmospheric background SCENE to place this product in. Include: surface material (wood/stone/marble), props (herbs, flowers, bowls, fabric, seeds), background (blurred bokeh / textured wall), color mood matching ${bg?.hex ?? '#FAF9F6'} off-white and ${acc?.hex ?? '#FFD800'} golden tones, and golden soft-diffused natural sidelight. The scene should NOT contain the product itself — only the environment and props.",
  "productZone": "Describe the ideal position for this jar in the scene: e.g. center-frame on a wooden board, slightly right-of-center on stone",
  "lighting": "Describe the exact lighting setup: angle, quality, color temperature, shadow direction"
}

Respond with ONLY the JSON object, no markdown.`;

  const text = await analyzeImages({
    apiKey, model: visionModel, prompt,
    images: [{ mimeType: 'image/jpeg', base64: productBase64 }],
  });

  try {
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}') + 1;
    return JSON.parse(text.slice(start, end)) as { scene: string; productZone: string; lighting: string };
  } catch {
    return {
      scene: 'A rustic weathered wooden surface with soft linen cloth, scattered mustard seeds and dried herbs, a small copper bowl with golden ghee, warm golden bokeh background of a pastoral farm',
      productZone: 'center-frame on the wooden surface',
      lighting: 'Warm golden-hour sidelight from upper-left, soft diffused, rich warm color temperature'
    };
  }
}

// ─── Step 2: Build scene-only prompt (NO product) ─────────────────────────────

function buildScenePrompt(opts: {
  brand: BrandKit; w: number; h: number;
  scene: string; lighting: string; corrections: string[];
}): string {
  const { brand, w, h, scene, lighting, corrections } = opts;

  const sections = [
    `Create a ${w}×${h} portrait BACKGROUND SCENE for a premium artisan food brand Instagram post. ` +
    'This scene is a BACKGROUND ONLY — a product jar and all text will be composited on top later. ' +
    'The scene must contain ABSOLUTELY NO text, NO letters, NO numbers, NO jars, NO bottles, ' +
    'NO products, NO logos, NO watermarks, NO badges. ONLY the atmospheric setting.',

    `SCENE: ${scene}`,
    `LIGHTING: ${lighting}`,

    [
      'COMPOSITION RULES:',
      '- The center 50% of the canvas (horizontal center, vertical middle) must be a relatively CALM zone — ' +
      'no busy props or high contrast, so the product jar can be composited there cleanly',
      '- Generous negative space in the center — props and details around the edges/foreground',
      '- Top 30%: softly lit background wall/bokeh — calm enough for headline text overlay',
      '- Bottom 25%: surface only, slightly darker — calm enough for price and CTA overlay',
    ].join('\n'),

    [
      'STYLE:',
      `- Premium artisan food photography, ${brand.voice.tone_words.join(', ')}`,
      '- Warm golden and earthy tones — no cool blues, no stark whites',
      '- Soft depth of field, painterly quality, editorial richness',
      '- No people, no hands, no text, no labels',
    ].join('\n'),
  ];

  if (corrections.length > 0) {
    sections.push('CORRECTIONS from previous attempt — you MUST fix:\n' + corrections.map(c => `- ${c}`).join('\n'));
  }

  return sections.join('\n\n');
}

// ─── Step 3: Remove white background from product image ───────────────────────

async function removeWhiteBackground(
  inputPath: string,
  threshold = 242
): Promise<Buffer> {
  const img = sharp(inputPath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  const ch = info.channels as number;

  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * ch + 0];
    const g = data[i * ch + 1];
    const b = data[i * ch + 2];
    const a = ch === 4 ? data[i * ch + 3] : 255;
    out[i * 4 + 0] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    // near-white pixels → transparent; keep original alpha otherwise
    out[i * 4 + 3] = (r > threshold && g > threshold && b > threshold) ? 0 : a;
  }

  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

// ─── Step 4: Composite product onto scene ─────────────────────────────────────

async function compositeProductOnScene(opts: {
  sceneBuffer: Buffer; productPath: string;
  canvasW: number; canvasH: number;
}): Promise<Buffer> {
  const { sceneBuffer, productPath, canvasW, canvasH } = opts;

  // Remove white background
  const productCutout = await removeWhiteBackground(productPath);
  const meta = await sharp(productCutout).metadata();
  const srcW = meta.width ?? 600;
  const srcH = meta.height ?? 600;

  // Target: product height = 48% of canvas, placed in center with bottom at 76%
  const targetH = Math.round(canvasH * 0.48);
  const targetW = Math.round(srcW * (targetH / srcH));

  const resized = await sharp(productCutout)
    .resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Center the product horizontally, bottom at 76% of canvas
  const left = Math.round((canvasW - targetW) / 2);
  const top  = Math.round(canvasH * 0.76) - targetH;

  // Shadow: blur a dark version of the cutout
  const shadow = await sharp(productCutout)
    .resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .tint({ r: 30, g: 15, b: 0 })
    .blur(22)
    .modulate({ brightness: 0.15 })
    .png()
    .toBuffer();

  const shadowLeft = left + 12;
  const shadowTop  = top  + 20;

  return sharp(sceneBuffer)
    .composite([
      { input: shadow,  left: shadowLeft, top: shadowTop,  blend: 'multiply' },
      { input: resized, left,             top,             blend: 'over' },
    ])
    .png()
    .toBuffer();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) fatal('GEMINI_API_KEY env var not set');

  const imageModel  = process.env['GEMINI_IMAGE_MODEL']  ?? 'gemini-2.5-flash-image';
  const visionModel = process.env['GEMINI_VISION_MODEL'] ?? 'gemini-2.5-flash';

  const brief   = loadJson<Brief>(parseBriefPath(process.argv.slice(2)));
  const brandPath = abs(`brands/${brief.brand_id}/brand.json`);
  if (!existsSync(brandPath)) fatal(`brand not found: ${brandPath}`);
  const brand = loadJson<BrandKit>(brandPath);

  const product = brand.products.find(p => p.sku === brief.sku);
  if (!product) fatal(`sku ${brief.sku} not found`);
  if (product.stock_state === 'OUT_OF_STOCK') fatal(`sku ${brief.sku} is OUT_OF_STOCK`);

  const specPath = abs(`brands/${brief.brand_id}/specs/${brief.archetype_id}.json`);
  if (!existsSync(specPath)) fatal(`spec not found: ${specPath}`);
  const baseSpec = loadJson<DesignSpec>(specPath);

  const postId = brief.post_id ?? `${brief.brand_id}.${brief.archetype_id}.${brief.sku}.${Date.now()}`;
  const outDir = resolve(ROOT, 'output', postId);
  mkdirSync(outDir, { recursive: true });

  console.log(`[compose] post_id      : ${postId}`);
  console.log(`[compose] image model  : ${imageModel}`);
  console.log(`[compose] vision model : ${visionModel}`);

  const { w, h } = baseSpec.dimensions;
  const productImgPath = abs(product.images[0] ?? '');
  if (!existsSync(productImgPath)) fatal(`product image not found: ${productImgPath}`);

  const productBase64 = (await readFile(productImgPath)).toString('base64');

  // ── Step 1: Vision analysis of real product ───────────────────────────────
  console.log('[compose] vision: analysing product image…');
  const analysis = await analyseProduct({ apiKey, visionModel, productBase64, brand });
  console.log(`[compose] scene brief  : ${analysis.scene.slice(0, 80)}…`);
  writeFileSync(resolve(outDir, 'analysis.json'), JSON.stringify(analysis, null, 2));

  // ── Generate → composite → render → QA loop ──────────────────────────────
  const corrections: string[] = [];
  let attempt = 0;
  let qa: QaReport | null = null;
  let finalPath = '';
  let scenePrompt = '';

  while (attempt <= MAX_RETRIES) {
    attempt++;
    scenePrompt = buildScenePrompt({ brand, w, h, scene: analysis.scene, lighting: analysis.lighting, corrections });

    console.log(`[compose] attempt ${attempt}: generating scene…`);
    const gen = await generateImage({ apiKey, model: imageModel, prompt: scenePrompt });

    const sceneBuffer = await sharp(gen.imageBytes)
      .resize(w, h, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();

    writeFileSync(resolve(outDir, `scene.attempt${attempt}.png`), sceneBuffer);
    console.log(`[compose] scene        → scene.attempt${attempt}.png`);

    // ── Step 3+4: Remove white BG + composite real product ─────────────────
    console.log('[compose] compositing real product onto scene…');
    const plateBuffer = await compositeProductOnScene({ sceneBuffer, productPath: productImgPath, canvasW: w, canvasH: h });
    const platePath   = resolve(outDir, `plate.attempt${attempt}.png`);
    writeFileSync(platePath, plateBuffer);
    console.log(`[compose] plate        → plate.attempt${attempt}.png`);

    // ── Build resolved spec (replace catalog layer with composite plate) ───
    // Map spec text layers to template slots, including 'claim' and 'rating'
    const textLayers   = baseSpec.layers.filter((l): l is TextLayer => l.type === 'text');
    const claimLayer   = textLayers.find(l => l.id === 'claim');
    const ratingLayer  = textLayers.find(l => l.id === 'rating');

    const resolvedSpec: DesignSpec = {
      ...baseSpec,
      spec_version: postId,
      layers: [
        {
          id: 'plate', type: 'image', role: 'background', source: 'generated',
          asset_ref: platePath,
        } satisfies ImageLayer,
        ...baseSpec.layers.filter(l => !(l.type === 'image' && (l as ImageLayer).source === 'catalog')),
        // inject claim + rating into spec if present in brand data
        ...(claimLayer ? [] : [{
          id: 'claim', type: 'text' as const,
          text: product.key_claim ?? brand.usps[0] ?? '',
          lang: 'en', font: 'NotoSans', size_px: 28, color: '#FFD800',
        } satisfies TextLayer]),
        ...(ratingLayer ? [] : [{
          id: 'rating', type: 'text' as const,
          text: `★★★★★  ${product.rating ?? '4.9'}  ·  ${product.review_count?.toLocaleString() ?? '1,017'} Reviews`,
          lang: 'en', font: 'NotoSans', size_px: 28, color: '#FAF9F6',
        } satisfies TextLayer]),
      ],
    };
    writeFileSync(resolve(outDir, 'spec.json'), JSON.stringify(resolvedSpec, null, 2));

    console.log('[compose] rendering text layers…');
    finalPath = await renderSpecObject(resolvedSpec, outDir);
    console.log(`[compose] render       → ${finalPath}`);

    // ── Logo composite (top-right) ─────────────────────────────────────────
    const logoLayer = baseSpec.layers.find((l): l is ImageLayer => l.type === 'image' && (l as ImageLayer).source === 'brand_asset');
    if (logoLayer?.asset_ref) {
      const logoAbs  = abs(logoLayer.asset_ref);
      const maxH     = logoLayer.max_h_px ?? 80;
      const margin   = logoLayer.margin_px ?? 52;
      const anchor   = logoLayer.anchor ?? 'top_right';

      if (existsSync(logoAbs)) {
        const logoResized = await sharp(logoAbs).resize(null, maxH).png().toBuffer();
        const lMeta = await sharp(logoResized).metadata();
        const lW = lMeta.width ?? 160;
        const lH = lMeta.height ?? maxH;

        let lLeft = w - lW - margin;
        let lTop  = margin;
        if (anchor === 'bottom_right') { lTop = h - lH - margin; }
        if (anchor === 'bottom_left')  { lLeft = margin; lTop = h - lH - margin; }
        if (anchor === 'top_left')     { lLeft = margin; }

        const withLogo = await sharp(finalPath)
          .composite([{ input: logoResized, left: lLeft, top: lTop }])
          .png()
          .toBuffer();
        writeFileSync(finalPath, withLogo);
        console.log(`[compose] logo         → composited at (${lLeft},${lTop})`);
      }
    }

    // ── QA ─────────────────────────────────────────────────────────────────
    console.log('[compose] QA: checking rubric…');
    qa = await verifyImage({
      apiKey, model: visionModel, spec: resolvedSpec,
      imageBase64: readFileSync(finalPath).toString('base64'),
    });
    writeFileSync(resolve(outDir, 'qa.json'), JSON.stringify(qa, null, 2));

    for (const item of qa.items) {
      console.log(`[compose]   ${item.pass ? '✓' : '✗'} ${item.id}${item.pass ? '' : ` — ${item.note}`}`);
    }

    if (qa.verdict === 'pass') break;

    const sceneFailures = qa.items.filter(i =>
      !i.pass && ['no_stray_text','product_quality','single_garment','no_collisions','composition'].includes(i.id));
    if (sceneFailures.length === 0 || attempt > MAX_RETRIES) break;
    corrections.push(...sceneFailures.map(f => `${f.id}: ${f.note}`));
    console.log(`[compose] QA failed — retrying scene (${attempt}/${MAX_RETRIES + 1})`);
  }

  const recipe = {
    post_id: postId,
    generated_at: new Date().toISOString(),
    route: 'compose',
    image_model: imageModel,
    vision_model: visionModel,
    scene_attempts: attempt,
    brand_id: brand.id,
    sku: brief.sku,
    qa_verdict: qa?.verdict ?? 'not_run',
  };
  writeFileSync(resolve(outDir, 'recipe.json'), JSON.stringify(recipe, null, 2));

  console.log(`[compose] QA verdict   : ${qa?.verdict ?? 'not_run'}`);
  console.log(`[compose] done         → ${finalPath}`);
}

run().catch((err: unknown) => { console.error('[compose] fatal:', err); process.exit(1); });
