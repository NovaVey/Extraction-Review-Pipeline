import { env } from './env.js';

export async function pingStorage() {
  try {
    const url = `${env.SUPABASE_URL}/storage/v1/bucket/${encodeURIComponent(env.STORAGE_BUCKET)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, apikey: env.SUPABASE_SERVICE_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}: ${await res.text()}` };
    return { ok: true as const, bucket: await res.json() };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}
