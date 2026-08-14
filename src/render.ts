#!/usr/bin/env node
/**
 * creavo render CLI
 *
 * Usage:
 *   npm run render -- --spec <path-to-spec.json>
 *
 * Example:
 *   npm run render -- --spec brands/demo/specs/product_hero.json
 */

import { resolve, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { renderSpec } from './renderer.js';

function fatal(msg: string): never {
  console.error(`[creavo] error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): string {
  const idx = argv.indexOf('--spec');
  if (idx === -1 || !argv[idx + 1]) fatal('--spec <path> is required');
  const raw = argv[idx + 1]!;
  const p = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(p)) fatal(`spec not found: ${p}`);
  return p;
}

const specPath = parseArgs(process.argv.slice(2));
console.log(`[creavo] rendering  ${specPath}`);

renderSpec(specPath)
  .then(out => console.log(`[creavo] done  →  ${out}`))
  .catch((err: unknown) => {
    console.error('[creavo] render failed:', err);
    process.exit(1);
  });
