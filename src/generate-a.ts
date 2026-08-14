#!/usr/bin/env node
/**
 * Route A CLI — Gemini image generation pipeline
 *
 * Usage:
 *   npm run generate-a -- --brief <path-to-brief.json>
 *
 * Example:
 *   npm run generate-a -- --brief briefs/demo_krt001.json
 *
 * Required env vars:
 *   GEMINI_API_KEY
 *   GEMINI_IMAGE_MODEL  (optional, defaults to gemini-2.0-flash-preview-image-generation)
 */

import { resolve, isAbsolute, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import type { Brief } from './types/brief.js';
import type { BrandKit } from './types/brand.js';
import type { DesignSpec, ImageLayer } from './types/spec.js';
import { generateImage } from './gemini.js';
import { assemblePrompt } from './prompt-assembler.js';

// ---------------------------------------------------------------------------

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

function fatal(msg: string): never {
  console.error(`[generate-a] error: ${msg}`);
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

async function toBase64(filePath: string): Promise<{ base64: string; mimeType: string } | null> {
  const abs = resolveFromRoot(filePath);
  if (!existsSync(abs)) return null;
  const buf = await readFile(abs);
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return { base64: buf.toString('base64'), mimeType: mimeMap[ext] ?? 'image/png' };
}

// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) fatal('GEMINI_API_KEY env var is not set');

  const model =
    process.env['GEMINI_IMAGE_MODEL'] ?? 'gemini-2.0-flash-preview-image-generation';

  const briefPath = parseBriefPath(process.argv.slice(2));
  const brief = loadJson<Brief>(briefPath);

  // ── Load brand and spec ──────────────────────────────────────────────────
  const brandPath = resolveFromRoot(`brands/${brief.brand_id}/brand.json`);
  if (!existsSync(brandPath)) fatal(`brand not found: ${brandPath}`);
  const brand = loadJson<BrandKit>(brandPath);

  const product = brand.products.find(p => p.sku === brief.sku);
  if (!product) fatal(`sku ${brief.sku} not found in brand ${brief.brand_id}`);
  if (product.stock_state === 'OUT_OF_STOCK') {
    fatal(`sku ${brief.sku} is OUT_OF_STOCK — cannot promote`);
  }

  const specPath = resolveFromRoot(`brands/${brief.brand_id}/specs/${brief.archetype_id}.json`);
  if (!existsSync(specPath)) fatal(`spec not found: ${specPath}`);
  const spec = loadJson<DesignSpec>(specPath);

  // ── Post ID and output dir ───────────────────────────────────────────────
  const postId =
    brief.post_id ?? `${brief.brand_id}.${brief.archetype_id}.${brief.sku}.${Date.now()}`;
  const outDir = resolve(ROOT, 'output', postId);
  mkdirSync(outDir, { recursive: true });

  console.log(`[generate-a] post_id  : ${postId}`);
  console.log(`[generate-a] model    : ${model}`);

  // ── Reference images (product cutout) ────────────────────────────────────
  const refImages: Array<{ mimeType: string; base64: string }> = [];
  for (const imgPath of product.images) {
    const ref = await toBase64(imgPath);
    if (ref) {
      refImages.push(ref);
      console.log(`[generate-a] attached : ${imgPath}`);
    } else {
      console.warn(`[generate-a] warn     : product image not found: ${imgPath}`);
    }
  }

  // ── Build prompt ─────────────────────────────────────────────────────────
  const prompt = assemblePrompt({
    spec,
    brand,
    productImageAttached: refImages.length > 0,
  });

  console.log('[generate-a] prompt assembled');

  // ── Call Gemini ───────────────────────────────────────────────────────────
  console.log('[generate-a] calling Gemini…');
  const genResult = await generateImage({
    apiKey,
    model,
    prompt,
    referenceImages: refImages,
  });

  console.log('[generate-a] image received');

  // ── Save recipe ───────────────────────────────────────────────────────────
  const recipe = {
    post_id: postId,
    generated_at: new Date().toISOString(),
    model,
    prompt,
    reference_images: product.images,
    spec_version: spec.spec_version,
    brand_id: brand.id,
    sku: brief.sku,
    mimeType: genResult.mimeType,
  };
  const recipePath = resolve(outDir, 'recipe.json');
  writeFileSync(recipePath, JSON.stringify(recipe, null, 2));
  console.log(`[generate-a] recipe   → ${recipePath}`);

  // ── Normalise generated image to spec dimensions ──────────────────────────
  const { w, h } = spec.dimensions;
  const normalised = await sharp(genResult.imageBytes)
    .resize(w, h, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  // ── Composite logo ────────────────────────────────────────────────────────
  const logoLayer = spec.layers.find(
    (l): l is ImageLayer =>
      l.type === 'image' && (l as ImageLayer).source === 'brand_asset',
  );

  let finalBuffer = normalised;

  if (logoLayer?.asset_ref) {
    const logoAbs = resolveFromRoot(logoLayer.asset_ref);
    const margin = logoLayer.margin_px ?? 52;
    const maxH   = logoLayer.max_h_px  ?? 72;

    if (existsSync(logoAbs)) {
      // Resize SVG logo to max height, preserving aspect ratio
      const logoResized = await sharp(logoAbs)
        .resize(null, maxH)
        .png()
        .toBuffer();

      const logoMeta = await sharp(logoResized).metadata();
      const logoW = logoMeta.width  ?? 0;
      const logoH = logoMeta.height ?? maxH;

      // Anchor: bottom_right (default from spec)
      const left = w - logoW - margin;
      const top  = h - logoH - margin;

      finalBuffer = await sharp(normalised)
        .composite([{ input: logoResized, left, top }])
        .png()
        .toBuffer();

      console.log(`[generate-a] logo     → composited at (${left}, ${top})`);
    } else {
      console.warn(`[generate-a] warn     : logo not found at ${logoAbs}`);
    }
  }

  // ── Save final.png ────────────────────────────────────────────────────────
  const finalPath = resolve(outDir, 'final.png');
  writeFileSync(finalPath, finalBuffer);
  console.log(`[generate-a] done     → ${finalPath}`);
}

run().catch((err: unknown) => {
  console.error('[generate-a] fatal:', err);
  process.exit(1);
});
