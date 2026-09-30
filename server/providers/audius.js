const HOST = 'https://api.audius.co';
const APP_NAME = 'volume-sync';

/**
 * Audius — an open streaming catalog of artist-uploaded music. No API key, and
 * tracks come back as plain MP3s, which is the only property that matters here:
 * a real file can go through Web Audio and therefore through the full sync path.
 */
export const audius = {
  id: 'audius',
  label: 'Audius',
  enabled: () => true,

  async search(query, limit, fetchJson) {
    const url = `${HOST}/v1/tracks/search?query=${encodeURIComponent(query)}&limit=${limit}&app_name=${APP_NAME}`;
    const { data } = await fetchJson(url);
    return (data ?? []).map(normalize).filter(Boolean);
  },

  async trending(limit, fetchJson) {
    const { data } = await fetchJson(`${HOST}/v1/tracks/trending?limit=${limit}&app_name=${APP_NAME}`);
    return (data ?? []).map(normalize).filter(Boolean);
  },

  async resolve(sourceId, fetchJson) {
    const { data } = await fetchJson(`${HOST}/v1/tracks/${sourceId}?app_name=${APP_NAME}`);
    const meta = normalize(data);
    if (!meta) throw new Error('that track cannot be streamed');
    return {
      ...meta,
      // Audius accepts several ids for one track and answers with a canonical
      // one. Key the cache on that, or the same audio lands on disk twice.
      streamUrl: `${HOST}/v1/tracks/${meta.sourceId}/stream?app_name=${APP_NAME}`,
      extension: '.mp3',
    };
  },
};

/**
 * Gated releases, previews and takedowns all appear in search results but 404
 * at the stream endpoint. Dropping them here means the host never sees a track
 * that would fail on import.
 */
function normalize(track) {
  if (!track?.id || track.is_streamable === false || track.is_delete) return null;
  const duration = Number(track.duration);
  return {
    source: 'audius',
    sourceId: track.id,
    title: String(track.title ?? 'Untitled').slice(0, 200),
    artist: String(track.user?.name ?? 'Unknown artist').slice(0, 120),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    artwork: track.artwork?.['150x150'] ?? track.artwork?.['480x480'] ?? null,
    license: null,
  };
}
