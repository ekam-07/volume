# volume

Turn a room full of phones into one speaker. One phone hosts, everyone else scans a QR
code, and the song plays on all of them at the same instant.

Measured on this machine: **three clients aligned to within 0.05 ms**, holding through
seeks, mid-song joins and a dropped connection — including tracks streamed from an open
catalog, not just local files.

```bash
npm install
npm start
npm test    # chirp detection + trim arithmetic
```

Open the printed network URL on the host phone, tap **Start a room**, and have everyone
else scan the code.

---

## How it stays in sync

The hard part isn't sending the song — it's that every phone has its own clock, its own
audio hardware and its own speaker latency, and all three disagree.

**1. A shared clock.** Each phone runs an NTP-style exchange over the WebSocket:
`offset = t1 - (t0 + t3) / 2`. One sample is ruined by network jitter, so
[`sync.js`](public/js/sync.js) keeps a window of 40, discards all but the fastest
quarter — a fast round trip has less room to be lopsided — and takes the median. Phones
never correct their own clock; they translate into *server time* and think in that from
then on.

**2. Download first, then play.** The host uploads a file; every phone fetches and
decodes it *completely* before playback. This is what makes tight sync possible: at the
moment the music starts, nothing is waiting on the network or the decoder. The host then
says "start at 14:32:05.250" — a single timestamp on a clock everyone agrees on. Lead
time scales with the worst round trip in the room, so one slow phone doesn't start late.

**3. Real output latency.** Scheduling against `AudioContext.currentTime` is not enough:
sound leaves the speaker tens of milliseconds after that. `getOutputTimestamp()` reports
which sample was actually audible and when, so [`player.js`](public/js/player.js)
schedules against the speaker rather than the buffer. In testing, two clients on the same
machine reported 76 ms and 68 ms of output latency — an 8 ms error if ignored.

**4. Continuous drift correction.** Starting together isn't staying together. Each
phone's audio crystal runs at its own rate, so devices that began aligned wander apart.
Every 500 ms the player compares where its hardware actually is against where the room
says it should be:

| Drift | Response |
|---|---|
| under 4 ms | left alone — correcting it would be audible churn |
| 4–60 ms | playback rate nudged by up to 0.4%, inaudible, absorbed over ~1 s |
| over 60 ms | hard reseek |

**5. Acoustic alignment.** The four mechanisms above all rest on the browser telling the
truth about its own speaker latency, and it frequently doesn't — which is the usual reason
a real room has some phones audibly ahead and some behind. See below.

---

## When some phones sound ahead and some behind

This is the one failure that survives everything above, and it has a specific cause:
**browsers don't reliably report their own speaker latency.** `outputLatency` is undefined
on iOS Safari and wrong on many Android builds, while the real path — mixer, DSP,
resampler, speaker driver, any Bluetooth in the chain — costs 50–150 ms.

A phone that underestimates its latency schedules too late, and then *stays* there. Drift
correction can't rescue it, because the phone is measuring against its own wrong idea of
when its sound emerges. A constant bias is invisible from the inside. Two phones with
different reporting quality end up tens of milliseconds apart and both convinced they are
perfect.

So stop asking the phone and **measure what actually comes out of it.**

### Align speakers by ear

Each phone plays a short chirp in turn while the host's microphone listens.
Cross-correlating the recording against the known chirp says when each phone was
*actually heard*.

The reason this can be trusted: **it never needs an absolute number.** The listening
phone's own microphone latency, its input buffering, the offset between its audio and wall
clocks — all identical across every measurement, so all of it cancels when phones are
aligned to the median of the group. What remains is exactly what a person in the room
hears, including the speed of sound across it.

Details that matter:

- **The listening phone measures itself too.** It has the same unknown latency as any
  other, so it takes its turn rather than being the assumed-correct reference.
- **Median, not mean.** One phone behind a sofa shouldn't drag everyone toward it.
- **Three chirps each, median of those**, so a door slam doesn't become a trim.
- **Each pass measures what's left after the current trims and adds to them**, so a second
  run refines the first instead of fighting it, and an aligned room measures near zero.
- **A phone that can't be heard is left alone**, never moved on no evidence.
- **Applying a trim doesn't restart playback** unless it's too large to absorb; small
  corrections are handed to the drift loop, which glides them in inaudibly.
- **Trims persist.** A trim describes the phone's hardware, not the session, so it is
  stored on the device and sent with the handshake — a rejoining phone is never briefly
  untrimmed.

### Line-up clicks

A click on every whole second of the shared clock, on every phone, scheduled exactly like
music. Walk the room: if one phone is audibly separate, that's real misalignment and no
measurement is needed to believe it. Good for confirming an alignment pass worked, and for
checking by ear before a crowd arrives.

### Stereo across the room

Assigning phones to **left** and **right** is what makes a pile of speakers sound *wide*
rather than merely loud. A side-assigned phone plays that one channel through both its
outputs. **Auto stereo** on the host splits the room in one tap.

---

## Three sources

| Source | Spread | Needs | Notes |
|---|---|---|---|
| **Library** — uploads + open catalogs | **~0.05 ms** | nothing | The real thing. Sounds like one speaker. |
| **Spotify** | ~150 ms | Premium *per listener*, HTTPS | Full catalog, audible echo. |
| **Live** — mic or tab audio | tens of ms | MediaSource/Opus | For a live set or a speech. |

### Library

Uploads and catalog tracks are the same thing downstream, which is the whole point.

**One search bar, several catalogues.** Type a song name and it queries every enabled
provider at once, interleaving the results so one catalogue can't bury the others. A
provider that stalls or fails is skipped rather than failing the search — partial results
beat an error page.

| Provider | API key | Notes |
|---|---|---|
| **Audius** | none | Artist-uploaded streaming catalogue |
| **Internet Archive** | none | `netlabels`, `etree`, `opensource_audio` |
| **Jamendo** | `JAMENDO_CLIENT_ID` | Optional; free key, large CC catalogue |

Archive results are restricted to collections that are open by policy, and items without
an explicit `licenseurl` are dropped (except `etree`, the Live Music Archive, where the
collection's admission policy *is* the licence — bands opt in to free distribution).
An Archive "item" is a folder rather than a track, so importing one reads its file list
and picks a single playable recording, skipping anything too long to import.

The server downloads each track **once** and serves it to the room, so ten phones on a
hotspot pull from the LAN instead of ten times from the internet. From there it is an
ordinary file: downloaded, decoded, scheduled, drift-corrected. Measured at 0.06 ms
across two clients on a streamed track — identical to a local file, because it *is* one.

**What this does not include: current commercial chart music.** No open catalogue has it,
and the licensed routes to it are the DRM ones described under Spotify below. A backend
that searched the web and pulled down arbitrary copyrighted tracks would be a piracy tool
regardless of framing, so it isn't here.

### Nothing downloads twice

Each phone keeps the encoded audio in IndexedDB ([`cache.js`](public/js/cache.js)),
capped at 300 MB with least-recently-used eviction. Three things follow:

- **Prefetch.** When a track is added to the library, every connected phone downloads it
  in the background immediately — before anyone presses play, and never competing with
  the track currently playing. The host shows `all 3 ready` when the room is armed.
- **Nothing re-downloads.** Reload the page, lock the screen, rejoin the room: a phone
  that already holds the track decodes it straight from disk. Verified with the Resource
  Timing API — **0 requests and 0 bytes** after a reload with 9 tracks cached, while a
  fresh device on a different origin pulled all 110 MB and armed itself unprompted.
- **Sync is unaffected.** A cached phone and a freshly-downloaded one measured 0.099 ms
  apart.

Encoded bytes are cached rather than decoded PCM: a four-minute stereo track is ~4 MB
encoded against ~42 MB decoded, and the re-decode costs a few hundred milliseconds well
before playback starts. A cache that is full, blocked or unavailable (private windows,
cleared site data) degrades to plain downloading rather than failing.

### Spotify

Works, but cannot be made tight, for reasons that belong to the API rather than to this
code. [`spotify.js`](public/js/spotify.js) documents them in full; briefly:

- **One account plays on one device.** Starting playback elsewhere stops the first. So
  every listener signs into their **own Premium account** — the host conducts N
  independent players rather than distributing audio.
- **The audio is DRM-protected.** The SDK decrypts through Widevine/EME and never exposes
  an AudioContext node, so `getOutputTimestamp()` latency compensation, `playbackRate`
  drift nudging and channel splitting are all unavailable. The entire control surface is
  `seek(ms)`, `resume()`, `pause()`.
- **So we converge instead of scheduling.** Each device polls its own position against the
  shared clock and re-seeks past a deliberately wide 150 ms deadband — a seek is more
  disruptive than the drift it corrects.

**Setup.** Create an app at [developer.spotify.com](https://developer.spotify.com), add
`https://your-host/spotify-callback.html` as a redirect URI, then:

```bash
SPOTIFY_CLIENT_ID=your_client_id npm start
```

Auth is PKCE, so there is no client secret anywhere — nothing confidential reaches the
browser and none is needed on the server.

**Spotify needs HTTPS.** `localhost` counts as a secure context; a bare LAN address like
`http://192.168.1.x:3000` does not, and DRM is silently blocked there. This is the single
most common reason Spotify mode refuses to play on a phone — the page detects it and says
so rather than failing quietly. Use a tunnel (`cloudflared tunnel --url http://localhost:3000`)
or a certificate. Library mode has no such requirement.

### Live

Streams the host's microphone or a shared tab in near real time. A fundamentally looser
kind of sync: the audio is still arriving while it plays, so each phone holds a jitter
buffer and everyone sits ~600 ms behind capture. Every receiver aims at the same
*absolute* target on the shared clock ("play what was captured 600 ms ago"), so phones
converge on each other rather than each drifting to its own buffer level.

Needs MediaSource with WebM/Opus — Android Chrome and desktop browsers. **iOS Safari
cannot receive it**, and the page says so rather than failing silently.

A note on an appealing dead end: playing Spotify on the host and capturing the tab through
live mode does not work. Chrome deliberately returns **silence** when screen-capturing DRM
content, and it would be redistributing audio rather than each person streaming from their
own account.

---

## Getting everyone connected

| | Shared Wi-Fi needed? | Notes |
|---|---|---|
| **Same Wi-Fi** | yes | Best case. Lowest latency, nothing to configure. |
| **Host phone's hotspot** | no | Fully offline. Just as tight. |
| **Deployed to the internet** | no | Each phone on its own mobile data, from anywhere. |

The sync algorithm doesn't care which. Because the song is downloaded before it plays,
the network only carries clock pings and a start timestamp — so a deployed server over
mobile data sounds the same as a LAN, it just takes longer to hand out the file. Set
`PUBLIC_URL` so the QR code points at the public address.

### Why not Bluetooth

It cannot do this, and not for a fixable reason:

- **Phones can't receive Bluetooth audio from each other.** A phone is an A2DP *source*,
  not a sink. There is no supported way to make one phone another's speaker.
- **Web Bluetooth doesn't exist on iOS**, and on Android it's BLE-only — a few KB/s, and
  roughly 7 connections.
- **Latency is 100–200 ms and varies per device.** Sounding like one speaker needs
  alignment within ~20 ms. You can't correct what you can't measure, and Bluetooth
  doesn't tell you its delay.

Auracast (LE Audio broadcast) is the real one-to-many standard, but it needs hardware
almost no phone has and there's no browser API for it.

---

## Layout

```
server/
  index.js      HTTP, uploads, catalog routes, QR, static
  rooms.js      room state, command handling, live relay
  clock.js      the one monotonic wall clock
  catalog.js    multi-provider search + download-once cache
  providers/    audius.js, archive.js, jamendo.js
public/js/
  sync.js       NTP-style clock estimation
  player.js     Web Audio scheduling + drift correction
  cache.js      per-device IndexedDB audio cache (LRU)
  live.js       broadcaster (MediaRecorder) + receiver (MediaSource)
  spotify.js    PKCE auth + Web Playback SDK + convergence loop
  calibrate.js  chirp, cross-correlation, line-up metronome
  align.js      alignment pass + trim arithmetic
  engine.js     shared speaker behaviour + background prefetch
  net.js        WebSocket with reconnect
  host.js       host console
  join.js       speaker page
test/
  chirp.test.mjs  detection accuracy against synthetic recordings
  trims.test.mjs  trim arithmetic
```

**Adding a catalogue** means one file in `providers/` exporting `{id, label, enabled,
search, trending, resolve}`, where `resolve` returns a real audio URL. `catalog.js` does
the fan-out, download, size-capping and caching uniformly.

Both pages expose `window.__volume = { connection, engine }` for console debugging:

```js
const { engine, connection } = window.__volume;
const p = engine.player, m = p._mapping();
// the track position this phone's hardware is actually emitting, and when
({ at: connection.clock.toServer(m.perfTime),
   pos: p._startTrackOffset + (m.ctxTime - p._startCtxTime) * p._rate });
```

Run that in two clients and compare — the difference between the position deltas and the
time deltas is the true misalignment, independent of what either one reports.

---

## Known limits

- **The 0.05 ms figures are between browser tabs on one machine.** Two tabs share one audio
  device, so they cannot diverge the way real phones do. Those numbers validate the
  scheduling maths and the clock sync; they say nothing about speaker-latency spread, which
  is what alignment exists to fix. Real phones start wider and need a pass.
- **The acoustic measurement itself is untested against real hardware.** The detector is
  tested hard against synthetic recordings — sample-exact under heavy noise, and it rejects
  pure noise — and the trim arithmetic has its own tests. But microphone → air → speaker
  has only been reasoned about, not run. Expect to tune `MIN_PEAK_Z` if a real room proves
  noisier than the synthetic ones.
- **Alignment needs a reasonably quiet moment.** Phones at low volume, a loud room, or a
  listening phone across the room from the others will show up as "could not be heard"
  rather than a bad trim — deliberately, since a false detection would mis-trim confidently.
- **Backgrounded phones go quiet.** iOS and Android suspend the audio context when the
  screen locks or the tab leaves the foreground. The page requests a wake lock and
  resyncs on return, but the fix for a long session is a native app.
- **Spotify mode is untested against a live account.** The PKCE flow, auth URL, scopes,
  mode switching and the HTTPS detection are all verified; the SDK playback path needs a
  real client ID and a Premium account to exercise, which I did not have.
- **Uploads are capped at 60 MB**, catalog imports at 80 MB (long DJ sets and radio shows
  are common). Both live under `uploads/`, and the server-side cache is never swept — only
  the per-phone cache evicts.
- **Prefetch pulls the whole library onto every phone.** Fine for a party playlist; add a
  cap before letting a room accumulate hundreds of tracks.
- **Rooms are in memory.** Restarting the server empties them.
- **No authentication.** Anyone with the 4-character code can join, and there is no rate
  limit on room creation or uploads. Fine on a hotspot; add both before deploying it
  publicly.
