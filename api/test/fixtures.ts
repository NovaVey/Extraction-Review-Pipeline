import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLES_DIR = path.resolve(__dirname, '../../samples');

export function readSample(filename: string): Promise<Buffer> {
  return readFile(path.join(SAMPLES_DIR, filename));
}
