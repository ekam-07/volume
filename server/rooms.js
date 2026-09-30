import crypto from 'node:crypto';
import { serverNow } from './clock.js';

/** Characters that survive being read aloud across a noisy room. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

/** Rooms with nobody in them are swept this long after the last client leaves. */
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

/** A client that has not pinged in this long is presumed gone. */
const CLIENT_TIMEOUT_MS = 20 * 1000;

/**
 * How far in the future a `play` is scheduled. Every phone must receive the
 * command, decode enough audio and arm its scheduler before this deadline, so
 * the lead time scales with the worst round-trip in the room.
 */
const MIN_LEAD_MS = 700;
const MAX_LEAD_MS = 4000;

export class Rooms {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    setInterval(() => this.sweep(), 15_000).unref?.();
  }

  create() {
    let code;
    do {
      code = randomCode();
    } while (this.rooms.has(code));
    const room = new Room(code, this);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase());
  }

  sweep() {
    const now = serverNow();
    for (const room of this.rooms.values()) {
      room.dropStaleClients(now);
      if (room.clients.size === 0 && now - room.lastActivity > EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(room.code);
      }
    }
  }

  attach(wss) {
    wss.on('connection', (ws, req) => {
      // Reply to time pings before anything else touches the socket — every
      // millisecond spent in our own code here is measurement noise.
      ws.binaryType = 'nodebuffer';

      /** @type {Room|null} */
      let room = null;
      /** @type {Client|null} */
      let client = null;

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          if (room && client?.role === 'host') room.relayLiveChunk(data);
          return;
        }

        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        // --- time sync: answer immediately, do nothing else ---
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', t0: msg.t0, t1: serverNow() }));
          if (client) client.lastSeen = serverNow();
          return;
        }

        if (msg.type === 'hello') {
          room = this.get(msg.room);
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', code: 'no_room', message: 'Room not found.' }));
            ws.close();
            return;
          }
          client = room.join(ws, msg);
          return;
        }

        if (!room || !client) return;
        client.lastSeen = serverNow();
        room.handle(client, msg);
      });

      ws.on('close', () => {
        if (room && client) room.leave(client);
      });

      ws.on('error', () => {
        if (room && client) room.leave(client);
      });
    });
  }

  broadcastState(room) {
    room.broadcastState();
  }
}

class Room {
  constructor(code, owner) {
    this.code = code;
    this.owner = owner;
    this.createdAt = serverNow();
    this.lastActivity = this.createdAt;

    /** @type {Map<string, Client>} */
    this.clients = new Map();
    /** @type {Array<object>} */
    this.tracks = [];

    this.playback = {
      mode: 'file',
      trackId: null,
      playing: false,
      /** Server time at which the playhead sits exactly at `trackOffset`. */
      anchorServerTime: 0,
      /** Seconds into the track at `anchorServerTime`. */
      trackOffset: 0,
      loop: false,
    };

    /**
     * Spotify playback is *conducted*, not distributed: each phone runs its own
     * player on its own account. All the server holds is the shared playhead
     * every device tries to converge on.
     */
    this.spotify = {
      active: false,
      uri: null,
      name: null,
      artist: null,
      artwork: null,
      durationMs: 0,
      playing: false,
      anchorServerTime: 0,
      positionMs: 0,
    };

    this.live = {
      active: false,
      /** First MediaRecorder chunk — the WebM init segment late joiners need. */
      initSegment: null,
      startedAt: 0,
      /** Capture stamp + codec, so receivers can map media time to server time. */
      meta: null,
    };
  }

  // -- membership ----------------------------------------------------------

  join(ws, msg) {
    const role = msg.role === 'host' ? 'host' : 'speaker';
    const client = new Client({
      id: crypto.randomUUID(),
      ws,
      role,
      name: sanitizeName(msg.name) || defaultName(this.speakerCount() + 1),
      device: String(msg.device || '').slice(0, 120),
      // A phone knows its own speaker latency from a previous alignment, and
      // declares it on arrival so it is never briefly untrimmed.
      calibrationMs: clamp(numberOr(msg.calibrationMs, 0), -500, 500),
    });

    this.clients.set(client.id, client);
    this.lastActivity = serverNow();

    client.send({
      type: 'welcome',
      clientId: client.id,
      room: this.code,
      role,
      serverTime: serverNow(),
    });
    client.send(this.stateMessage());
    if (role === 'speaker' && this.live.active && this.live.initSegment) {
      client.ws.send(this.live.initSegment);
    }
    this.broadcastRoster();
    return client;
  }

  leave(client) {
    if (!this.clients.delete(client.id)) return;
    this.lastActivity = serverNow();
    this.broadcastRoster();
  }

  dropStaleClients(now) {
    for (const client of this.clients.values()) {
      if (now - client.lastSeen > CLIENT_TIMEOUT_MS) {
        try {
          client.ws.close();
        } catch {
          /* already gone */
        }
        this.clients.delete(client.id);
      }
    }
  }

  speakerCount() {
    let n = 0;
    for (const c of this.clients.values()) if (c.role === 'speaker') n++;
    return n;
  }

  // -- commands ------------------------------------------------------------

  handle(client, msg) {
    switch (msg.type) {
      case 'status':
        // Telemetry from a speaker: how far it drifted, what its round trip is.
        client.telemetry = {
          rttMs: numberOr(msg.rttMs, null),
          offsetMs: numberOr(msg.offsetMs, null),
          driftMs: numberOr(msg.driftMs, null),
          state: String(msg.state || '').slice(0, 24),
          buffered: numberOr(msg.buffered, null),
          // Track ids this phone already holds — the host shows this as
          // readiness so it knows nobody will stall when it presses play.
          have: Array.isArray(msg.have)
            ? msg.have.filter((id) => typeof id === 'string').slice(0, 60)
            : [],
          at: serverNow(),
        };
        this.broadcastRoster({ toHostsOnly: true });
        return;

      case 'rename':
        client.name = sanitizeName(msg.name) || client.name;
        this.broadcastRoster();
        return;

      case 'calibrate':
        // A speaker's own latency trim, in milliseconds. Positive means this
        // device is late and should start earlier.
        client.calibrationMs = clamp(numberOr(msg.calibrationMs, 0), -500, 500);
        this.broadcastRoster();
        return;

      default:
        break;
    }

    if (client.role !== 'host') return;
    this.lastActivity = serverNow();

    switch (msg.type) {
      case 'load': {
        const track = this.tracks.find((t) => t.id === msg.trackId);
        if (!track) return;
        // The three modes are exclusive: loading a file silences Spotify and
        // any live broadcast rather than letting two sources overlap.
        this._exitOtherModes();
        this.playback.mode = 'file';
        this.playback.trackId = track.id;
        this.playback.playing = false;
        this.playback.trackOffset = 0;
        this.playback.anchorServerTime = serverNow();
        this.broadcastState();
        return;
      }

      case 'play': {
        if (!this.playback.trackId) return;
        const offset = Math.max(0, numberOr(msg.offset, this.playback.trackOffset));
        this._exitOtherModes();
        this.playback.mode = 'file';
        this.playback.playing = true;
        this.playback.trackOffset = offset;
        this.playback.anchorServerTime = serverNow() + this.leadTime();
        this.broadcastState();
        return;
      }

      case 'pause': {
        if (!this.playback.playing) return;
        this.playback.trackOffset = this.currentOffset();
        this.playback.playing = false;
        this.playback.anchorServerTime = serverNow();
        this.broadcastState();
        return;
      }

      case 'seek': {
        const offset = Math.max(0, numberOr(msg.offset, 0));
        this.playback.trackOffset = offset;
        this.playback.anchorServerTime = this.playback.playing
          ? serverNow() + this.leadTime()
          : serverNow();
        this.broadcastState();
        return;
      }

      case 'stop': {
        this.playback.playing = false;
        this.playback.trackOffset = 0;
        this.playback.anchorServerTime = serverNow();
        this.broadcastState();
        return;
      }

      case 'loop': {
        this.playback.loop = Boolean(msg.loop);
        this.broadcastState();
        return;
      }

      case 'removeTrack': {
        this.tracks = this.tracks.filter((t) => t.id !== msg.trackId);
        if (this.playback.trackId === msg.trackId) {
          this.playback.trackId = null;
          this.playback.playing = false;
          this.playback.trackOffset = 0;
        }
        this.broadcastState();
        return;
      }

      case 'setSpeaker': {
        const target = this.clients.get(msg.clientId);
        if (!target || target.role !== 'speaker') return;
        if (msg.gain !== undefined) target.gain = clamp(numberOr(msg.gain, 1), 0, 1);
        if (msg.channel !== undefined && CHANNELS.has(msg.channel)) target.channel = msg.channel;
        if (msg.muted !== undefined) target.muted = Boolean(msg.muted);
        if (msg.calibrationMs !== undefined) {
          target.calibrationMs = clamp(numberOr(msg.calibrationMs, 0), -500, 500);
        }
        this.broadcastState();
        this.broadcastRoster();
        return;
      }

      case 'masterGain': {
        this.masterGain = clamp(numberOr(msg.gain, 1), 0, 1);
        this.broadcastState();
        return;
      }

      case 'kick': {
        const target = this.clients.get(msg.clientId);
        if (!target || target.role === 'host') return;
        target.send({ type: 'kicked' });
        try {
          target.ws.close();
        } catch {
          /* already gone */
        }
        this.clients.delete(target.id);
        this.broadcastRoster();
        return;
      }

      /**
       * Alignment is orchestrated by the host and relayed here one device at a
       * time, so two chirps never overlap in the room — overlapping sweeps
       * would correlate against each other and produce confident nonsense.
       */
      case 'calibrate:chirp': {
        const target = this.clients.get(msg.clientId);
        if (!target) return;
        const at = numberOr(msg.atServerTime, serverNow() + 500);
        target.send({ type: 'calibrate:play', atServerTime: at });
        return;
      }

      case 'calibrate:metronome': {
        const on = Boolean(msg.on);
        this.metronome = on;
        for (const client of this.clients.values()) {
          client.send({ type: 'calibrate:metronome', on });
        }
        return;
      }

      case 'spotify:play': {
        const uri = String(msg.uri || '');
        if (!/^spotify:track:[A-Za-z0-9]+$/.test(uri)) return;
        this.playback.mode = 'spotify';
        this.playback.playing = false;
        this.live.active = false;
        this.live.initSegment = null;
        this.live.meta = null;
        this.spotify = {
          active: true,
          uri,
          name: String(msg.name || 'Unknown track').slice(0, 200),
          artist: String(msg.artist || '').slice(0, 200),
          artwork: typeof msg.artwork === 'string' ? msg.artwork.slice(0, 500) : null,
          durationMs: numberOr(msg.durationMs, 0),
          playing: true,
          // Spotify players take an unpredictable moment to actually begin, so
          // there is no point scheduling ahead the way file mode does. Anchor
          // to now and let each device converge by seeking.
          anchorServerTime: serverNow(),
          positionMs: Math.max(0, numberOr(msg.positionMs, 0)),
        };
        this.broadcastState();
        return;
      }

      case 'spotify:pause': {
        if (!this.spotify.active || !this.spotify.playing) return;
        this.spotify.positionMs = this.spotifyPositionMs();
        this.spotify.playing = false;
        this.spotify.anchorServerTime = serverNow();
        this.broadcastState();
        return;
      }

      case 'spotify:resume': {
        if (!this.spotify.active || this.spotify.playing) return;
        this.spotify.playing = true;
        this.spotify.anchorServerTime = serverNow();
        this.broadcastState();
        return;
      }

      case 'spotify:seek': {
        if (!this.spotify.active) return;
        this.spotify.positionMs = Math.max(0, numberOr(msg.positionMs, 0));
        this.spotify.anchorServerTime = serverNow();
        this.broadcastState();
        return;
      }

      case 'spotify:stop': {
        this.spotify = {
          ...this.spotify,
          active: false,
          playing: false,
          uri: null,
          positionMs: 0,
          anchorServerTime: serverNow(),
        };
        this.playback.mode = 'file';
        this.broadcastState();
        return;
      }

      case 'live:start': {
        this._exitOtherModes();
        this.playback.mode = 'live';
        this.playback.playing = false;
        this.live.active = true;
        this.live.initSegment = null;
        this.live.meta = null;
        this.live.startedAt = serverNow();
        this.broadcastState();
        return;
      }

      case 'live:meta': {
        if (!this.live.active) return;
        this.live.meta = {
          captureStartServerTime: numberOr(msg.captureStartServerTime, serverNow()),
          mimeType: String(msg.mimeType || '').slice(0, 80),
          sliceMs: numberOr(msg.sliceMs, 100),
          targetDelayMs: clamp(numberOr(msg.targetDelayMs, 600), 150, 3000),
        };
        this.broadcastState();
        return;
      }

      case 'live:stop': {
        this.live.active = false;
        this.live.initSegment = null;
        this.live.meta = null;
        this.playback.mode = 'file';
        this.broadcastState();
        return;
      }

      default:
        return;
    }
  }

  /**
   * Relay one chunk of the host's live encoder to every speaker.
   *
   * The first chunk a MediaRecorder emits carries the container headers that
   * every later chunk depends on, so we keep it and replay it to anyone who
   * joins mid-broadcast. Without it their MediaSource has nothing to parse.
   */
  relayLiveChunk(buffer) {
    if (!this.live.active) return;
    if (!this.live.initSegment) this.live.initSegment = Buffer.from(buffer);
    for (const client of this.clients.values()) {
      if (client.role !== 'speaker') continue;
      if (client.ws.readyState !== 1) continue;
      if (client.ws.bufferedAmount > 512 * 1024) continue; // this phone is falling behind
      client.ws.send(buffer);
    }
  }

  // -- playback maths ------------------------------------------------------

  /** Seconds into the current track, right now, in server time. */
  currentOffset() {
    if (!this.playback.playing) return this.playback.trackOffset;
    const elapsed = (serverNow() - this.playback.anchorServerTime) / 1000;
    return Math.max(0, this.playback.trackOffset + elapsed);
  }

  /** Silence whichever of the three sources is not being switched to. */
  _exitOtherModes() {
    this.spotify.active = false;
    this.spotify.playing = false;
    this.live.active = false;
    this.live.initSegment = null;
    this.live.meta = null;
  }

  /** Where the shared Spotify playhead sits right now, in milliseconds. */
  spotifyPositionMs() {
    if (!this.spotify.playing) return this.spotify.positionMs;
    return this.spotify.positionMs + Math.max(0, serverNow() - this.spotify.anchorServerTime);
  }

  /**
   * Scheduling lead time, derived from the worst round-trip currently reported.
   * A room on a good local network gets a snappy ~700ms; a room on mobile data
   * with one slow phone gets more headroom instead of one phone starting late.
   */
  leadTime() {
    let worstRtt = 0;
    for (const client of this.clients.values()) {
      if (client.role !== 'speaker') continue;
      const rtt = client.telemetry?.rttMs;
      if (typeof rtt === 'number' && Number.isFinite(rtt)) worstRtt = Math.max(worstRtt, rtt);
    }
    return clamp(MIN_LEAD_MS + worstRtt * 2, MIN_LEAD_MS, MAX_LEAD_MS);
  }

  // -- outbound ------------------------------------------------------------

  stateMessage() {
    return {
      type: 'state',
      serverTime: serverNow(),
      room: this.code,
      tracks: this.tracks,
      masterGain: this.masterGain ?? 1,
      playback: { ...this.playback },
      live: { active: this.live.active, meta: this.live.meta },
      spotify: { ...this.spotify },
      speakers: this.rosterEntries(),
    };
  }

  rosterEntries() {
    const out = [];
    for (const client of this.clients.values()) {
      if (client.role !== 'speaker') continue;
      out.push({
        id: client.id,
        name: client.name,
        device: client.device,
        channel: client.channel,
        gain: client.gain,
        muted: client.muted,
        calibrationMs: client.calibrationMs,
        telemetry: client.telemetry,
        joinedAt: client.joinedAt,
      });
    }
    return out;
  }

  broadcastState() {
    const msg = this.stateMessage();
    for (const client of this.clients.values()) client.send(msg);
  }

  broadcastRoster({ toHostsOnly = false } = {}) {
    const msg = { type: 'roster', serverTime: serverNow(), speakers: this.rosterEntries() };
    for (const client of this.clients.values()) {
      if (toHostsOnly && client.role !== 'host') continue;
      client.send(msg);
    }
  }
}

const CHANNELS = new Set(['stereo', 'left', 'right']);

class Client {
  constructor({ id, ws, role, name, device, calibrationMs = 0 }) {
    this.id = id;
    this.ws = ws;
    this.role = role;
    this.name = name;
    this.device = device;
    this.joinedAt = serverNow();
    this.lastSeen = this.joinedAt;

    this.channel = 'stereo';
    this.gain = 1;
    this.muted = false;
    /** Per-device speaker latency trim in ms; positive = this phone starts earlier. */
    this.calibrationMs = calibrationMs;
    this.telemetry = null;
  }

  send(obj) {
    if (this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      /* socket died mid-send; the close handler will clean up */
    }
  }
}

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function defaultName(n) {
  return `Speaker ${n}`;
}

function sanitizeName(name) {
  return String(name ?? '')
    .replace(/[ -]/g, '')
    .trim()
    .slice(0, 32);
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
