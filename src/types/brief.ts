export interface Brief {
  brand_id: string;
  archetype_id: string;
  sku: string;
  language: string;
  post_id?: string;
  image_style?: 'studio' | 'lifestyle_scene' | 'flat_lay' | 'illustration' | 'pattern';
  hook_type?: 'question' | 'offer' | 'story' | 'fact' | 'festival_greeting' | 'ugc_style';
  additional_context?: string;
}
