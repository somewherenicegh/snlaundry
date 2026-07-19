// Storage abstraction.
//
// On Netlify: uses Netlify Blobs (built-in, no external account needed).
// Locally / in tests: falls back to JSON files under a writable directory.
//
// The rest of the app only ever calls readJSON / writeJSON, so it never has to
// know which backend is active.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STORE_NAME = 'laundry';

let _blobs = null;
let _mode = null; // 'blobs' | 'file'
let _blobsError = null; // captured for diagnostics via /api/health

// True when running inside Netlify's serverless (AWS Lambda) runtime, where the
// only writable location is the OS temp dir (/tmp).
function onNetlify() {
  return !!(process.env.NETLIFY || process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

async function getBackend() {
  if (_mode) return _mode;

  // Force file mode for local dev/tests.
  if (process.env.FORCE_FILE_STORE === '1') {
    _mode = 'file';
    return _mode;
  }

  try {
    const { getStore } = await import('@netlify/blobs');
    // Prefer Netlify's automatic configuration. If it isn't injected (some
    // deploys don't get it), fall back to explicit credentials supplied via
    // env vars NETLIFY_BLOBS_SITE_ID + NETLIFY_BLOBS_TOKEN.
    const opts = { name: STORE_NAME };
    const siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (siteID && token) { opts.siteID = siteID; opts.token = token; }
    _blobs = getStore(opts);
    // Probe so we know Blobs really works before committing to it.
    await _blobs.get('__probe__');
    _mode = 'blobs';
  } catch (err) {
    _blobsError = err && (err.message || String(err));
    _mode = 'file';
    if (onNetlify()) {
      // Surface loudly in the function logs — file mode on Netlify is ephemeral.
      console.error('[store] Netlify Blobs unavailable, using ephemeral /tmp storage:', _blobsError);
    }
  }
  return _mode;
}

function dataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  // /var/task (the code dir) is READ-ONLY on Netlify — use the temp dir instead.
  const base = onNetlify() ? os.tmpdir() : process.cwd();
  return path.join(base, '.laundry-data');
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

// Detailed status for the /api/health endpoint.
export async function storeInfo() {
  const mode = await getBackend();
  return { mode, onNetlify: onNetlify(), blobsError: _blobsError, dataDir: mode === 'file' ? dataDir() : undefined };
}
