import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesignSpec } from './types/spec.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildFontFaceCSS(): string {
  const ns  = join(ROOT, 'node_modules/@fontsource/noto-sans/files');
  const nsd = join(ROOT, 'node_modules/@fontsource/noto-sans-devanagari/files');
  const ro  = join(ROOT, 'node_modules/@fontsource/rozha-one/files');
  const cg  = join(ROOT, 'node_modules/@fontsource/cormorant-garamond/files');

  const entries: Array<{ path: string; family: string; weight: number }> = [
    // RozhaOne — Devanagari display serif (editorial headlines)
    { path: join(ro, 'rozha-one-devanagari-400-normal.woff2'), family: 'RozhaOne', weight: 400 },
    { path: join(ro, 'rozha-one-latin-400-normal.woff2'),      family: 'RozhaOne', weight: 400 },
    // CormorantGaramond — Latin display serif (subheads, price)
    { path: join(cg, 'cormorant-garamond-latin-500-normal.woff2'), family: 'CormorantGaramond', weight: 500 },
    { path: join(cg, 'cormorant-garamond-latin-600-normal.woff2'), family: 'CormorantGaramond', weight: 600 },
    { path: join(cg, 'cormorant-garamond-latin-700-normal.woff2'), family: 'CormorantGaramond', weight: 700 },
    // NotoSans — Latin glyphs
    { path: join(ns, 'noto-sans-latin-400-normal.woff2'),     family: 'NotoSans', weight: 400 },
    { path: join(ns, 'noto-sans-latin-700-normal.woff2'),     family: 'NotoSans', weight: 700 },
    // NotoSans — Devanagari subset bundled in @fontsource/noto-sans (fallback)
    { path: join(ns, 'noto-sans-devanagari-400-normal.woff2'), family: 'NotoSans', weight: 400 },
    { path: join(ns, 'noto-sans-devanagari-700-normal.woff2'), family: 'NotoSans', weight: 700 },
    // NotoSansDevanagari — dedicated family for headings
    { path: join(nsd, 'noto-sans-devanagari-devanagari-400-normal.woff2'), family: 'NotoSansDevanagari', weight: 400 },
    { path: join(nsd, 'noto-sans-devanagari-devanagari-600-normal.woff2'), family: 'NotoSansDevanagari', weight: 600 },
    // Latin subset also inside NotoSansDevanagari package (so the family covers ₹ sign)
    { path: join(nsd, 'noto-sans-devanagari-latin-400-normal.woff2'), family: 'NotoSansDevanagari', weight: 400 },
    { path: join(nsd, 'noto-sans-devanagari-latin-600-normal.woff2'), family: 'NotoSansDevanagari', weight: 600 },
  ];

  return entries
    .filter(e => existsSync(e.path))
    .map(
      e =>
        `@font-face { font-family: '${e.family}'; src: url('file://${e.path}') format('woff2'); font-weight: ${e.weight}; font-style: normal; }`,
    )
    .join('\n');
}

function fillSlots(template: string, spec: DesignSpec): string {
  let html = template.replace('{{FONT_FACE_CSS}}', buildFontFaceCSS());

  for (const layer of spec.layers) {
    if (layer.type === 'text') {
      html = html.replaceAll(`{{${layer.id.toUpperCase()}}}`, escapeHtml(layer.text));
    } else if (layer.type === 'image') {
      if (layer.asset_ref) {
        const absPath = isAbsolute(layer.asset_ref) ? layer.asset_ref : join(ROOT, layer.asset_ref);
        html = html.replaceAll(`{{${layer.id.toUpperCase()}_SRC}}`, `file://${absPath}`);
      }
    }
  }

  // Drop <img> tags whose slot was never filled, then any leftover placeholders
  html = html.replace(/<img[^>]*\{\{[A-Z_]+_SRC\}\}[^>]*\/?>/g, '');
  html = html.replace(/\{\{[A-Z_]+\}\}/g, '');

  return html;
}

export async function renderSpec(specPath: string): Promise<string> {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as DesignSpec;
  return renderSpecObject(spec, join(ROOT, 'output', spec.spec_version));
}

export async function renderSpecObject(spec: DesignSpec, outputDir: string): Promise<string> {
  const templatePath = join(ROOT, 'archetypes', `${spec.archetype_id}.html`);
  if (!existsSync(templatePath)) throw new Error(`Archetype template not found: ${templatePath}`);

  const html = fillSlots(readFileSync(templatePath, 'utf8'), spec);

  mkdirSync(outputDir, { recursive: true });

  // Write filled HTML alongside the PNG for debugging
  const tmpHtml = join(outputDir, '_render.html');
  writeFileSync(tmpHtml, html, 'utf8');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: spec.dimensions.w, height: spec.dimensions.h });

    // file:// navigation so @font-face file:// src URLs resolve correctly
    await page.goto(`file://${tmpHtml}`, { waitUntil: 'networkidle' });

    // Give Chromium time to finish font shaping (Devanagari requires HarfBuzz)
    await page.waitForFunction(() => document.fonts.ready);

    const pngPath = join(outputDir, 'final.png');
    await page.screenshot({
      path: pngPath,
      clip: { x: 0, y: 0, width: spec.dimensions.w, height: spec.dimensions.h },
    });

    return pngPath;
  } finally {
    await browser.close();
  }
}
