import { env } from './env.js';

// Content-addressed by sha256 within a batch, so re-uploading the same bytes
// (e.g. a retry after a partial ingest failure) is always safe to upsert.
export async function uploadObject(objectPath: string, body: Buffer, contentType: string): Promise<void> {
  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.STORAGE_BUCKET}/${objectPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      apikey: env.SUPABASE_SERVICE_KEY,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Storage upload failed for ${objectPath}: HTTP ${res.status}: ${await res.text()}`);
  }
}

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
