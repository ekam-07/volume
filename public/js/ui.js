/** Small shared DOM helpers. Nothing clever, just less repetition. */

let toastTimer = null;

export function toast(message, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('bad', Boolean(isError));
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

export function $(id) {
  return document.getElementById(id);
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Classify a millisecond deviation into the three pill colours. */
export function driftClass(ms, tight = 15, loose = 40) {
  const abs = Math.abs(ms);
  if (!Number.isFinite(abs)) return 'bad';
  if (abs <= tight) return 'good';
  if (abs <= loose) return 'warn';
  return 'bad';
}

export function roomFromUrl() {
  return (new URLSearchParams(location.search).get('room') || '').toUpperCase();
}

/**
 * Ask the browser to keep the screen on. A phone acting as a speaker that
 * sleeps mid-song is the single most common way a room falls apart.
 */
export function keepAwake() {
  let lock = null;
  const request = async () => {
    try {
      lock = await navigator.wakeLock?.request('screen');
    } catch {
      /* denied or unsupported — nothing we can do about it */
    }
  };
  request();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !lock) request();
  });
  return () => lock?.release?.();
}
