import { Clock } from './sync.js';

/**
 * The room's socket: one WebSocket carrying JSON control messages, binary live
 * audio, and the clock-sync pings. Reconnects on its own, because a phone that
 * locks its screen for ten seconds should rejoin the room rather than drop out
 * of the song.
 */
export class Connection extends EventTarget {
  constructor({ room, role, name, device, calibrationMs = 0 }) {
    super();
    this.room = room;
    this.role = role;
    this.name = name;
    this.device = device;
    /**
     * This device's speaker-latency trim, sent with `hello`.
     *
     * It has to travel with the handshake rather than being applied afterwards:
     * a rejoining phone is a brand-new client to the server, so the roster it
     * receives says "trim 0", and anything that arrives later would be racing
     * that. Declaring it up front means the room never sees the phone untrimmed.
     */
    this.calibrationMs = calibrationMs;
    this.clock = new Clock((msg) => this.send(msg));
    this.state = null;
    this.clientId = null;
    this.status = 'connecting';
    this._ws = null;
    this._retry = 0;
    this._closedByUs = false;
  }

  connect() {
    this._closedByUs = false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      this._retry = 0;
      this._setStatus('syncing');
      this.send({
        type: 'hello',
        room: this.room,
        role: this.role,
        name: this.name,
        device: this.device,
        calibrationMs: this.calibrationMs,
      });
      this.clock.reset();
      this.clock.whenReady.then(() => this._setStatus('connected'));
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.dispatchEvent(new CustomEvent('chunk', { detail: event.data }));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === 'pong') {
        this.clock.onPong(msg);
        return;
      }
      if (msg.type === 'welcome') {
        this.clientId = msg.clientId;
      }
      if (msg.type === 'state') {
        this.state = msg;
      }
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    };

    ws.onclose = () => {
      this.clock.stop();
      if (this._closedByUs) return;
      this._setStatus('reconnecting');
      const delay = Math.min(500 * 2 ** this._retry++, 8000);
      setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* the close handler takes it from here */
      }
    };
  }

  close() {
    this._closedByUs = true;
    this.clock.stop();
    try {
      this._ws?.close();
    } catch {
      /* nothing to do */
    }
  }

  send(msg) {
    if (this._ws?.readyState !== WebSocket.OPEN) return false;
    this._ws.send(JSON.stringify(msg));
    return true;
  }

  sendBinary(buffer) {
    if (this._ws?.readyState !== WebSocket.OPEN) return false;
    if (this._ws.bufferedAmount > 1024 * 1024) return false;
    this._ws.send(buffer);
    return true;
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }
}

/** A short, human-ish description of the device, shown in the host's roster. */
export function describeDevice() {
  const ua = navigator.userAgent;
  const platform =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : 'Device';
  const browser =
    /CriOS|Chrome/.test(ua) ? 'Chrome'
    : /FxiOS|Firefox/.test(ua) ? 'Firefox'
    : /Safari/.test(ua) ? 'Safari'
    : 'Browser';
  return `${platform} · ${browser}`;
}
