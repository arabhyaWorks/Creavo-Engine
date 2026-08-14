/**
 * OpenAI vision + text client.
 * Used by the Design Thinker agent for GPT-4o design analysis.
 */

export interface OpenAIImageInput {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  base64: string;
}

export interface OpenAITextOpts {
  apiKey: string;
  model: string;           // e.g. "gpt-4o"
  systemPrompt: string;
  userText: string;
  images?: OpenAIImageInput[];
  maxTokens?: number;
}

interface OAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | OAIContentPart[];
}

interface OAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail: 'high' };
}

interface OAIResponse {
  choices?: Array<{ message: { content: string } }>;
  error?: { message: string };
}

export async function callOpenAI(opts: OpenAITextOpts): Promise<string> {
  const { apiKey, model, systemPrompt, userText, images = [], maxTokens = 4096 } = opts;

  const userContent: OAIContentPart[] = [{ type: 'text', text: userText }];
  for (const img of images) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:${img.mimeType};base64,${img.base64}`,
        detail: 'high',
      },
    });
  }

  const messages: OAIMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userContent },
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });

  const json = await res.json() as OAIResponse;
  if (!res.ok || json.error) throw new Error(`OpenAI error: ${json.error?.message ?? `HTTP ${res.status}`}`);

  const text = json.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('OpenAI returned empty response');
  return text;
}
