import { Connection, describeDevice } from './net.js';
import { SpeakerEngine } from './engine.js';
import { SpotifyPlayer, beginLogin, isLoggedIn, secureContextOk } from './spotify.js';
import { $, toast, driftClass, roomFromUrl, keepAwake } from './ui.js';

const room = roomFromUrl();
if (!room) location.replace('/');

$('codeBig').textContent = room;

const TRIM_KEY = 'volume.trim';

const savedName = localStorage.getItem('volume.name') || '';
const savedTrim = Number(localStorage.getItem(TRIM_KEY)) || 0;

const connection = new Connection({
  room,
  role: 'speaker',
  name: savedName,
  device: describeDevice(),
  // A trim describes this phone's speaker hardware, not this session, so it
  // travels with the handshake and survives reloads and reconnects.
  calibrationMs: savedTrim,
});
const engine = new SpeakerEngine(connection, { followRoster: true, reportTelemetry: true });

let joined = false;
let assignment = null;
let config = { spotifyClientId: null };
/** @type {SpotifyPlayer|null} */
let spotify = null;

keepAwake();
connection.connect();

// ---------------------------------------------------------------------------
// Joining — nothing can make sound until the user taps
// ---------------------------------------------------------------------------

$('enable').addEventListener('click', async () => {
  const button = $('enable');
  button.disabled = true;
  button.textContent = 'Joining…';
  try {
    const ok = await engine.enable();
    if (!ok) throw new Error('audio blocked');
    joined = true;
    $('gate').classList.add('hidden');
    $('live').classList.remove('hidden');
    if (savedName) $('name').value = savedName;
    if (savedTrim) engine.player.setCalibration(savedTrim);
    renderSpotify();
  } catch {
    toast('Your browser blocked audio. Tap once more.', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Tap to join the speaker';
  }
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

connection.addEventListener('status', renderStatus);
connection.clock.addEventListener('update', renderStatus);

connection.addEventListener('error', (e) => {
  if (e.detail.code === 'no_room') {
    toast('That room no longer exists.', true);
    setTimeout(() => location.replace('/'), 1800);
  }
});

connection.addEventListener('kicked', () => {
  engine.shutdown();
  toast('The host removed this phone.', true);
  setTimeout(() => location.replace('/'), 1800);
});

function renderStatus() {
  const pill = $('status');
  const label = pill.lastElementChild;
  if (connection.status !== 'connected') {
    pill.className = 'pill warn';
    label.textContent = connection.status;
    return;
  }
  const accuracy = connection.clock.accuracyMs;
  pill.className = `pill ${driftClass(accuracy, 8, 25)}`;
  label.textContent = `synced ±${Math.round(accuracy)}ms`;
}

// ---------------------------------------------------------------------------
// Playback state
// ---------------------------------------------------------------------------

connection.addEventListener('state', (e) => {
  renderTrack(e.detail);
  renderSpotify();
  spotify?.apply(e.detail.spotify);
});
connection.addEventListener('roster', () => {
  assignment = engine.assignment;
  renderAssignment();
});
engine.addEventListener('update', () => {
  renderDrift();
  renderTrack(connection.state);
});

function renderTrack(state) {
  if (!joined || !state) return;

  if (state.spotify?.active) {
    $('trackTitle').textContent = state.spotify.name ?? 'Spotify';
    $('trackSub').textContent = spotify?.ready
      ? state.spotify.artist || 'Playing from your Spotify account'
      : 'Connect Spotify below to hear this';
    $('orb').textContent = '🎧';
    $('orb').classList.toggle('live', Boolean(spotify?.ready && state.spotify.playing));
    return;
  }

  if (state.live.active) {
    $('trackTitle').textContent = 'Live from the host';
    $('trackSub').textContent = engine.error ?? 'Streaming';
    $('orb').textContent = '🎙';
    $('orb').classList.toggle('live', !engine.error);
    return;
  }

  const track = state.tracks.find((t) => t.id === state.playback.trackId);
  if (!track) {
    $('trackTitle').textContent = 'Waiting for the host';
    $('trackSub').textContent = "You're connected and in sync";
    $('orb').textContent = '♪';
    $('orb').classList.remove('live');
    return;
  }

  $('trackTitle').textContent = track.title;
  $('orb').classList.toggle('live', engine.playing);
  $('orb').textContent = engine.playing ? '🔊' : '♪';

  if (engine.error) {
    $('trackSub').textContent = engine.error;
  } else if (engine.loading) {
    $('trackSub').textContent = `Downloading… ${Math.round(engine.loadProgress * 100)}%`;
  } else if (engine.playing) {
    $('trackSub').textContent = 'Playing in sync';
  } else {
    $('trackSub').textContent = 'Downloaded and ready';
  }
}

function renderDrift() {
  if (!joined) return;
  const drift = engine.driftMs;
  const pill = $('driftPill');
  const label = pill.lastElementChild;

  if (!engine.playing || !Number.isFinite(drift)) {
    pill.className = 'pill';
    label.textContent = '—';
    $('needle').style.left = '50%';
    $('needle').style.background = 'var(--muted)';
    return;
  }

  const tight = engine.mode === 'live' ? 60 : 15;
  const loose = engine.mode === 'live' ? 150 : 40;
  const cls = driftClass(drift, tight, loose);
  pill.className = `pill ${cls}`;
  label.textContent = `${drift >= 0 ? '+' : ''}${Math.round(drift)}ms`;

  const span = engine.mode === 'live' ? 400 : 50;
  const clamped = Math.max(-span, Math.min(span, drift));
  $('needle').style.left = `calc(${50 + (clamped / span) * 48}% - 1.5px)`;
  $('needle').style.background = `var(--${cls === 'good' ? 'good' : cls === 'warn' ? 'warn' : 'bad'})`;
}

function rememberTrim(ms) {
  try {
    localStorage.setItem(TRIM_KEY, String(ms));
  } catch {
    /* private window; the trim just will not survive a reload */
  }
}

function renderAssignment() {
  if (!assignment) return;
  // Safe to mirror the server now: it was told this phone's trim during the
  // handshake, so the roster reflects the real value rather than a fresh zero.
  rememberTrim(assignment.calibrationMs);
  const pill = $('channelPill');
  pill.lastElementChild.textContent = assignment.muted
    ? 'muted by host'
    : assignment.channel === 'stereo'
      ? 'stereo'
      : `${assignment.channel} channel`;
  pill.className = assignment.muted ? 'pill bad' : 'pill good';

  const gain = $('gain');
  if (document.activeElement !== gain) {
    gain.value = String(Math.round(assignment.gain * 100));
    $('gainValue').textContent = `${gain.value}%`;
  }
  const trim = $('trim');
  if (document.activeElement !== trim) {
    trim.value = String(assignment.calibrationMs);
    $('trimValue').textContent = `${assignment.calibrationMs}ms`;
  }
}

// ---------------------------------------------------------------------------
// Local controls
// ---------------------------------------------------------------------------

const gain = $('gain');
gain.addEventListener('input', () => {
  const value = Number(gain.value) / 100;
  $('gainValue').textContent = `${gain.value}%`;
  engine.player.setGain(value);
  engine.receiver.setGain(value);
});

const trim = $('trim');
trim.addEventListener('input', () => {
  $('trimValue').textContent = `${trim.value}ms`;
});
trim.addEventListener('change', () => {
  // Tell the server so the host sees it, and apply it here straight away.
  const ms = Number(trim.value);
  engine.player.setCalibration(ms);
  rememberTrim(ms);
  connection.send({ type: 'calibrate', calibrationMs: ms });
});

$('rename').addEventListener('click', () => {
  const name = $('name').value.trim();
  if (!name) return;
  localStorage.setItem('volume.name', name);
  connection.send({ type: 'rename', name });
  toast('Renamed');
});

// A phone that was backgrounded comes back with a suspended AudioContext and a
// stale clock. Re-measure and let the engine reschedule from the shared state.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !joined) return;
  connection.clock.reset();
  await engine.resync();
});

// ---------------------------------------------------------------------------
// Spotify — this phone plays from its own account, conducted by the host
// ---------------------------------------------------------------------------

fetch('/api/config')
  .then((r) => r.json())
  .then((body) => {
    config = body;
    renderSpotify();
    // Coming back from the OAuth redirect into a room already on Spotify.
    if (config.spotifyClientId && isLoggedIn() && connection.state?.spotify?.active) {
      connectSpotify();
    }
  })
  .catch(() => {});

$('spotifyLogin').addEventListener('click', async () => {
  if (!config.spotifyClientId) return toast('Spotify is not configured on this server.', true);
  const secure = secureContextOk();
  if (!secure.ok) return toast(secure.reason, true);
  if (isLoggedIn()) return connectSpotify();
  await beginLogin(config.spotifyClientId, location.href);
});

async function connectSpotify() {
  if (!spotify) {
    spotify = new SpotifyPlayer(config.spotifyClientId, connection.clock);
    spotify.addEventListener('update', () => {
      renderSpotify();
      renderTrack(connection.state);
    });
  }
  const button = $('spotifyLogin');
  button.disabled = true;
  button.textContent = 'Connecting…';
  try {
    await spotify.connect();
    if (connection.state?.spotify) await spotify.apply(connection.state.spotify);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Connect Spotify';
    renderSpotify();
  }
}

function renderSpotify() {
  const active = Boolean(connection.state?.spotify?.active);
  $('spotifyCard').classList.toggle('hidden', !active || !joined);
  if (!active) return;

  const pill = $('spotifyStatus');
  const label = pill.lastElementChild;
  const secure = secureContextOk();

  if (!config.spotifyClientId) {
    pill.className = 'pill warn';
    label.textContent = 'not configured';
    $('spotifyDetail').textContent = 'This server has no Spotify client ID set.';
  } else if (spotify?.error) {
    pill.className = 'pill bad';
    label.textContent = spotify.error;
    $('spotifyDetail').textContent = '';
  } else if (spotify?.ready) {
    pill.className = 'pill good';
    label.textContent = 'playing';
    const slip = Math.round(spotify.slipMs ?? 0);
    $('spotifyDetail').textContent = `Off the room's playhead by ${slip >= 0 ? '+' : ''}${slip}ms.`;
  } else {
    pill.className = 'pill';
    label.textContent = isLoggedIn() ? 'tap to start' : 'not connected';
    $('spotifyDetail').textContent = secure.ok ? '' : secure.reason;
  }

  $('spotifyLogin').classList.toggle('hidden', Boolean(spotify?.ready));
}

// A handle for the console: inspect the clock, the decoded buffer, the live
// receiver, or force a resync while debugging a room that sounds wrong.
window.__volume = { connection, engine, get spotify() { return spotify; } };

renderStatus();
