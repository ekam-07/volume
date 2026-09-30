import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

import { audius } from './providers/audius.js';
import { archive } from './providers/archive.js';
import { jamendo } from './providers/jamendo.js';

/**
 * One search bar over several open catalogues.
 *
 * Each provider hands back real MP3 URLs, which is the property the whole
 * design rests on: an imported track becomes an ordinary file, so it flows
 * through decode → scheduled start → drift correction exactly like something
 * the host uploaded, and keeps the sub-millisecond accuracy that a DRM-wrapped
 * stream can never have.
 *
 * The server downloads each track once and serves it to the room. Ten phones on
 * a hotspot then pull from the LAN instead of ten times from the internet.
 */

const PROVIDERS = [audius, jamendo, archive];

/** ~35 minutes at 320 kbps. Long sets are common and would fill every phone. */
const MAX_BYTES = 80 * 1024 * 1024;
const MAX_BYTES_LABEL = '80 MB';
const FETCH_TIMEOUT_MS = 20_000;
const PROVIDER_TIMEOUT_MS = 8_000;

/** Downloads in progress, so two phones asking at once share one fetch. */
const inFlight = new Map();

export function createCatalog(cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });

  return {
    providers: () =>
      PROVIDERS.filter((p) => p.enabled()).map((p) => ({ id: p.id, label: p.label })),
    search: (query, limit) => fanOut('search', query, limit),
    trending: (limit) => fanOut('trending', null, limit),
    import: (source, sourceId) => importTrack(source, sourceId, cacheDir),
  };
}

// ---------------------------------------------------------------------------
// Unified search
// ---------------------------------------------------------------------------

/**
 * Query every enabled provider at once and interleave the results, so one
 * catalogue with a lot of loosely-matching titles cannot bury the others.
 * A provider that fails or stalls is skipped rather than failing the search —
 * partial results beat an error page.
 */
async function fanOut(method, query, limit) {
  const active = PROVIDERS.filter((p) => p.enabled());
  const perProvider = clamp(Math.ceil((Number(limit) || 20) / active.length) + 4, 4, 30);

  const settled = await Promise.allSettled(
    active.map((provider) =>
      withTimeout(
        query == null
          ? provider.trending(perProvider, fetchJson)
          : provider.search(query, perProvider, fetchJson),
        PROVIDER_TIMEOUT_MS,
        provider.label,
      ),
    ),
  );

  const lists = settled.map((result) => (result.status === 'fulfilled' ? result.value : []));
  const failed = settled
    .map((result, index) => (result.status === 'rejected' ? active[index].label : null))
    .filter(Boolean);

  return { tracks: interleave(lists, clamp(limit, 1, 60)), failed };
}

function interleave(lists, limit) {
  const out = [];
  const seen = new Set();
  for (let round = 0; out.length < limit; round++) {
    let addedThisRound = false;
    for (const list of lists) {
      const track = list[round];
      if (!track) continue;
      addedThisRound = true;
      const key = `${track.source}:${track.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(track);
      if (out.length >= limit) break;
    }
    if (!addedThisRound) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function importTrack(source, sourceId, cacheDir) {
  const provider = PROVIDERS.find((p) => p.id === source && p.enabled());
  if (!provider) throw new Error('unknown catalog source');
  if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(String(sourceId ?? ''))) {
    throw new Error('invalid track id');
  }

  const key = `${source}:${sourceId}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    const meta = await provider.resolve(sourceId, fetchJson, { maxBytes: MAX_BYTES });

    // Providers may answer with a canonical id different from the one asked
    // for. Key the cache on that, or the same audio lands on disk twice.
    const filename = safeFilename(meta.source, meta.sourceId, meta.extension ?? '.mp3');
    const filePath = path.join(cacheDir, filename);

    const cached = statOrNull(filePath);
    if (cached?.size > 0) return { ...meta, filename, bytes: cached.size, cached: true };

    const bytes = await download(meta.streamUrl, filePath);
    return { ...meta, filename, bytes, cached: false };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

async function download(url, filePath) {
  if (!url) throw new Error('no audio URL for that track');
  const partial = `${filePath}.part`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`stream unavailable (${res.status})`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error(`that track is over ${MAX_BYTES_LABEL} — try a shorter one`);
  }

  try {
    let written = 0;
    const counter = new ByteCounter((total) => {
      written = total;
      if (total > MAX_BYTES) {
        throw new Error(`that track is over ${MAX_BYTES_LABEL} — try a shorter one`);
      }
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(partial));
    // Rename only once the whole file has landed, so an interrupted download
    // can never be mistaken for a cache hit.
    fs.renameSync(partial, filePath);
    return written;
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`catalog request failed (${res.status})`);
  return res.json();
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'volume-sync/0.1 (open catalog client)' },
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('the catalog did not respond');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

/** Never let a provider's id decide where on disk we write. */
function safeFilename(source, sourceId, extension) {
  const clean = String(sourceId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96);
  const ext = /^\.[A-Za-z0-9]{1,5}$/.test(extension) ? extension : '.mp3';
  return `${source}-${clean}${ext}`;
}

function statOrNull(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(n) || lo));
}

class ByteCounter extends Transform {
  constructor(onCount) {
    super();
    this.total = 0;
    this.onCount = onCount;
  }
  _transform(chunk, _encoding, callback) {
    this.total += chunk.length;
    try {
      this.onCount(this.total);
    } catch (err) {
      return callback(err);
    }
    callback(null, chunk);
  }
}
