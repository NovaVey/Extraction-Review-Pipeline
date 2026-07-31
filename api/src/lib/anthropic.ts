import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.js';

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export async function pingAnthropic() {
  try {
    const model = await client.models.retrieve(env.EXTRACTION_MODEL);
    return { ok: true as const, model: model.id };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}
