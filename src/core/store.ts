/**
 * The daemon's memory, under ~/.recuse.
 *
 * Three files, all plain text, all greppable:
 *
 *   watchlist.json   markets the user named, as they typed them
 *   seen.json        the last snapshot of every market polled, for diffing
 *   events.jsonl     append only, one JSON object per line, never rewritten
 *
 * No database. The event log is the thing worth keeping and the thing that
 * compounds, and an append only text file is the format most likely to still be
 * readable in five years and easiest to back up in the meantime.
 *
 * Every write goes to a temporary file and is renamed into place. A watcher runs
 * for days and will eventually be killed in the middle of one, and a truncated
 * seen.json would silently re-baseline every market it contains.
 */

import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { safeHash, safeText } from './safe.js';
import type { Seen, WatchEvent } from './watch.js';

/**
 * How many markets to keep snapshots for.
 *
 * Discovery scans a moving window, so without a cap this grows forever with
 * markets nobody is watching any more. Oldest poll time is evicted first.
 */
const MAX_SEEN = 5_000;

export function home(): string {
  return process.env.RECUSE_HOME || join(homedir(), '.recuse');
}

export const paths = {
  watchlist: () => join(home(), 'watchlist.json'),
  seen: () => join(home(), 'seen.json'),
  events: () => join(home(), 'events.jsonl'),
  /**
   * The radar's own snapshot, deliberately not `seen.json`.
   *
   * Sharing one file would let a plain `recuse` run write baselines for markets
   * the watcher never polled, and the watcher decides whether to report an
   * event by whether it has a baseline. The daemon would then stay quiet about
   * the first real move on every market the radar happened to scan first. Two
   * readers with different jobs get two files.
   */
  radar: () => join(home(), 'radar.json'),
};

async function ensureHome(): Promise<void> {
  // 0700. Nothing in here is secret today, but a watchlist is a statement about
  // what someone is trading, and a directory that starts world readable stays
  // world readable.
  await mkdir(home(), { recursive: true, mode: 0o700 });
}

/** Write via a temporary file and rename, so a kill cannot truncate the real one. */
async function writeAtomic(path: string, body: string): Promise<void> {
  await ensureHome();
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, body, { mode: 0o600 });
  await rename(temp, path);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    // Missing is the normal first run. Corrupt is rare and recovers by starting
    // over, which costs one baseline pass and no data, since events are append
    // only and live in a different file.
    return fallback;
  }
}

export interface Watchlist {
  /** Condition ids or slugs, exactly as the user typed them. */
  markets: string[];
}

export async function readWatchlist(): Promise<Watchlist> {
  const raw = await readJson<Partial<Watchlist>>(paths.watchlist(), {});
  const markets = Array.isArray(raw.markets) ? raw.markets : [];

  // Re-validated on the way out, not trusted because we wrote it. A hand edited
  // watchlist is a supported thing to do and an expected way to get a bad value
  // into a URL.
  return {
    markets: [...new Set(markets.map((m) => safeText(m, 120)).filter(Boolean))],
  };
}

export async function writeWatchlist(list: Watchlist): Promise<void> {
  await writeAtomic(paths.watchlist(), `${JSON.stringify(list, null, 2)}\n`);
}

export async function addToWatchlist(target: string): Promise<{ added: boolean; list: Watchlist }> {
  const clean = safeText(target, 120);
  if (!clean) return { added: false, list: await readWatchlist() };

  const list = await readWatchlist();
  if (list.markets.includes(clean)) return { added: false, list };

  list.markets.push(clean);
  await writeWatchlist(list);
  return { added: true, list };
}

export async function removeFromWatchlist(
  target: string,
): Promise<{ removed: boolean; list: Watchlist }> {
  const clean = safeText(target, 120);
  const list = await readWatchlist();
  const before = list.markets.length;

  list.markets = list.markets.filter((m) => m !== clean);
  if (list.markets.length === before) return { removed: false, list };

  await writeWatchlist(list);
  return { removed: true, list };
}

export interface SeenState {
  /**
   * When the first pass finished. Its absence is what tells the comparator that
   * everything it is looking at is a baseline rather than news.
   */
  baselineAt?: string;
  markets: Record<string, Seen>;
}

async function readSnapshots(path: string): Promise<SeenState> {
  const raw = await readJson<Partial<SeenState>>(path, {});
  const markets: Record<string, Seen> = {};

  for (const [key, value] of Object.entries(raw.markets ?? {})) {
    // A key from this file goes on to be compared against a condition id from
    // Gamma, so it is shape checked rather than trusted.
    const id = safeHash(key);
    if (id && value && Array.isArray(value.steps)) markets[id] = value;
  }

  return { baselineAt: raw.baselineAt, markets };
}

async function writeSnapshots(path: string, state: SeenState): Promise<void> {
  const entries = Object.entries(state.markets);

  // Evict the least recently polled once over the cap. Discovery walks a moving
  // window, so without this the file grows forever with markets nobody watches.
  const kept =
    entries.length <= MAX_SEEN
      ? entries
      : entries.sort((a, b) => (b[1].at ?? '').localeCompare(a[1].at ?? '')).slice(0, MAX_SEEN);

  await writeAtomic(
    path,
    `${JSON.stringify({ baselineAt: state.baselineAt, markets: Object.fromEntries(kept) })}\n`,
  );
}

export async function readSeen(): Promise<SeenState> {
  return readSnapshots(paths.seen());
}

export async function writeSeen(state: SeenState): Promise<void> {
  await writeSnapshots(paths.seen(), state);
}

/** The radar's last reading. Same shape as the watcher's, different file. */
export async function readRadar(): Promise<SeenState> {
  return readSnapshots(paths.radar());
}

export async function writeRadar(state: SeenState): Promise<void> {
  await writeSnapshots(paths.radar(), state);
}

/**
 * Append events to the log.
 *
 * One JSON object per line, appended, never rewritten. `jq` reads it, `wc -l`
 * counts it, and a crash halfway through costs the last line rather than the
 * file.
 */
export async function appendEvents(events: WatchEvent[]): Promise<void> {
  if (events.length === 0) return;
  await ensureHome();
  await appendFile(
    paths.events(),
    `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
    { mode: 0o600 },
  );
}

/**
 * Read the event log back, newest first.
 *
 * Streams nothing and holds the file in memory, which is fine: a year of
 * disputes at the observed rate is a few megabytes.
 */
/**
 * How much of the log we are willing to hold in memory at once.
 *
 * The same reasoning as the 32MB cap on HTTP bodies, applied to the one file
 * this tool writes without bound. A watcher left running with `--discover` is
 * the only way to get here, so this is robustness rather than a defence, but
 * `recuse ledger` should not be the command that kills the machine after a
 * year of faithful logging.
 */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

export interface EventLog {
  events: WatchEvent[];
  /** Lines that would not parse. */
  skipped: number;
  /** Bytes on disk, so a caller can say what it did not read. */
  bytes: number;
  /** True when only the tail was read. Never a partial log presented as whole. */
  truncated: boolean;
}

export async function readEventLog(max = MAX_LOG_BYTES): Promise<EventLog> {
  let bytes = 0;
  let body: string;

  try {
    bytes = (await stat(paths.events())).size;

    if (bytes > max) {
      // Read the tail rather than the head: the recent past is what anyone is
      // asking about, and a log read from the front would summarise history
      // that has already scrolled out of relevance.
      const handle = await open(paths.events(), 'r');
      try {
        const buffer = Buffer.alloc(max);
        await handle.read(buffer, 0, max, bytes - max);
        body = buffer.toString('utf8');
      } finally {
        await handle.close();
      }
      // The first line is almost certainly cut in half by the seek. Dropping it
      // is correct; counting it as unreadable would be blaming the writer for
      // our own offset.
      body = body.slice(body.indexOf('\n') + 1);
    } else {
      body = await readFile(paths.events(), 'utf8');
    }
  } catch {
    return { events: [], skipped: 0, bytes: 0, truncated: false };
  }

  const events: WatchEvent[] = [];
  let skipped = 0;

  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as WatchEvent);
    } catch {
      // A partial last line from a kill mid-append. Counted, not hidden.
      skipped += 1;
    }
  }

  return { events, skipped, bytes, truncated: bytes > max };
}

/** The most recent events, newest first. */
export async function readEvents(limit = 50): Promise<{ events: WatchEvent[]; skipped: number }> {
  const { events, skipped } = await readEventLog();
  return { events: events.reverse().slice(0, limit), skipped };
}
