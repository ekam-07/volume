import { Connection, describeDevice } from './net.js';
import { SpeakerEngine } from './engine.js';
import { LiveBroadcaster, liveBroadcastSupport } from './live.js';
import { SpotifyPlayer, beginLogin, isLoggedIn, secureContextOk } from './spotify.js';
import { $, toast, formatTime, formatBytes, driftClass, roomFromUrl, keepAwake } from './ui.js';

const room = roomFromUrl();
if (!room) location.replace('/');

const connection = new Connection({ room, role: 'host', name: 'Host', device: describeDevice() });
const engine = new SpeakerEngine(connection, { followRoster: false, reportTelemetry: false });
const broadcaster = new LiveBroadcaster(connection);

let state = null;
let mode = 'file';
let hostPlaybackOn = false;
let config = { spotifyClientId: null };
/** @type {SpotifyPlayer|null} */
let spotify = null;

keepAwake();
connection.connect();

$('code').textContent = room;
$('qr').src = `/api/rooms/${room}/qr`;

const joinLink = `${location.origin}/join.html?room=${room}`;
$('joinUrl').textContent = joinLink;

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

connection.addEventListener('status', () => renderStatus());
connection.clock.addEventListener('update', () => renderStatus());
connection.addEventListener('error', (e) => {
  if (e.detail.code === 'no_room') {
    toast('That room no longer exists.', true);
    setTimeout(() => location.replace('/'), 1500);
  }
});

function renderStatus() {
  const pill = $('status');
  const label = pill.lastElementChild;
  const { clock } = connection;

  if (connection.status === 'connected') {
    const accuracy = clock.accuracyMs;
    pill.className = `pill ${driftClass(accuracy, 8, 25)}`;
    label.textContent = `synced ±${accuracy < 1 ? accuracy.toFixed(1) : Math.round(accuracy)}ms`;
    $('syncAccuracy').textContent = `±${Math.round(accuracy)}ms · rtt ${Math.round(clock.rtt)}ms`;
  } else {
    pill.className = 'pill warn';
    label.textContent = connection.status;
  }
}

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------

connection.addEventListener('state', (e) => {
  state = e.detail;
  // Follow the room into whichever source is actually active, but leave the
  // host on a tab they opened deliberately while nothing is playing.
  if (state.live.active) mode = 'live';
  else if (state.spotify?.active) mode = 'spotify';

  renderMode();
  renderTracks();
  renderTransport();
  renderSpotify();
  renderSpeakers(state.speakers);
  spotify?.apply(state.spotify);
});

connection.addEventListener('roster', (e) => {
  if (state) state.speakers = e.detail.speakers;
  renderSpeakers(e.detail.speakers);
  renderTransport();
});

// ---------------------------------------------------------------------------
// Mode switch
// ---------------------------------------------------------------------------

$('modeSeg').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-mode]');
  if (!button) return;
  const next = button.dataset.mode;

  if (next === 'live') {
    const support = liveBroadcastSupport();
    if (!support.ok) return toast(`Live input unavailable: ${support.reason}`, true);
  } else if (broadcaster.active) {
    broadcaster.stop();
  }

  mode = next;
  renderMode();
  if (mode === 'spotify') renderSpotify();
});

function renderMode() {
  for (const button of $('modeSeg').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  $('fileMode').classList.toggle('hidden', mode !== 'file');
  $('liveMode').classList.toggle('hidden', mode !== 'live');
  $('spotifyMode').classList.toggle('hidden', mode !== 'spotify');
}

// ---------------------------------------------------------------------------
// Library source: upload or open catalog
// ---------------------------------------------------------------------------

$('sourceSeg').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-source]');
  if (!button) return;
  for (const other of $('sourceSeg').querySelectorAll('button')) {
    other.setAttribute('aria-pressed', String(other === button));
  }
  $('uploadPane').classList.toggle('hidden', button.dataset.source !== 'upload');
  $('catalogPane').classList.toggle('hidden', button.dataset.source !== 'catalog');
  if (button.dataset.source === 'catalog' && !$('catalogResults').children.length) {
    loadTrending();
  }
});

$('catalogForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('catalogQuery').value.trim();
  if (!query) return loadTrending();
  await runCatalogRequest(`/api/catalog/search?q=${encodeURIComponent(query)}&limit=20`);
});

async function loadTrending() {
  await runCatalogRequest('/api/catalog/trending?limit=20');
}

async function runCatalogRequest(url) {
  const results = $('catalogResults');
  results.innerHTML = '<div class="empty">Searching every catalog…</div>';
  try {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'search failed');
    renderCatalogResults(body.tracks, body.failed);
  } catch (err) {
    results.innerHTML = '';
    results.appendChild(Object.assign(document.createElement('div'), {
      className: 'empty',
      textContent: err.message,
    }));
  }
}

const SOURCE_LABELS = { audius: 'Audius', archive: 'Archive', jamendo: 'Jamendo' };

function renderCatalogResults(tracks, failed) {
  const results = $('catalogResults');
  results.innerHTML = '';

  if (failed?.length) {
    results.appendChild(Object.assign(document.createElement('div'), {
      className: 'small muted',
      textContent: `${failed.join(' and ')} did not respond — showing the rest.`,
    }));
  }

  if (!tracks.length) {
    results.innerHTML = '<div class="empty">Nothing found. Try a different spelling.</div>';
    return;
  }

  for (const track of tracks) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="grow" style="min-width:0">
        <div class="title"></div><div class="small muted"></div>
      </div>`;
    row.querySelector('.title').textContent = track.title;
    row.querySelector('.small').textContent = [
      track.artist,
      track.duration ? formatTime(track.duration) : null,
      SOURCE_LABELS[track.source] ?? track.source,
    ]
      .filter(Boolean)
      .join(' · ');

    const add = document.createElement('button');
    add.className = 'icon primary';
    add.textContent = 'Add';
    add.addEventListener('click', async () => {
      add.disabled = true;
      add.textContent = 'Adding…';
      try {
        const res = await fetch(`/api/rooms/${room}/tracks/catalog`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: track.source, sourceId: track.sourceId }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'import failed');
        add.textContent = 'Added';
        toast(body.alreadyInRoom ? 'Already in the library' : `Added "${body.track.title}"`);
      } catch (err) {
        add.disabled = false;
        add.textContent = 'Add';
        toast(err.message, true);
      }
    });
    row.appendChild(add);
    results.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

const drop = $('drop');
const fileInput = $('file');

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  uploadAll([...fileInput.files]);
  fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  });
}
drop.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('audio/'));
  if (!files.length) return toast('That file is not audio.', true);
  uploadAll(files);
});

async function uploadAll(files) {
  for (const file of files) {
    try {
      await uploadOne(file);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, true);
    }
  }
}

function uploadOne(file) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('audio', file, file.name);
    form.append('title', file.name.replace(/\.[^.]+$/, ''));

    // Reading the duration up front means the host's transport shows a real
    // timeline before anyone has downloaded anything.
    probeDuration(file).then((duration) => {
      if (duration) form.append('duration', String(duration));

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/rooms/${room}/tracks`);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        $('uploadBar').classList.remove('hidden');
        $('uploadFill').style.width = `${(event.loaded / event.total) * 100}%`;
      };
      xhr.onload = () => {
        $('uploadBar').classList.add('hidden');
        $('uploadFill').style.width = '0';
        if (xhr.status >= 200 && xhr.status < 300) {
          const { track } = JSON.parse(xhr.responseText);
          if (!state?.playback.trackId) connection.send({ type: 'load', trackId: track.id });
          resolve(track);
        } else {
          reject(new Error(safeError(xhr.responseText) || `upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error('upload failed'));
      xhr.send(form);
    }, reject);
  });
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.addEventListener('loadedmetadata', () =>
      done(Number.isFinite(audio.duration) ? audio.duration : null),
    );
    audio.addEventListener('error', () => done(null));
    setTimeout(() => done(null), 4000);
    audio.src = url;
  });
}

function safeError(text) {
  try {
    return JSON.parse(text).error;
  } catch {
    return null;
  }
}

function renderTracks() {
  const list = $('tracks');
  list.innerHTML = '';
  if (!state?.tracks.length) {
    list.innerHTML = '<div class="empty">No tracks yet.</div>';
    return;
  }

  for (const track of state.tracks) {
    const row = document.createElement('div');
    row.className = `item${track.id === state.playback.trackId ? ' active' : ''}`;

    const info = document.createElement('div');
    info.className = 'grow';
    info.style.minWidth = '0';
    info.innerHTML = `<div class="title"></div><div class="small muted"></div>`;
    info.querySelector('.title').textContent = track.title;
    info.querySelector('.small').textContent = [
      track.duration ? formatTime(track.duration) : null,
      formatBytes(track.bytes),
    ]
      .filter(Boolean)
      .join(' · ');
    info.addEventListener('click', () => connection.send({ type: 'load', trackId: track.id }));
    row.appendChild(info);

    const remove = document.createElement('button');
    remove.className = 'icon danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () =>
      connection.send({ type: 'removeTrack', trackId: track.id }),
    );
    row.appendChild(remove);

    list.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

$('playPause').addEventListener('click', () => {
  if (!state?.playback.trackId) return;
  connection.send({ type: state.playback.playing ? 'pause' : 'play' });
});

$('stop').addEventListener('click', () => connection.send({ type: 'stop' }));

$('loop').addEventListener('click', () => {
  connection.send({ type: 'loop', loop: !state?.playback.loop });
});

$('scrub').addEventListener('click', (event) => {
  const track = currentTrack();
  const duration = track?.duration ?? engine.player.duration;
  if (!duration) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  connection.send({ type: 'seek', offset: fraction * duration });
});

const master = $('master');
master.addEventListener('input', () => {
  $('masterValue').textContent = `${master.value}%`;
});
master.addEventListener('change', () => {
  connection.send({ type: 'masterGain', gain: Number(master.value) / 100 });
});

function currentTrack() {
  return state?.tracks.find((t) => t.id === state.playback.trackId) ?? null;
}

function renderTransport() {
  const track = currentTrack();
  const hasTrack = Boolean(track);

  $('playPause').disabled = !hasTrack;
  $('stop').disabled = !hasTrack;
  $('playPause').textContent = state?.playback.playing ? 'Pause' : 'Play';
  $('loop').setAttribute('aria-pressed', String(Boolean(state?.playback.loop)));

  $('nowPlaying').textContent = track ? track.title : 'Nothing loaded';
  $('nowSub').textContent = track
    ? state.playback.playing
      ? `Playing on every phone${readinessLabel(track)}`
      : `Loaded${readinessLabel(track)}`
    : 'Pick a track to load it on every phone';

  $('duration').textContent = formatTime(track?.duration ?? 0);
}

/**
 * How many phones already hold this track. Phones download in the background as
 * soon as a track is added, so by the time the host reaches for play this is
 * usually already "all ready".
 */
function readinessLabel(track) {
  const speakers = state?.speakers ?? [];
  if (!speakers.length) return '';
  const ready = speakers.filter((s) => s.telemetry?.have?.includes(track.id)).length;
  if (ready === speakers.length) return ` · all ${ready} ready`;
  return ` · ${ready}/${speakers.length} downloaded`;
}

/** The playhead is derived from the shared clock, not from a local timer. */
function tickTransport() {
  const track = currentTrack();
  const duration = track?.duration ?? 0;
  if (!state || !track) {
    $('scrubFill').style.width = '0';
    $('elapsed').textContent = '0:00';
    return;
  }

  let position = state.playback.trackOffset;
  if (state.playback.playing) {
    position += (connection.clock.now() - state.playback.anchorServerTime) / 1000;
  }
  if (duration) {
    position = state.playback.loop
      ? ((position % duration) + duration) % duration
      : Math.min(Math.max(position, 0), duration);
  }

  $('elapsed').textContent = formatTime(position);
  $('scrubFill').style.width = duration ? `${(position / duration) * 100}%` : '0';
}
setInterval(tickTransport, 200);

// ---------------------------------------------------------------------------
// This phone as a speaker
// ---------------------------------------------------------------------------

$('hostPlayToggle').addEventListener('click', async () => {
  if (hostPlaybackOn) {
    engine.shutdown();
    hostPlaybackOn = false;
  } else {
    const ok = await engine.enable();
    if (!ok) return toast('This browser blocked audio. Tap again.', true);
    hostPlaybackOn = true;
  }
  renderHostPlayback();
});

$('hostChannel').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-channel]');
  if (!button) return;
  engine.setChannel(button.dataset.channel);
  for (const other of $('hostChannel').querySelectorAll('button')) {
    other.setAttribute('aria-pressed', String(other === button));
  }
});

const hostGain = $('hostGain');
hostGain.addEventListener('input', () => {
  engine.setGain(Number(hostGain.value) / 100);
  $('hostGainValue').textContent = `${hostGain.value}%`;
});

engine.addEventListener('update', () => renderHostPlayback());

function renderHostPlayback() {
  $('hostPlayToggle').textContent = hostPlaybackOn ? 'Turn off' : 'Turn on';
  $('hostPlayControls').classList.toggle('hidden', !hostPlaybackOn);

  if (!hostPlaybackOn) {
    $('hostPlayState').textContent = 'Off — this phone is only the remote';
    return;
  }
  if (engine.error) {
    $('hostPlayState').textContent = engine.error;
    return;
  }
  if (engine.loading) {
    $('hostPlayState').textContent = `Downloading… ${Math.round(engine.loadProgress * 100)}%`;
    return;
  }
  $('hostPlayState').textContent = engine.playing
    ? `Playing · drift ${engine.driftMs >= 0 ? '+' : ''}${Math.round(engine.driftMs)}ms`
    : 'Ready';
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

function renderSpeakers(speakers) {
  const list = $('speakers');
  const count = speakers?.length ?? 0;
  $('speakerCount').lastElementChild.textContent = `${count} speaker${count === 1 ? '' : 's'}`;
  $('speakerCount').className = count ? 'pill good' : 'pill';

  if (!count) {
    list.innerHTML = '<div class="empty">No phones yet. Have people scan the code above.</div>';
    return;
  }

  // Rebuild only when the set of phones changes, so a slider being dragged is
  // not yanked out from under a thumb on the next roster update.
  const ids = speakers.map((s) => s.id).join(',');
  if (list.dataset.ids !== ids) {
    list.dataset.ids = ids;
    list.innerHTML = '';
    for (const speaker of speakers) list.appendChild(speakerRow(speaker));
  }
  for (const speaker of speakers) updateSpeakerRow(list, speaker);
}

function speakerRow(speaker) {
  const row = document.createElement('div');
  row.className = 'item stack';
  row.dataset.id = speaker.id;
  row.style.alignItems = 'stretch';
  row.innerHTML = `
    <div class="row between">
      <div class="grow" style="min-width:0">
        <div class="title" data-name></div>
        <div class="small muted" data-detail></div>
      </div>
      <span class="pill" data-health><span class="dot"></span><span></span></span>
    </div>
    <div class="row wrap" style="gap:8px">
      <div class="seg" data-channel>
        <button data-value="left">L</button>
        <button data-value="stereo">Stereo</button>
        <button data-value="right">R</button>
      </div>
      <button class="icon" data-mute>Mute</button>
      <button class="icon danger" data-kick>Kick</button>
    </div>
    <input type="range" data-gain min="0" max="100" />
  `;

  row.querySelector('[data-channel]').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    connection.send({ type: 'setSpeaker', clientId: speaker.id, channel: button.dataset.value });
  });

  row.querySelector('[data-mute]').addEventListener('click', (event) => {
    connection.send({
      type: 'setSpeaker',
      clientId: speaker.id,
      muted: event.currentTarget.dataset.muted !== 'true',
    });
  });

  row.querySelector('[data-kick]').addEventListener('click', () => {
    connection.send({ type: 'kick', clientId: speaker.id });
  });

  const gain = row.querySelector('[data-gain]');
  gain.addEventListener('change', () => {
    connection.send({ type: 'setSpeaker', clientId: speaker.id, gain: Number(gain.value) / 100 });
  });

  return row;
}

function updateSpeakerRow(list, speaker) {
  const row = list.querySelector(`[data-id="${speaker.id}"]`);
  if (!row) return;

  row.querySelector('[data-name]').textContent = speaker.name;

  const telemetry = speaker.telemetry;
  const detail = [speaker.device];
  if (telemetry?.rttMs != null) detail.push(`${Math.round(telemetry.rttMs)}ms rtt`);
  if (telemetry?.have?.length) detail.push(`${telemetry.have.length} cached`);
  if (speaker.calibrationMs) detail.push(`trim ${speaker.calibrationMs > 0 ? '+' : ''}${speaker.calibrationMs}ms`);
  row.querySelector('[data-detail]').textContent = detail.filter(Boolean).join(' · ');

  const health = row.querySelector('[data-health]');
  const label = health.lastElementChild;
  if (!telemetry) {
    health.className = 'pill';
    label.textContent = 'joining';
  } else if (telemetry.state === 'loading') {
    health.className = 'pill warn';
    label.textContent = `${Math.round(telemetry.buffered ?? 0)}%`;
  } else if (telemetry.state === 'muted') {
    health.className = 'pill';
    label.textContent = 'tap to enable';
  } else if (telemetry.state === 'error') {
    health.className = 'pill bad';
    label.textContent = 'error';
  } else if (telemetry.state === 'playing') {
    health.className = `pill ${driftClass(telemetry.driftMs ?? 0)}`;
    const drift = Math.round(telemetry.driftMs ?? 0);
    label.textContent = `${drift >= 0 ? '+' : ''}${drift}ms`;
  } else {
    health.className = 'pill good';
    label.textContent = 'ready';
  }

  for (const button of row.querySelectorAll('[data-channel] button')) {
    button.setAttribute('aria-pressed', String(button.dataset.value === speaker.channel));
  }

  const mute = row.querySelector('[data-mute]');
  mute.dataset.muted = String(speaker.muted);
  mute.textContent = speaker.muted ? 'Unmute' : 'Mute';

  const gain = row.querySelector('[data-gain]');
  if (document.activeElement !== gain) gain.value = String(Math.round(speaker.gain * 100));
}

/**
 * Spread the room across the stereo image: alternate phones left and right so
 * a pile of speakers sounds wide instead of merely loud.
 */
$('autoStereo').addEventListener('click', () => {
  const speakers = state?.speakers ?? [];
  if (speakers.length < 2) return toast('Need at least two phones for stereo.', true);
  speakers.forEach((speaker, index) => {
    connection.send({
      type: 'setSpeaker',
      clientId: speaker.id,
      channel: index % 2 === 0 ? 'left' : 'right',
    });
  });
  toast('Split left and right');
});

$('allStereo').addEventListener('click', () => {
  for (const speaker of state?.speakers ?? []) {
    connection.send({ type: 'setSpeaker', clientId: speaker.id, channel: 'stereo' });
  }
  toast('All phones back to stereo');
});

// ---------------------------------------------------------------------------
// Live broadcasting
// ---------------------------------------------------------------------------

let liveSource = 'microphone';

$('liveSourceSeg').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-source]');
  if (!button) return;
  liveSource = button.dataset.source;
  for (const other of $('liveSourceSeg').querySelectorAll('button')) {
    other.setAttribute('aria-pressed', String(other === button));
  }
});

$('liveStart').addEventListener('click', async () => {
  try {
    await broadcaster.start(liveSource);
  } catch (err) {
    toast(err.message, true);
  }
});

$('liveStop').addEventListener('click', () => broadcaster.stop());

broadcaster.addEventListener('started', (e) => {
  $('liveStart').classList.add('hidden');
  $('liveStop').classList.remove('hidden');
  $('liveStatus').textContent = `Broadcasting · ${e.detail.mimeType}`;
});

broadcaster.addEventListener('stopped', () => {
  $('liveStart').classList.remove('hidden');
  $('liveStop').classList.add('hidden');
  $('liveStatus').textContent = 'Stopped.';
});

// ---------------------------------------------------------------------------
// Spotify
//
// The host is a conductor here, not a source: it picks the track and owns the
// shared playhead, and every phone — including this one — runs its own player
// against its own account. See js/spotify.js for why it cannot be tighter.
// ---------------------------------------------------------------------------

fetch('/api/config')
  .then((r) => r.json())
  .then((body) => {
    config = body;
    renderSpotify();
    // Returning from the OAuth redirect: pick the session back up.
    if (config.spotifyClientId && isLoggedIn() && mode === 'spotify') connectSpotify();
  })
  .catch(() => {});

$('spotifyLogin').addEventListener('click', async () => {
  if (!config.spotifyClientId) {
    return toast('Set SPOTIFY_CLIENT_ID on the server first.', true);
  }
  const secure = secureContextOk();
  if (!secure.ok) return toast(secure.reason, true);

  if (isLoggedIn()) return connectSpotify();
  await beginLogin(config.spotifyClientId, location.href);
});

async function connectSpotify() {
  if (!spotify) {
    spotify = new SpotifyPlayer(config.spotifyClientId, connection.clock);
    spotify.addEventListener('update', renderSpotify);
  }
  $('spotifyLogin').disabled = true;
  $('spotifyLogin').textContent = 'Connecting…';
  try {
    await spotify.connect();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('spotifyLogin').disabled = false;
    $('spotifyLogin').textContent = 'Connect Spotify';
    renderSpotify();
  }
}

$('spotifyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('spotifyQuery').value.trim();
  if (!query || !spotify) return;

  const results = $('spotifyResults');
  results.innerHTML = '<div class="empty">Searching…</div>';
  try {
    renderSpotifyResults(await spotify.search(query, 10));
  } catch (err) {
    results.innerHTML = '';
    results.appendChild(Object.assign(document.createElement('div'), {
      className: 'empty',
      textContent: err.message,
    }));
  }
});

function renderSpotifyResults(tracks) {
  const results = $('spotifyResults');
  results.innerHTML = '';
  if (!tracks.length) {
    results.innerHTML = '<div class="empty">Nothing found.</div>';
    return;
  }
  for (const track of tracks) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="grow" style="min-width:0">
        <div class="title"></div><div class="small muted"></div>
      </div>`;
    row.querySelector('.title').textContent = track.name;
    row.querySelector('.small').textContent = `${track.artist} · ${formatTime(track.durationMs / 1000)}`;

    const play = document.createElement('button');
    play.className = 'icon primary';
    play.textContent = 'Play';
    play.addEventListener('click', () => {
      connection.send({
        type: 'spotify:play',
        uri: track.uri,
        name: track.name,
        artist: track.artist,
        artwork: track.artwork,
        durationMs: track.durationMs,
        positionMs: 0,
      });
    });
    row.appendChild(play);
    results.appendChild(row);
  }
}

$('spotifyPlayPause').addEventListener('click', () => {
  connection.send({ type: state?.spotify?.playing ? 'spotify:pause' : 'spotify:resume' });
});

$('spotifyStop').addEventListener('click', () => connection.send({ type: 'spotify:stop' }));

function renderSpotify() {
  const pill = $('spotifyStatus');
  const label = pill.lastElementChild;
  const connected = Boolean(spotify?.ready);

  $('spotifyConnect').classList.toggle('hidden', connected);
  $('spotifyControls').classList.toggle('hidden', !connected);

  if (!config.spotifyClientId) {
    pill.className = 'pill warn';
    label.textContent = 'not configured';
    $('spotifySetup').textContent =
      'Create an app at developer.spotify.com, add ' +
      location.origin +
      '/spotify-callback.html as a redirect URI, then start the server with SPOTIFY_CLIENT_ID set.';
    return;
  }

  const secure = secureContextOk();
  $('spotifySetup').textContent = secure.ok ? '' : secure.reason;

  if (spotify?.error) {
    pill.className = 'pill bad';
    label.textContent = spotify.error;
  } else if (connected) {
    pill.className = 'pill good';
    label.textContent = 'player ready';
  } else {
    pill.className = 'pill';
    label.textContent = isLoggedIn() ? 'connect to play' : 'not connected';
  }

  const sp = state?.spotify;
  $('spotifyPlayPause').disabled = !sp?.active;
  $('spotifyStop').disabled = !sp?.active;
  $('spotifyPlayPause').textContent = sp?.playing ? 'Pause' : 'Play';
  $('spotifyNowPlaying').textContent = sp?.name ?? 'Nothing playing';
  $('spotifyNowSub').textContent = sp?.artist ?? '';

  const listening = state?.speakers?.length ?? 0;
  $('spotifyReady').textContent = sp?.active
    ? `Each of the ${listening} phone${listening === 1 ? '' : 's'} must connect its own Spotify account to hear this.`
    : '';
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

let aligning = false;

$('alignStart').addEventListener('click', async () => {
  if (aligning) return;
  const speakers = state?.speakers ?? [];
  if (!speakers.length) return toast('No phones to align yet.', true);

  // The host has to be able to make sound before it can measure anything, and
  // both the context and the mic permission need a gesture — this one.
  if (!hostPlaybackOn) {
    const ok = await engine.enable();
    if (!ok) return toast('This browser blocked audio. Tap again.', true);
    hostPlaybackOn = true;
    renderHostPlayback();
  }

  aligning = true;
  $('alignStart').disabled = true;
  $('alignBar').classList.remove('hidden');
  $('alignResults').classList.add('hidden');
  setAlignPill('warn', 'measuring');

  try {
    const { alignRoom, SELF_ID } = await import('./align.js');
    const { playChirp } = await import('./calibrate.js');

    // This phone is a speaker too, and has the same unmeasured latency as any
    // other, so it takes its turn rather than being the assumed-correct one.
    const targets = [
      ...speakers,
      { id: SELF_ID, name: 'This phone', calibrationMs: engine.player.calibrationMs },
    ];

    const result = await alignRoom({
      connection,
      player: engine.player,
      speakers: targets,
      playLocally: (at) => playChirp(engine.player, at),
      onProgress: ({ phase, name, done, total }) => {
        $('alignFill').style.width = `${(done / total) * 100}%`;
        $('alignDetail').textContent =
          phase === 'done' ? 'Applying trims…' : `Listening to ${name}… (${done + 1} of ${total})`;
      },
    });
    renderAlignResults(result);
  } catch (err) {
    setAlignPill('bad', 'failed');
    $('alignDetail').textContent = err.message;
    if (err.name === 'NotAllowedError') {
      $('alignDetail').textContent = 'Microphone access was refused, so nothing can be measured.';
    }
  } finally {
    aligning = false;
    $('alignStart').disabled = false;
    $('alignBar').classList.add('hidden');
    $('alignFill').style.width = '0';
  }
});

function renderAlignResults({ adjustments, spreadMs }) {
  const list = $('alignResults');
  list.innerHTML = '';
  list.classList.remove('hidden');

  for (const adjustment of adjustments) {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `<div class="grow" style="min-width:0">
        <div class="title"></div><div class="small muted"></div>
      </div>`;
    row.querySelector('.title').textContent = adjustment.name;
    row.querySelector('.small').textContent = adjustment.applied
      ? `was ${signed(adjustment.correctionMs)}ms off · trim now ${signed(adjustment.calibrationMs)}ms`
      : 'could not be heard — left unchanged';

    const pill = document.createElement('span');
    pill.className = `pill ${adjustment.applied ? driftClass(adjustment.correctionMs, 8, 25) : 'bad'}`;
    pill.innerHTML = '<span class="dot"></span><span></span>';
    pill.lastElementChild.textContent = adjustment.applied
      ? `${signed(adjustment.correctionMs)}ms`
      : 'not heard';
    row.appendChild(pill);
    list.appendChild(row);
  }

  setAlignPill(driftClass(spreadMs, 10, 30), `was ${spreadMs}ms apart`);
  $('alignDetail').textContent =
    spreadMs <= 10
      ? 'Already tight. The phones were within a few milliseconds of each other.'
      : `Corrected a ${spreadMs}ms spread. Play something and listen — run it again if any phone still stands out.`;
}

function setAlignPill(kind, text) {
  const pill = $('alignStatus');
  pill.className = `pill ${kind}`;
  pill.lastElementChild.textContent = text;
}

function signed(n) {
  return `${n >= 0 ? '+' : ''}${n}`;
}

$('metronome').addEventListener('click', async () => {
  // Hold the element rather than reading event.currentTarget, which the DOM
  // clears once dispatch finishes — i.e. across the await below.
  const button = $('metronome');
  const on = button.getAttribute('aria-pressed') !== 'true';

  if (on && !hostPlaybackOn) {
    const ok = await engine.enable();
    if (ok) {
      hostPlaybackOn = true;
      renderHostPlayback();
    }
  }

  button.setAttribute('aria-pressed', String(on));
  connection.send({ type: 'calibrate:metronome', on });
  if (on) toast('Walk the room — the clicks should sound as one');
});

connection.addEventListener('calibrate:metronome', (e) => {
  $('metronome').setAttribute('aria-pressed', String(Boolean(e.detail.on)));
});

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

$('copyLink').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(joinLink);
    toast('Join link copied');
  } catch {
    toast(joinLink);
  }
});

$('shareLink').addEventListener('click', async () => {
  if (!navigator.share) return toast('Sharing is not available here.', true);
  try {
    await navigator.share({ title: 'Join my speaker room', text: `Room ${room}`, url: joinLink });
  } catch {
    /* the user dismissed the sheet */
  }
});

// A handle for the console, matching the join page's.
window.__volume = { connection, engine, broadcaster };

window.addEventListener('beforeunload', () => connection.close());
renderMode();
renderHostPlayback();
renderStatus();
