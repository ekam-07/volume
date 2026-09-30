import express from 'express';
import multer from 'multer';
import qrcode from 'qrcode';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Rooms } from './rooms.js';
import { serverNow } from './clock.js';
import { createCatalog } from './catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

const PORT = Number(process.env.PORT) || 3000;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const rooms = new Rooms();
const catalog = createCatalog(UPLOAD_DIR);

app.use(express.json());
app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h', immutable: true }));

// ---------------------------------------------------------------------------
// Track upload
// ---------------------------------------------------------------------------

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname).slice(0, 10) || '.audio';
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 60 * 1024 * 1024 }, // 60 MB
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('audio/') || file.mimetype === 'application/octet-stream');
  },
});

app.post('/api/rooms/:code/tracks', upload.single('audio'), (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'room not found' });
  if (!req.file) return res.status(400).json({ error: 'no audio file' });

  const track = {
    id: path.parse(req.file.filename).name,
    title: (req.body.title || req.file.originalname || 'Untitled').slice(0, 200),
    url: `/uploads/${req.file.filename}`,
    bytes: req.file.size,
    duration: Number(req.body.duration) || null,
    addedAt: serverNow(),
  };

  room.tracks.push(track);
  rooms.broadcastState(room);
  res.json({ track });
});

// ---------------------------------------------------------------------------
// Open catalog
//
// An imported track becomes an ordinary room track, so everything downstream —
// download, decode, scheduled start, drift correction — is unchanged. This is
// why catalog playback keeps the full sync accuracy that Spotify cannot.
// ---------------------------------------------------------------------------

app.get('/api/catalog/providers', (_req, res) => res.json({ providers: catalog.providers() }));

app.get('/api/catalog/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'missing query' });
  try {
    res.json(await catalog.search(query, req.query.limit));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/catalog/trending', async (req, res) => {
  try {
    res.json(await catalog.trending(req.query.limit));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/rooms/:code/tracks/catalog', async (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'room not found' });

  try {
    const imported = await catalog.import(req.body?.source, req.body?.sourceId);
    const id = `${imported.source}-${imported.sourceId}`;
    const existing = room.tracks.find((t) => t.id === id);
    if (existing) return res.json({ track: existing, alreadyInRoom: true });

    const track = {
      id,
      title: imported.title,
      artist: imported.artist,
      artwork: imported.artwork,
      source: imported.source,
      sourceId: imported.sourceId,
      license: imported.license ?? null,
      url: `/uploads/${imported.filename}`,
      bytes: imported.bytes,
      duration: imported.duration,
      addedAt: serverNow(),
    };

    room.tracks.push(track);
    rooms.broadcastState(room);
    res.json({ track, cached: imported.cached });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

app.post('/api/rooms', async (_req, res) => {
  const room = rooms.create();
  res.json({ code: room.code, joinUrl: joinUrl(room.code) });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'room not found' });
  res.json({ code: room.code, speakers: room.speakerCount(), joinUrl: joinUrl(room.code) });
});

app.get('/api/rooms/:code/qr', async (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const png = await qrcode.toBuffer(joinUrl(room.code), {
    width: 480,
    margin: 1,
    color: { dark: '#0b0d10', light: '#ffffff' },
  });
  res.type('png').send(png);
});

app.get('/api/time', (_req, res) => res.json({ t: serverNow() }));

/**
 * Spotify needs a developer app the operator registers themselves. There is no
 * client secret here on purpose: the browser uses the PKCE flow, so the token
 * exchange never needs one and nothing confidential reaches the client.
 */
app.get('/api/config', (_req, res) => {
  res.json({
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null,
    catalogEnabled: true,
  });
});

app.get('/api/network', (_req, res) => {
  res.json({ addresses: localAddresses().map((ip) => `http://${ip}:${PORT}`) });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });
rooms.attach(wss);

// ---------------------------------------------------------------------------

function localAddresses() {
  const out = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

function joinUrl(code) {
  const host = process.env.PUBLIC_URL || `http://${localAddresses()[0] ?? 'localhost'}:${PORT}`;
  return `${host.replace(/\/$/, '')}/join.html?room=${code}`;
}

server.listen(PORT, '0.0.0.0', () => {
  const urls = localAddresses().map((ip) => `  http://${ip}:${PORT}`);
  console.log('\n  \x1b[1mvolume\x1b[0m — many phones, one speaker\n');
  console.log(`  local     http://localhost:${PORT}`);
  if (urls.length) console.log(`  network ${urls.join('\n          ')}`);
  console.log('\n  Open the network URL on the host phone. Others scan the QR code.\n');
});
