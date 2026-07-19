// Storage abstraction.
//
// On Netlify: uses Netlify Blobs (built-in, no external account needed).
// Locally / in tests: falls back to JSON files under DATA_DIR (default ./.data).
//
// The rest of the app only ever calls readJSON / writeJSON, so it never has to
// know which backend is active.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const STORE_NAME = 'laundry';

let _blobs = null;
let _mode = null; // 'blobs' | 'file'

async function getBackend() {
  if (_mode) return _mode;

  // Force file mode for local dev/tests.
  if (process.env.FORCE_FILE_STORE === '1') {
    _mode = 'file';
    return _mode;
  }

  try {
    const { getStore } = await import('@netlify/blobs');
    // getStore throws (or later calls throw) if not running in a Netlify context.
    _blobs = getStore({ name: STORE_NAME, consistency: 'strong' });
    // Probe so we fail fast to file mode when running outside Netlify.
    await _blobs.get('__probe__');
    _mode = 'blobs';
  } catch {
    _mode = 'file';
  }
  return _mode;
}

function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), '.data');
}

function filePath(key) {
  return path.join(dataDir(), `${key}.json`);
}

export async function readJSON(key, fallback = null) {
  const mode = await getBackend();
  if (mode === 'blobs') {
    const val = await _blobs.get(key, { type: 'json' });
    return val === null || val === undefined ? fallback : val;
  }
  try {
    const raw = await fs.readFile(filePath(key), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeJSON(key, value) {
  const mode = await getBackend();
  if (mode === 'blobs') {
    await _blobs.setJSON(key, value);
    return value;
  }
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(filePath(key), JSON.stringify(value, null, 2), 'utf8');
  return value;
}

// Simple optimistic list helpers built on top of readJSON/writeJSON.
export async function getCollection(key) {
  return (await readJSON(key, [])) || [];
}

export async function saveCollection(key, arr) {
  return writeJSON(key, arr);
}

export async function storeMode() {
  return getBackend();
}
