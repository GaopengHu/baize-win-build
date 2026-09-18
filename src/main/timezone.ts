/**
 * @module main/timezone
 *
 * Timezone normalization. Must run before anything else in the main process
 * (`src/main/index.ts` imports this module first).
 *
 * ## Why this exists
 *
 * UOS/Deepin patches tzdata and registers extra Chinese city aliases in
 * `/usr/share/zoneinfo/zone.tab` (Asia/Beijing, Asia/Chengdu, Asia/Nanjing,
 * Asia/Wuhan, Asia/Xian, ...). Choosing "Beijing" in the OS timezone settings
 * makes `/etc/localtime` point at `/usr/share/zoneinfo/Asia/Beijing`.
 *
 * ICU/CLDR — the timezone database shared by Node, the Electron main process and
 * every Chromium renderer — only ships upstream IANA names, so:
 *
 *   new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Beijing' })  // RangeError
 *   Intl.supportedValuesOf('timeZone').includes('Asia/Beijing')    // false
 *
 * Chromium therefore cannot name the local timezone and silently degrades to
 * `Etc/Unknown` / UTC. Measured on UOS 20 with `/etc/localtime -> Asia/Beijing`
 * (tzdata 2021a.1-0+deb10u1, Electron 22.3.27):
 *
 *   renderer : getTimezoneOffset() === 0            (should be -480)
 *              Intl...resolvedOptions().timeZone === 'Etc/Unknown'
 *              new Date('2026-09-16T14:11').getTime() === 1789567860000  // 14:11Z
 *   main     : getTimezoneOffset() === -480, Intl...timeZone === undefined
 *
 * Consequence: a task typed as 14:11 is stored as 14:11Z and actually runs at
 * 22:11 local time — exactly 8 hours late. The scheduler's arithmetic was never
 * wrong, the wall-clock input was.
 *
 * ## Fix
 *
 * Set `process.env.TZ` to a name ICU recognizes, as early as possible. Chromium
 * child processes inherit the main process environment at spawn time, so one
 * assignment here fixes the renderer as well. Verified with a real Electron
 * 22.3.27 probe: after the assignment the renderer reports
 * `getTimezoneOffset() === -480`, `timeZone === 'Asia/Shanghai'` and parses
 * `'2026-09-16T14:11'` correctly — even when the assignment happens inside
 * `app.whenReady()`, so module load order is not critical.
 *
 * A candidate zone is only accepted when it reproduces the UTC offsets the
 * process already observes (sampled across the year), so this can never silently
 * shift the wall clock and never flattens DST zones into a fixed offset.
 */
import * as fs from 'fs';

export type TimeZoneSource =
  | 'env'
  | 'env-normalized'
  | 'system'
  | 'system-normalized'
  | 'unchanged';

export interface TimeZoneResolution {
  /** Raw zone name found in the environment or on disk (may be ICU-unknown). */
  detected: string | null;
  /** Value written to `process.env.TZ`, or null when nothing was changed. */
  applied: string | null;
  source: TimeZoneSource;
  /** Human readable explanation, surfaced in the startup log. */
  reason: string | null;
}

/**
 * Distro-specific aliases that ICU/CLDR does not ship.
 * Their tzdata files are byte-identical to the canonical counterpart
 * (`cmp /usr/share/zoneinfo/Asia/{Beijing,Shanghai}` succeeds), i.e. UTC+8 with
 * no DST since 1991.
 */
const ZONE_ALIASES: Record<string, string> = {
  'Asia/Beijing': 'Asia/Shanghai',
  'Asia/Chengdu': 'Asia/Shanghai',
  'Asia/Nanjing': 'Asia/Shanghai',
  'Asia/Wuhan': 'Asia/Shanghai',
  'Asia/Xian': 'Asia/Shanghai',
  'Asia/Harbin': 'Asia/Shanghai',
  'Asia/Chongqing': 'Asia/Shanghai',
  'Asia/Kashgar': 'Asia/Urumqi',
  PRC: 'Asia/Shanghai',
};

/**
 * Sample instants (days from now). Three points spread over a year are enough to
 * capture both the standard and the DST state of any annual DST rule.
 */
const OFFSET_SAMPLE_DAYS = [0, 120, 240];
const DAY_MS = 86_400_000;

function isIcuKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * UTC offset (minutes) of `zone` at `timestamp`, independent of the process
 * timezone. Returns null when ICU rejects the zone.
 */
function zoneOffsetMinutes(zone: string, timestamp: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(timestamp));
    const read = (type: Intl.DateTimeFormatPartTypes): number => {
      const value = parts.find((part) => part.type === type)?.value;
      return value === undefined ? NaN : Number(value);
    };
    const localAsUtc = Date.UTC(
      read('year'),
      read('month') - 1,
      read('day'),
      read('hour'),
      read('minute'),
      read('second')
    );
    if (!Number.isFinite(localAsUtc)) return null;
    const timestampMs = Math.floor(timestamp / 1000) * 1000;
    return Math.round((localAsUtc - timestampMs) / 60_000);
  } catch {
    return null;
  }
}

/**
 * True when `zone` behaves exactly like the timezone this process actually runs
 * in. `new Date().getTimezoneOffset()` is used as the reference because V8
 * resolves the system timezone correctly even for ICU-unknown names.
 */
function reproducesSystemOffsets(zone: string): boolean {
  for (const dayOffset of OFFSET_SAMPLE_DAYS) {
    const timestamp = Date.now() + dayOffset * DAY_MS;
    const candidateOffset = zoneOffsetMinutes(zone, timestamp);
    const systemOffset = -new Date(timestamp).getTimezoneOffset();
    if (candidateOffset === null || candidateOffset !== systemOffset) {
      return false;
    }
  }
  return true;
}

/** Zone name of the host, from `/etc/localtime` (preferred) or `/etc/timezone`. */
function readSystemZoneName(): string | null {
  try {
    const target = fs.readlinkSync('/etc/localtime');
    const marker = '/zoneinfo/';
    const index = target.lastIndexOf(marker);
    if (index >= 0 && index + marker.length < target.length) {
      return target.slice(index + marker.length);
    }
  } catch {
    // Not a symlink (or unreadable) — fall through to /etc/timezone.
  }
  try {
    const fromTimezoneFile = fs.readFileSync('/etc/timezone', 'utf8').trim();
    if (fromTimezoneFile) return fromTimezoneFile;
  } catch {
    // /etc/timezone is optional.
  }
  return null;
}

/** `Etc/GMT±N` name for the process's current offset (POSIX signs are inverted). */
function fixedOffsetZoneName(): string | null {
  const offsetMinutes = -new Date().getTimezoneOffset();
  if (!Number.isFinite(offsetMinutes) || offsetMinutes % 60 !== 0) return null;
  const hours = offsetMinutes / 60;
  if (hours === 0) return 'UTC';
  return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
}

/** Map a possibly ICU-unknown zone name to one ICU accepts and that matches the system. */
function resolveZoneName(detected: string): { zone: string; reason: string | null } | null {
  if (isIcuKnownZone(detected) && reproducesSystemOffsets(detected)) {
    return { zone: detected, reason: null };
  }

  const alias = ZONE_ALIASES[detected];
  if (alias && isIcuKnownZone(alias) && reproducesSystemOffsets(alias)) {
    return {
      zone: alias,
      reason: `${detected} is a distro-specific tzdata alias missing from ICU/CLDR; normalized to ${alias}`,
    };
  }

  const fixedOffset = fixedOffsetZoneName();
  if (fixedOffset && isIcuKnownZone(fixedOffset) && reproducesSystemOffsets(fixedOffset)) {
    return {
      zone: fixedOffset,
      reason: `${detected} is unknown to ICU/CLDR; degraded to fixed offset ${fixedOffset}`,
    };
  }

  return null;
}

export function resolveSystemTimeZone(): TimeZoneResolution {
  const fromEnv = process.env.TZ?.trim();
  if (fromEnv) {
    const resolved = resolveZoneName(fromEnv);
    if (!resolved) {
      return {
        detected: fromEnv,
        applied: null,
        source: 'unchanged',
        reason: `TZ=${fromEnv} cannot be resolved by ICU; left untouched`,
      };
    }
    return {
      detected: fromEnv,
      applied: resolved.zone,
      source: resolved.zone === fromEnv ? 'env' : 'env-normalized',
      reason: resolved.reason,
    };
  }

  // Only Linux ships the tzdata alias problem; Windows/macOS resolve the system
  // timezone through OS APIs that ICU understands.
  const systemZone = process.platform === 'linux' ? readSystemZoneName() : null;
  if (systemZone) {
    const resolved = resolveZoneName(systemZone);
    if (!resolved) {
      return {
        detected: systemZone,
        applied: null,
        source: 'unchanged',
        reason: `system timezone ${systemZone} cannot be resolved by ICU; left untouched`,
      };
    }
    return {
      detected: systemZone,
      applied: resolved.zone,
      source: resolved.zone === systemZone ? 'system' : 'system-normalized',
      reason: resolved.reason,
    };
  }

  return { detected: null, applied: null, source: 'unchanged', reason: null };
}

export function applySystemTimeZone(): TimeZoneResolution {
  const resolution = resolveSystemTimeZone();
  if (resolution.applied) {
    process.env.TZ = resolution.applied;
  }
  return resolution;
}

/** Resolution for the current process, computed once at module load. */
export const systemTimeZone: TimeZoneResolution = applySystemTimeZone();
