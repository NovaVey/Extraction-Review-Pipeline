import { createWorker, type Worker } from 'tesseract.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tesseract.js's default langPath fetches from cdn.jsdelivr.net at runtime.
// @tesseract.js-data/eng ships the identical trained-data file as a plain npm
// package, so pinning langPath here removes a live CDN dependency entirely
// (both for this sandbox's egress policy and for production reliability).
const LANG_PATH = path.resolve(__dirname, '../../../node_modules/@tesseract.js-data/eng/4.0.0_best_int');

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

export async function ocrPageImage(png: Buffer): Promise<OcrResult> {
  const worker = await getWorker();
  const {
    data: { text, confidence },
  } = await worker.recognize(png);
  return { text: text.trim(), confidence: confidence / 100 };
}

export async function terminateOcrWorker(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;
    workerPromise = null;
    await worker.terminate();
  }
}
