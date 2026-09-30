import { performance } from 'node:perf_hooks';

/**
 * A single monotonic, high-resolution wall clock shared by every room.
 *
 * `Date.now()` has millisecond granularity and can jump backwards when NTP
 * adjusts the host machine's clock — either of which would show up as audible
 * drift between phones. `performance.timeOrigin + performance.now()` is the
 * same epoch but with sub-millisecond resolution and no jumps.
 *
 * Every timestamp exchanged with clients is in this domain. Clients never
 * compare their own `Date.now()` to anything; they estimate their offset from
 * this clock and work in server time from then on.
 */
export function serverNow() {
  return performance.timeOrigin + performance.now();
}
