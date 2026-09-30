const SEARCH = 'https://archive.org/advancedsearch.php';
const METADATA = 'https://archive.org/metadata';
const DOWNLOAD = 'https://archive.org/download';

/**
 * The Internet Archive's audio collections. No API key.
 *
 * The Archive hosts everything from public-domain 78s to user uploads of
 * uncertain provenance, so the query is pinned to collections that are open by
 * policy and results without an explicit licence are dropped:
 *
 *   netlabels        Creative Commons netlabel releases — the bulk of the music
 *   etree            the Live Music Archive: taper-approved live recordings
 *   opensource_audio community uploads, kept only when they declare a licence
 *
 * `etree` is allowed without a `licenseurl` field because that collection's
 * admission policy is itself the licence: bands opt in to free distribution.
 */
const COLLECTIONS = 'netlabels OR etree OR opensource_audio';

export const archive = {
  id: 'archive',
  label: 'Internet Archive',
  enabled: () => true,

  async search(query, limit, fetchJson) {
    const q = `(${escapeLucene(query)}) AND mediatype:(audio) AND collection:(${COLLECTIONS})`;
    const params = new URLSearchParams({ q, rows: String(limit), page: '1', output: 'json' });
    for (const field of ['identifier', 'title', 'creator', 'licenseurl', 'collection', 'year']) {
      params.append('fl[]', field);
    }
    const body = await fetchJson(`${SEARCH}?${params}`);
    return (body?.response?.docs ?? []).map(normalize).filter(Boolean);
  },

  async trending(limit, fetchJson) {
    const params = new URLSearchParams({
      q: `mediatype:(audio) AND collection:(netlabels)`,
      rows: String(limit),
      page: '1',
      sort: 'downloads desc',
      output: 'json',
    });
    for (const field of ['identifier', 'title', 'creator', 'licenseurl', 'collection']) {
      params.append('fl[]', field);
    }
    const body = await fetchJson(`${SEARCH}?${params}`);
    return (body?.response?.docs ?? []).map(normalize).filter(Boolean);
  },

  /**
   * An Archive "item" is a folder, not a track — often a whole album or concert.
   * Resolving one means reading its file list and picking a single playable MP3.
   */
  async resolve(sourceId, fetchJson, { maxBytes = Infinity } = {}) {
    const meta = await fetchJson(`${METADATA}/${encodeURIComponent(sourceId)}`);
    const files = meta?.files ?? [];

    const playable = files
      .map((f) => ({ ...f, bytes: Number(f.size) || 0, ext: extensionOf(f.name) }))
      .filter((f) => FORMATS.has(f.ext));

    // Archive items are folders, and a radio show or a full concert often sits
    // beside perfectly playable individual tracks. Drop what is too big to
    // import rather than picking it and failing the whole item.
    const candidates = playable
      .filter((f) => !f.bytes || f.bytes <= maxBytes)
      .sort((a, b) => rank(a) - rank(b));

    const file = candidates[0];
    if (!file) {
      throw new Error(
        playable.length
          ? 'every recording in that item is too long'
          : 'that item has no audio this browser can play',
      );
    }

    const item = meta.metadata ?? {};
    return {
      source: 'archive',
      sourceId,
      // The file name is usually the actual song; the item title is the album.
      title: cleanFileTitle(file.name, file.ext) || String(item.title ?? sourceId).slice(0, 200),
      artist: String(first(item.creator) ?? 'Internet Archive').slice(0, 120),
      duration: parseLength(file.length),
      artwork: null,
      license: item.licenseurl ?? null,
      streamUrl: `${DOWNLOAD}/${encodeURIComponent(sourceId)}/${encodeURIComponent(file.name)}`,
      extension: `.${file.ext}`,
    };
  },
};

/**
 * Everything `decodeAudioData` can handle across the browsers this runs on.
 * Many Archive items carry lossless masters and no MP3 derivative, so limiting
 * to MP3 would reject a large share of otherwise perfect results.
 */
const FORMATS = new Set(['mp3', 'm4a', 'mp4', 'ogg', 'oga', 'opus', 'flac', 'wav', 'aif', 'aiff']);

/** Smaller and more universally decodable first, when an item offers a choice. */
const FORMAT_PREFERENCE = ['mp3', 'm4a', 'mp4', 'ogg', 'oga', 'opus', 'flac', 'wav', 'aif', 'aiff'];

/**
 * Prefer a normal-length song over a one-hour set or a 20-second intro, then
 * prefer the friendlier container.
 */
function rank(file) {
  const seconds = parseLength(file.length);
  const byLength = !seconds ? 2 : seconds < 45 ? 3 : seconds > 900 ? 1 : 0;
  const byFormat = FORMAT_PREFERENCE.indexOf(file.ext);
  return byLength * 100 + (byFormat < 0 ? 99 : byFormat);
}

function extensionOf(name) {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(String(name ?? ''));
  return match ? match[1].toLowerCase() : '';
}

function normalize(doc) {
  if (!doc?.identifier) return null;
  const collections = [].concat(doc.collection ?? []);
  const license = doc.licenseurl ?? null;
  // Keep only what is explicitly licensed, or what etree's policy already covers.
  if (!license && !collections.includes('etree')) return null;

  return {
    source: 'archive',
    sourceId: doc.identifier,
    title: String(first(doc.title) ?? doc.identifier).slice(0, 200),
    artist: String(first(doc.creator) ?? 'Internet Archive').slice(0, 120),
    // Not known until the item's file list is read at import time.
    duration: null,
    artwork: null,
    license,
  };
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

/** Archive lengths come as "245.6" or "04:05" or "1:02:03". */
function parseLength(length) {
  if (length == null) return null;
  const text = String(length).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text)) || null;
  const parts = text.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? Math.round(seconds) : null;
}

function cleanFileTitle(name, ext) {
  return String(name ?? '')
    .replace(new RegExp(`\.${ext}$`, 'i'), '')
    .replace(/_/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Lucene treats these as syntax; a song title should not. */
function escapeLucene(query) {
  return String(query).replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, ' ').trim() || '*';
}
