import { z } from 'zod';

import { getClient } from './openai.js';

export const callJson = async <T>(params: {
  schema: z.ZodType<T>;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model: string;
  temperature: number;
  timeoutMs?: number;
}): Promise<{ ok: true; data: T; raw: unknown } | { ok: false; error: string; raw?: unknown }> => {
  const client = getClient();
  if (!client) return { ok: false, error: 'AI client not configured (AI_API_KEY missing).' };

  const timeoutMs = Math.max(5_000, Math.floor(params.timeoutMs ?? 60_000));
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // NOTE: openai npm package versions differ in whether `signal` is accepted on the body.
    // Passing it as a RequestOptions keeps TypeScript + runtime compatible.
    const completion = await client.chat.completions.create(
      {
        model: params.model,
        temperature: params.temperature,
        response_format: { type: 'json_object' },
        messages: params.messages,
      },
      { signal: controller.signal } as unknown as Record<string, unknown>,
    );
    const content = completion.choices[0]?.message?.content ?? '{}';
    const raw = JSON.parse(content) as unknown;
    const validated = params.schema.safeParse(raw);
    if (!validated.success) {
      return { ok: false, error: 'AI output failed schema validation', raw };
    }
    return { ok: true, data: validated.data, raw };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'AI call failed' };
  } finally {
    clearTimeout(t);
  }
};
