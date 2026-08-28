import { createWorker, type Worker } from 'tesseract.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tesseract.js's default langPath fetches from cdn.jsdelivr.net at runtime.
// @tesseract.js-data/eng ships the identical trained-data file as a plain npm
// package, so pinning langPath here removes a live CDN dependency entirely
// (both for this sandbox's egress policy and for production reliability).
const LANG_PATH = path.resolve(__dirname, '../../../node_modules/@tesseract.js-data/eng/4.0.0_best_int');

// Generous relative to a normal single-page recognize() pass (a few seconds), but
// bounded: without ANY timeout, a stuck native OCR call (a pathological rendered
// image, or a worker that silently wedges mid-job) hangs that request forever AND
// queues up every subsequent OCR call behind it indefinitely, since getWorker()
// shares one worker across the whole process and tesseract.js workers process one
// job at a time. Mirrors lib/storage.ts's AbortSignal.timeout use for the same class
// of risk -- recognize() has no AbortSignal of its own, so this races it against a
// plain timer instead. Exported so tests can drive it exactly rather than guessing.
export const RECOGNIZE_TIMEOUT_MS = 60_000;

// Distinguishes "the timer won the race" from any real value recognize() could ever
// resolve with, without needing a second boolean out-parameter.
const RECOGNIZE_TIMED_OUT = Symbol('recognize-timed-out');

export interface OcrResult {
  text: string;
  confidence: number; // normalized 0..1 (tesseract reports 0..100)
}

// Workers are expensive to spin up (loads the WASM engine + language data), so
// the ingest run shares one worker across every page that needs OCR rather
// than creating one per page.
let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    // langPath already points at a local, instant read — writing a decompressed
    // cache copy elsewhere (tesseract's default) would only add disk side effects.
    workerPromise = createWorker('eng', undefined, { langPath: LANG_PATH, cacheMethod: 'none' }).catch((err) => {
      // A rejected promise assigned above would otherwise stay cached forever —
      // every subsequent getWorker() call just re-awaits the same already-rejected
      // promise and fails immediately, with no way to recover short of restarting
      // the process. Clearing the cache on failure means the NEXT call retries
      // worker creation from scratch instead of being permanently wedged by one
      // transient failure (e.g. a filesystem hiccup reading the pinned lang data).
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

// Discards the current cached worker so the NEXT getWorker() call builds a fresh one
// instead of reusing whatever's left of a wedged one -- mirroring the recovery
// getWorker() already does when worker creation itself fails. Deliberately does NOT
// await worker.terminate() -- a worker stuck mid-job may not terminate cleanly (or
// promptly) either, and the caller that already timed out shouldn't have to wait on
// that too; it's fired off best-effort and any outcome (or lack of one) is discarded.
function discardWorker(worker: Worker): void {
  workerPromise = null;
  worker.terminate().catch(() => {
    // Nothing useful to do with a failed termination beyond not crashing on it.
  });
}

export async function ocrPageImage(png: Buffer): Promise<OcrResult> {
  const worker = await getWorker();
  const startedAt = Date.now();

  const recognizePromise = worker.recognize(png);
  // If recognize() eventually settles after we've already given up on it below, a
  // bare rejection would surface as an unhandled promise rejection with nothing left
  // to catch it -- attach a no-op handler so a straggling failure is silently
  // swallowed instead of crashing the process.
  recognizePromise.catch(() => {});

  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof RECOGNIZE_TIMED_OUT>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(RECOGNIZE_TIMED_OUT), RECOGNIZE_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([recognizePromise, timeout]);
    if (result === RECOGNIZE_TIMED_OUT) {
      logger.error(
        { elapsedMs: Date.now() - startedAt, timeoutMs: RECOGNIZE_TIMEOUT_MS },
        'OCR recognize() timed out; discarding the stuck worker',
      );
      discardWorker(worker);
      throw new Error(`OCR recognize() timed out after ${RECOGNIZE_TIMEOUT_MS}ms`);
    }
    const {
      data: { text, confidence },
    } = result;
    return { text: text.trim(), confidence: confidence / 100 };
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

export async function terminateOcrWorker(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;
    workerPromise = null;
    await worker.terminate();
  }
}
