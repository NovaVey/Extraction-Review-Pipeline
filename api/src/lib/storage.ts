import { env } from './env.js';

// Generous relative to pingStorage's 5s (a plain bucket-metadata GET) — these move
// real file bodies (rendered page PNGs, whole source PDFs up to the 20MB upload
// limit), which legitimately take longer, especially over a slow connection. The
// point isn't a tight budget, just an upper bound: without ANY timeout a stalled
// Supabase endpoint (network partition, backend hang, stuck TLS handshake) hangs
// the calling ingest/export/download request indefinitely instead of failing.
const OBJECT_TRANSFER_TIMEOUT_MS = 30_000;

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
    signal: AbortSignal.timeout(OBJECT_TRANSFER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Storage upload failed for ${objectPath}: HTTP ${res.status}: ${await res.text()}`);
  }
}

export async function downloadObject(objectPath: string): Promise<Buffer> {
  const url = `${env.SUPABASE_URL}/storage/v1/object/${env.STORAGE_BUCKET}/${objectPath}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, apikey: env.SUPABASE_SERVICE_KEY },
    signal: AbortSignal.timeout(OBJECT_TRANSFER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Storage download failed for ${objectPath}: HTTP ${res.status}: ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
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
