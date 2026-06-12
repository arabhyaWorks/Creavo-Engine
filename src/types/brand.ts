/** Role of a palette swatch within the brand identity. */
export type PaletteRole = "primary" | "secondary" | "accent" | "background" | "text";

export interface PaletteSwatch {
  name: string;       // e.g. "burgundy"
  hex: string;        // e.g. "#7A1F2B"
  role: PaletteRole;
}

export interface BrandFonts {
  /** Noto font family name for headings, e.g. "NotoSansDevanagari-SemiBold" */
  heading: string;
  /** Noto font family name for body copy */
  body: string;
  /** Optional accent / price / badge font */
  accent?: string;
}

export interface LogoAssets {
  svg?: string;   // path relative to brand dir
  png?: string;
  /** Variant for dark / coloured backgrounds */
  dark_variant?: string;
}

export interface BrandIdentity {
  palette: PaletteSwatch[];
  fonts: BrandFonts;
  logo_assets: LogoAssets;
}

export interface BrandVoice {
  /** Short descriptive words that capture tone, e.g. ["warm", "artisanal", "proud"] */
  tone_words: string[];
  /** Words and phrases the brand never uses */
  never_say: string[];
  /** 2–3 example captions in the brand's primary language, used as few-shot anchors */
  examples: string[];
}

/** Stock state; OUT_OF_STOCK hard-blocks the SKU from promotion. */
export type StockState = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

export type MarginTier = "low" | "medium" | "high";

export interface Product {
  sku: string;
  /** Multilingual display names keyed by BCP-47 language tag, e.g. {"hi": "...", "en": "..."} */
  name_ml: Record<string, string>;
  price: number;
  /** ISO 4217 currency code */
  currency: string;
  stock_state: StockState;
  margin_tier: MarginTier;
  /** Paths to product images (cutouts preferred) */
  images: string[];
  category: string;
  /** Optional multilingual short descriptions */
  description_ml?: Record<string, string>;
}

/**
 * Brand kit as stored in brands/<name>/brand.json.
 * Mirrors the BrandKB entity from PRD section 10, flattened for
 * single-file convenience at prototype stage.
 */
export interface BrandKit {
  /** Stable slug used in directory names and CLI flags */
  id: string;
  name: string;
  /** Brand's primary language (BCP-47 tags), e.g. ["hi", "en"] */
  languages: string[];
  /** States/cities the brand sells to; used for festival relevance scoring */
  geography: string[];
  domain?: string;
  identity: BrandIdentity;
  voice: BrandVoice;
  /** Unique selling points used by Copy Agent and Layout Agent */
  usps: string[];
  products: Product[];
}
