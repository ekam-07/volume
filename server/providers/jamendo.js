const HOST = 'https://api.jamendo.com/v3.0';

/**
 * Jamendo — a large catalogue of Creative Commons music with real MP3 URLs.
 *
 * Optional, because unlike the other two it needs a free client ID. Set
 * JAMENDO_CLIENT_ID to switch it on; without it the provider reports itself
 * disabled and unified search simply runs without it.
 */
export const jamendo = {
  id: 'jamendo',
  label: 'Jamendo',
  enabled: () => Boolean(process.env.JAMENDO_CLIENT_ID),

  async search(query, limit, fetchJson) {
    const params = new URLSearchParams({
      client_id: process.env.JAMENDO_CLIENT_ID,
      format: 'json',
      limit: String(limit),
      search: query,
      audioformat: 'mp32',
      include: 'licenses',
    });
    const body = await fetchJson(`${HOST}/tracks/?${params}`);
    return (body?.results ?? []).map(normalize).filter(Boolean);
  },

  async trending(limit, fetchJson) {
    const params = new URLSearchParams({
      client_id: process.env.JAMENDO_CLIENT_ID,
      format: 'json',
      limit: String(limit),
      order: 'popularity_month',
      audioformat: 'mp32',
      include: 'licenses',
    });
    const body = await fetchJson(`${HOST}/tracks/?${params}`);
    return (body?.results ?? []).map(normalize).filter(Boolean);
  },

  async resolve(sourceId, fetchJson) {
    const params = new URLSearchParams({
      client_id: process.env.JAMENDO_CLIENT_ID,
      format: 'json',
      id: sourceId,
      audioformat: 'mp32',
      include: 'licenses',
    });
    const body = await fetchJson(`${HOST}/tracks/?${params}`);
    const meta = normalize(body?.results?.[0]);
    if (!meta?.streamUrl) throw new Error('that track cannot be streamed');
    return { ...meta, extension: '.mp3' };
  },
};

function normalize(track) {
  if (!track?.id || !track.audio) return null;
  const duration = Number(track.duration);
  return {
    source: 'jamendo',
    sourceId: String(track.id),
    title: String(track.name ?? 'Untitled').slice(0, 200),
    artist: String(track.artist_name ?? 'Unknown artist').slice(0, 120),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    artwork: track.album_image ?? track.image ?? null,
    license: track.license_ccurl ?? null,
    streamUrl: track.audiodownload || track.audio,
  };
}
