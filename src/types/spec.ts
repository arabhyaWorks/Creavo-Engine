/** Fractional bounding box (0–1 relative to canvas dimensions). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h?: number;
}

export interface Badge {
  fill: string;
  shape: "pill" | "rectangle" | "circle";
  border_color?: string;
}

// ─── Layer types ─────────────────────────────────────────────────────────────

export type ImageLayerRole = "background" | "subject" | "overlay" | "decoration";
export type ImageLayerSource = "generated" | "catalog" | "brand_asset";
export type LogoAnchor =
  | "top_left"
  | "top_right"
  | "bottom_left"
  | "bottom_right"
  | "center";

/**
 * An image layer: either AI-generated (background/scene), a catalog
 * product cutout, or a brand asset (logo).
 */
export interface ImageLayer {
  id: string;
  type: "image";
  role?: ImageLayerRole;
  source: ImageLayerSource;
  /** Path to the rendered/composited asset on disk or object storage */
  asset_ref?: string;
  /** For source "generated" — pointer to the full generation recipe JSON */
  recipe_ref?: string;
  /** For source "generated" — natural-language composition intent sent to Image Agent */
  intent?: string;
  /** For source "catalog" — the product SKU to pull from BrandKit.products */
  sku?: string;
  /** Fractional box; omitted for logo layers that use anchor/margin instead */
  box?: Box;
  /** For source "brand_asset" (logo) — where to pin it on the canvas */
  anchor?: LogoAnchor;
  margin_px?: number;
  max_h_px?: number;
}

/**
 * A text layer rendered deterministically by the Renderer using Noto fonts.
 * The Image Agent never sees or renders text in Route B.
 */
export interface TextLayer {
  id: string;
  type: "text";
  text: string;
  /** BCP-47 language tag driving font selection, e.g. "hi", "en" */
  lang?: string;
  font?: string;
  size_px?: number;
  color?: string;
  box?: Box;
  max_lines?: number;
  align?: "left" | "center" | "right";
  /** Decorative pill/badge rendered behind the text */
  badge?: Badge;
  /**
   * Dotted path to the canonical source of truth for this value, e.g.
   * "catalog.price". Renderer auto-patches before every render so the
   * displayed value is always current.
   */
  source_of_truth?: string;
}

/**
 * A non-destructive colour grading layer (LUT) applied after all other
 * layers are composited.
 */
export interface AdjustmentLayer {
  id: string;
  type: "adjustment";
  /** Path to a .cube LUT file */
  lut?: string;
  /** Blend intensity 0–1 */
  intensity?: number;
}

export type Layer = ImageLayer | TextLayer | AdjustmentLayer;

// ─── Spec-level types ─────────────────────────────────────────────────────────

export type Platform =
  | "ig_feed_square"    // 1080×1080
  | "ig_feed_portrait"  // 1080×1350
  | "ig_story"          // 1080×1920
  | "fb_feed";          // 1200×630

export interface SpecDimensions {
  w: number;
  h: number;
  platform: Platform;
}

export type ImageStyle =
  | "studio"
  | "lifestyle_scene"
  | "flat_lay"
  | "illustration"
  | "pattern";

export type HookType =
  | "question"
  | "offer"
  | "story"
  | "fact"
  | "festival_greeting"
  | "ugc_style";

export type TextDensity = "low" | "medium" | "high";
export type PostFormat = "single" | "carousel" | "story";

/** Self-labelling metadata used by the Diversity Guard and performance analysis. */
export interface VariationAxes {
  archetype: string;
  layout?: string;
  /** Named palette swatch (must be a name from BrandKit.identity.palette) */
  palette_accent?: string;
  image_style?: ImageStyle;
  hook_type?: HookType;
  text_density?: TextDensity;
  format?: PostFormat;
  /** BCP-47 language tag for copy on this post */
  language?: string;
}

export interface Caption {
  /** BCP-47 language tag */
  lang: string;
  text: string;
  hashtags: string[];
  alt_text?: string;
}

/**
 * The Design Spec — the canonical representation of a post.
 * PNGs are deterministic renders of this document. Every version is retained.
 *
 * Schema mirrors PRD section 11; locked fields enforce brand immutability.
 */
export interface DesignSpec {
  /**
   * Stable version identifier, e.g. "post_8741.v3".
   * (spec_version, renderer_version) → byte-identical PNG.
   */
  spec_version: string;
  archetype_id: string;
  dimensions: SpecDimensions;
  /**
   * Dot-paths to fields that no agent may modify, e.g.
   * ["layers.logo", "brand.palette", "brand.fonts"].
   */
  locked: string[];
  /** Ordered bottom-to-top; Renderer composites in this order. */
  layers: Layer[];
  variation_axes: VariationAxes;
  caption: Caption;
}
