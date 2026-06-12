#!/usr/bin/env node
/**
 * creavo-engine CLI
 *
 * Usage:
 *   npm run generate -- --brand <name> --archetype <id> [--platform ig_feed_portrait]
 *
 * Example:
 *   npm run generate -- --brand demo --archetype product_hero
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { BrandKit } from "./types/brand.js";

// ─── Argument parsing ────────────────────────────────────────────────────────

interface CliArgs {
  brand: string;
  archetype: string;
  platform: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--brand" && value) { args.brand = value; i++; }
    else if (flag === "--archetype" && value) { args.archetype = value; i++; }
    else if (flag === "--platform" && value) { args.platform = value; i++; }
  }
  if (!args.brand) fatal("--brand is required");
  if (!args.archetype) fatal("--archetype is required");
  return {
    brand: args.brand!,
    archetype: args.archetype!,
    platform: args.platform ?? "ig_feed_portrait",
  };
}

function fatal(msg: string): never {
  console.error(`[creavo] error: ${msg}`);
  process.exit(1);
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");

function loadBrandKit(brandId: string): BrandKit {
  const path = join(ROOT, "brands", brandId, "brand.json");
  if (!existsSync(path)) fatal(`brand kit not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as BrandKit;
}

function loadArchetype(archetypeId: string): unknown {
  const path = join(ROOT, "archetypes", `${archetypeId}.json`);
  if (!existsSync(path)) {
    console.warn(`[creavo] warn: archetype not found at ${path} — skipping`);
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─── Main ────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

console.log("[creavo] loading brand kit …");
const brand = loadBrandKit(args.brand);

console.log("[creavo] loading archetype …");
const archetype = loadArchetype(args.archetype);

console.log();
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`  Brand       : ${brand.name} (${brand.id})`);
console.log(`  Languages   : ${brand.languages.join(", ")}`);
console.log(`  Products    : ${brand.products.length}`);
console.log(`  Archetype   : ${args.archetype}${archetype ? "" : " (not found)"}`);
console.log(`  Platform    : ${args.platform}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log();
console.log("[creavo] generation pipeline not yet implemented.");
console.log("  Next: implement Copy Agent → Layout Agent → Renderer.");
