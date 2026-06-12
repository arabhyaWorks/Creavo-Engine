# Creavo Engine — prototype

## What this is
Creative-generation core for Creavo (see docs/PRD.md, esp. sections 11-17).
Goal: brand kit in → Instagram-ready post PNG out, verified by a QA loop.

## Architecture rules (non-negotiable)
- Every post is a Design Spec (layer JSON) per PRD section 11. PNGs are renders.
- Route B (default): all text rendered as real text via HTML/CSS + Noto fonts,
  logo composited from file. Image model NEVER renders text/logo in Route B.
- Route A: full generation via Gemini image API, exact strings in quotes,
  reference images attached. Real logo still composited on top afterwards.
- Every generated image stores its recipe (model, prompt, refs) as JSON.
- QA: rubric derived from the spec; Gemini vision checks each item pass/fail
  as JSON; max 2 retries with corrections appended; then fall back to Route B.

## Stack
Node.js 22 + TypeScript. Playwright (chromium) for rendering. sharp for
compositing. Gemini API via REST. No framework, plain CLI scripts for now.

## Conventions
- brands/<name>/brand.json = brand kit (palette hexes, fonts, voice, products)
- archetypes/<id>.json + archetypes/<id>.html = layout schema + template
- output/<post_id>/ = spec.json, recipe.json, qa.json, final.png
- Never commit .env. Test with `npm run generate -- --brand demo --archetype product_hero`