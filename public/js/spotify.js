/**
 * Spotify mode.
 *
 * Read this before changing anything here, because the constraints are not
 * obvious and they are not ours to fix:
 *
 *   1. **One account plays on one device.** Starting playback on a second
 *      device stops the first. So there is no "host plays, everyone listens" —
 *      every listener signs into their own Premium account and runs their own
 *      player. We are conducting N independent players, not distributing audio.
 *
 *   2. **The audio is DRM-protected.** The SDK decrypts through Widevine/EME
 *      and never exposes an AudioContext node. Everything that makes file mode
 *      accurate is therefore unavailable here: no `getOutputTimestamp()` to
 *      measure real speaker latency, no `playbackRate` to nudge away drift, no
 *      channel splitting for stereo. The entire control surface is `seek(ms)`,
 *      `resume()`, `pause()`.
 *
 *   3. **So we converge instead of scheduling.** File mode says "start at
 *      exactly 14:32:05.250" and hits it. Here we can only say "seek to 42350"
 *      and measure where the player actually landed, repeatedly. Each device
 *      polls its own position against the shared clock and re-seeks when it has
 *      slipped past the deadband.
 *
 * Realistic result: a spread of roughly ±150 ms across the room. Audible as an
 * echo. That is the floor this API imposes, not a bug to be tuned out — the
 * deadband is deliberately wide because a seek is far more disruptive than the
 * drift it would correct.
 */

const AUTH_HOST = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
].join(' ');

const STORE_KEY = 'volume.spotify.token';
const VERIFIER_KEY = 'volume.spotify.verifier';
const RETURN_KEY = 'volume.spotify.return';

/** Re-seek only past this much slip; a seek is more disruptive than the drift. */
const SEEK_DEADBAND_MS = 150;
const CORRECTION_INTERVAL_MS = 2000;

export const REDIRECT_PATH = '/spotify-callback.html';

// ---------------------------------------------------------------------------
// Auth (PKCE — no client secret, so it is safe in a browser)
// ---------------------------------------------------------------------------

/** A fresh PKCE pair: `challenge` is base64url(SHA-256(`verifier`)). */
export async function createChallenge() {
  const verifier = randomString(64);
  return { verifier, challenge: base64url(await sha256(verifier)) };
}

export function buildAuthUrl(clientId, challenge) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: location.origin + REDIRECT_PATH,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
  });
  return `${AUTH_HOST}/authorize?${params}`;
}

export async function beginLogin(clientId, returnTo) {
  const { verifier, challenge } = await createChallenge();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(RETURN_KEY, returnTo || location.href);
  location.href = buildAuthUrl(clientId, challenge);
}

/** Called by the callback page. Returns where to send the user next. */
export async function completeLogin(clientId, code) {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('login session expired — try again');

  const res = await fetch(`${AUTH_HOST}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: location.origin + REDIRECT_PATH,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });

  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.error || 'token exchange failed');

  storeToken(body);
  sessionStorage.removeItem(VERIFIER_KEY);
  return sessionStorage.getItem(RETURN_KEY) || '/';
}

function storeToken(body) {
  const token = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? readToken()?.refreshToken ?? null,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - 60_000,
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(token));
  return token;
}

function readToken() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return null;
  }
}

export function isLoggedIn() {
  return Boolean(readToken()?.refreshToken || readToken()?.accessToken);
}

export function logout() {
  localStorage.removeItem(STORE_KEY);
}

async function getAccessToken(clientId) {
  const token = readToken();
  if (!token) throw new Error('not connected to Spotify');
  if (token.accessToken && Date.now() < token.expiresAt) return token.accessToken;
  if (!token.refreshToken) throw new Error('Spotify session expired — reconnect');

  const res = await fetch(`${AUTH_HOST}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      client_id: clientId,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    logout();
    throw new Error('Spotify session expired — reconnect');
  }
  return storeToken(body).accessToken;
}

// ---------------------------------------------------------------------------

export class SpotifyPlayer extends EventTarget {
  /** @param {import('./sync.js').Clock} clock */
  constructor(clientId, clock) {
    super();
    this.clientId = clientId;
    this.clock = clock;
    this.player = null;
    this.deviceId = null;
    this.ready = false;
    this.error = null;
    this.target = null;
    this.lastPositionMs = 0;
    this.slipMs = 0;
    this._timer = null;
  }

  /** Must run from a user gesture: the SDK needs one to satisfy EME autoplay. */
  async connect() {
    if (this.player) return this.ready;
    await loadSdk();

    this.player = new window.Spotify.Player({
      name: 'volume',
      getOAuthToken: (cb) => {
        getAccessToken(this.clientId).then(cb, (err) => this._fail(err.message));
      },
      volume: 1,
    });

    this.player.addListener('ready', ({ device_id }) => {
      this.deviceId = device_id;
      this.ready = true;
      this.error = null;
      this._emit();
    });
    this.player.addListener('not_ready', () => {
      this.ready = false;
      this._emit();
    });
    for (const event of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
      this.player.addListener(event, ({ message }) => {
        this._fail(event === 'account_error' ? 'Spotify Premium is required' : message);
      });
    }

    const connected = await this.player.connect();
    if (!connected) this._fail('could not start the Spotify player');

    clearInterval(this._timer);
    this._timer = setInterval(() => this._correct(), CORRECTION_INTERVAL_MS);
    return connected;
  }

  disconnect() {
    clearInterval(this._timer);
    this._timer = null;
    try {
      this.player?.disconnect();
    } catch {
      /* already gone */
    }
    this.player = null;
    this.deviceId = null;
    this.ready = false;
    this.target = null;
    this._emit();
  }

  async search(query, limit = 10) {
    const token = await getAccessToken(this.clientId);
    const params = new URLSearchParams({ q: query, type: 'track', limit: String(limit) });
    const res = await fetch(`${API}/search?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`search failed (${res.status})`);
    const body = await res.json();
    return (body.tracks?.items ?? []).map((item) => ({
      uri: item.uri,
      name: item.name,
      artist: item.artists?.map((a) => a.name).join(', ') ?? '',
      durationMs: item.duration_ms,
      artwork: item.album?.images?.at(-1)?.url ?? null,
    }));
  }

  /**
   * Apply the room's Spotify state. `anchorServerTime` and `positionMs` define
   * the shared playhead; everything here is an attempt to land on it.
   */
  async apply(spotify) {
    if (!this.ready) return;

    if (!spotify?.playing || !spotify.uri) {
      this.target = null;
      await this.player?.pause().catch(() => {});
      this._emit();
      return;
    }

    const changedTrack = this.target?.uri !== spotify.uri;
    const changedAnchor = Math.abs((this.target?.anchorServerTime ?? 0) - spotify.anchorServerTime) > 1;
    this.target = { ...spotify };
    if (!changedTrack && !changedAnchor) return;

    const position = Math.max(0, Math.round(this.expectedPositionMs()));
    try {
      const token = await getAccessToken(this.clientId);
      const res = await fetch(`${API}/me/player/play?device_id=${this.deviceId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [spotify.uri], position_ms: position }),
      });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || `playback failed (${res.status})`);
      }
      this.error = null;
    } catch (err) {
      this._fail(err.message);
    }
    this._emit();
  }

  /** Where the room says this track should be, right now, in milliseconds. */
  expectedPositionMs() {
    if (!this.target) return 0;
    const elapsed = this.clock.now() - this.target.anchorServerTime;
    return this.target.positionMs + Math.max(0, elapsed);
  }

  /**
   * The convergence loop. Unlike file mode's rate nudge, the only tool here is
   * a seek — which is audible — so the deadband is wide and corrections are
   * rare by design.
   */
  async _correct() {
    if (!this.ready || !this.player || !this.target?.playing) return;

    const state = await this.player.getCurrentState().catch(() => null);
    if (!state || state.paused) return;

    // `position` was sampled at `timestamp`; extrapolate to now.
    const sampledAgo = Math.max(0, Date.now() - (state.timestamp || Date.now()));
    const actual = state.position + sampledAgo;
    this.lastPositionMs = actual;

    const expected = this.expectedPositionMs();
    if (expected > (this.target.durationMs ?? Infinity)) return;

    this.slipMs = actual - expected;
    if (Math.abs(this.slipMs) > SEEK_DEADBAND_MS) {
      await this.player.seek(Math.round(expected)).catch(() => {});
    }
    this._emit();
  }

  _fail(message) {
    this.error = message;
    this._emit();
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('update'));
  }
}

// ---------------------------------------------------------------------------

let sdkPromise = null;

function loadSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (window.Spotify) return resolve();
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => reject(new Error('could not load the Spotify SDK'));
    document.head.appendChild(script);
    setTimeout(() => reject(new Error('the Spotify SDK did not load')), 15_000);
  });
  return sdkPromise;
}

/**
 * The SDK requires a secure context for DRM. `localhost` counts; a bare LAN
 * address over http does not, which is the single most common reason Spotify
 * mode silently refuses to play on a phone.
 */
export function secureContextOk() {
  if (window.isSecureContext) return { ok: true };
  return {
    ok: false,
    reason: `Spotify needs HTTPS. This page is on ${location.origin}, which browsers treat as insecure, so DRM is blocked. Use a tunnel (cloudflared or ngrok) or a certificate.`,
  };
}

// ---------------------------------------------------------------------------

function randomString(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

async function sha256(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
