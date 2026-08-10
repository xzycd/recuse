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

import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { safeHash, safeText } from './safe.js';
import type { EventKind, Seen, WatchEvent } from './watch.js';
import type { Concentration, DisputeState, ResolutionStep } from '../types.js';

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
  watchLock: () => join(home(), 'watch.lock'),
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means a process exists but this user cannot signal it. ESRCH means
    // the pid is gone and the lease can be reclaimed. An unfamiliar failure is
    // treated as alive, because deleting a live lease is the unsafe direction.
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
    return code !== 'ESRCH';
  }
}

/** Hold one watcher lease per state directory. */
export async function acquireWatchLock(): Promise<() => Promise<void>> {
  await ensureHome();
  const path = paths.watchLock();
  const recoveryPath = `${path}.recovery`;
  const nonce = randomUUID();

  const create = async (target: string, leaseNonce: string) => {
    const handle = await open(target, 'wx', 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, nonce: leaseNonce, startedAt: new Date().toISOString() }),
        'utf8',
      );
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => {});
      await unlink(target).catch(() => {});
      throw err;
    } finally {
      await handle.close().catch(() => {});
    }
  };

  try {
    await create(path, nonce);
  } catch (err) {
    const exists = typeof err === 'object' && err !== null && 'code' in err
      && (err as { code?: unknown }).code === 'EEXIST';
    if (!exists) throw err;

    // Stale lease replacement needs its own exclusive gate. Without it, two
    // processes can both read the same dead pid, then the slower one can unlink
    // the fresh lease the faster one just created. The recovery lease makes
    // stale removal single-writer while normal first acquisition stays one
    // atomic `wx` open.
    const recoveryNonce = randomUUID();
    try {
      await create(recoveryPath, recoveryNonce);
    } catch (recoveryError) {
      const recoveryExists = typeof recoveryError === 'object' && recoveryError !== null
        && 'code' in recoveryError && (recoveryError as { code?: unknown }).code === 'EEXIST';
      if (recoveryExists) throw new Error('watch lock recovery is already in progress; retry');
      throw recoveryError;
    }

    try {
      let owner: { pid?: unknown } | undefined;
      try {
        owner = record(JSON.parse(await readFile(path, 'utf8')) as unknown);
      } catch (readError) {
        if (!isMissing(readError)) throw new Error(`watch lock is unreadable: ${path}`);
      }
      const pid = owner?.pid;
      if (!owner || !Number.isSafeInteger(pid) || (pid as number) <= 0) {
        throw new Error(`watch lock is unreadable: ${path}`);
      }
      if (processIsAlive(pid as number)) {
        throw new Error(`another watcher is already running with pid ${pid}`);
      }

      // The recorded process is gone. Removing only this narrow lease file lets
      // a scheduler recover after a kill without making any state deletion broad.
      await unlink(path);
      await create(path, nonce);
    } finally {
      try {
        const recovery = record(JSON.parse(await readFile(recoveryPath, 'utf8')) as unknown);
        if (recovery?.nonce === recoveryNonce) await unlink(recoveryPath);
      } catch (releaseError) {
        if (!isMissing(releaseError)) throw releaseError;
      }
    }
  }

  return async () => {
    try {
      const owner = record(JSON.parse(await readFile(path, 'utf8')) as unknown);
      if (owner?.nonce === nonce) await unlink(path);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  };
}

async function ensureHome(): Promise<void> {
  // 0700. Nothing in here is secret today, but a watchlist is a statement about
  // what someone is trading, and a directory that starts world readable stays
  // world readable.
  await mkdir(home(), { recursive: true, mode: 0o700 });
  // `mode` only applies when mkdir creates the directory. Repair an existing
  // directory too, since it may predate this safeguard or have been restored
  // from a backup with broader permissions.
  await chmod(home(), 0o700);
}

/** Write via a temporary file and rename, so a kill cannot truncate the real one. */
async function writeAtomic(path: string, body: string): Promise<void> {
  await ensureHome();
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    // `wx` prevents a stale or adversarial path from being followed. The UUID
    // also makes concurrent writers use different staging files.
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    await chmod(path, 0o600);

    // Make the rename durable where directory fsync is supported. Failure to
    // fsync a directory on a platform that does not allow it is not a reason to
    // discard a file already safely renamed into place.
    try {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync().catch(() => {});
      } finally {
        await directory.close();
      }
    } catch {
      // Some platforms do not permit opening a directory as a file. The data
      // file was already flushed and renamed, so durability still improved.
    }
  } catch (err) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw err;
  }
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as { code?: unknown }).code === 'ENOENT';
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    const body = await readFile(path, 'utf8');
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`state file is not valid JSON: ${path}`);
    }
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface Watchlist {
  /** Condition ids or slugs, exactly as the user typed them. */
  markets: string[];
}

export async function readWatchlist(): Promise<Watchlist> {
  const decoded = await readJson(paths.watchlist());
  if (decoded === undefined) return { markets: [] };
  const raw = record(decoded);
  if (!raw || (raw.markets !== undefined && !Array.isArray(raw.markets))) {
    throw new Error(`watchlist has an invalid shape: ${paths.watchlist()}`);
  }
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
  const decoded = await readJson(path);
  if (decoded === undefined) return { markets: {} };
  const raw = record(decoded);
  if (!raw || (raw.markets !== undefined && !record(raw.markets))) {
    throw new Error(`snapshot has an invalid shape: ${path}`);
  }
  const markets: Record<string, Seen> = {};

  for (const [key, value] of Object.entries(record(raw.markets) ?? {})) {
    // A key from this file goes on to be compared against a condition id from
    // Gamma, so it is shape checked rather than trusted.
    const id = safeHash(key);
    const seen = toSeen(value, id);
    if (!id || !seen) throw new Error(`snapshot contains an invalid market record: ${path}`);
    markets[id] = seen;
  }

  const baselineAt = isoDate(raw.baselineAt);
  if (raw.baselineAt !== undefined && !baselineAt) {
    throw new Error(`snapshot contains an invalid baseline time: ${path}`);
  }
  return { ...(baselineAt ? { baselineAt } : {}), markets };
}

const STEPS = new Set<ResolutionStep>(['proposed', 'disputed', 'resolved', 'reset', 'unknown']);
const EVENT_KINDS = new Set<EventKind>([
  'proposed', 'disputed', 'resolved', 'reset', 'settled', 'appeared', 'rewritten',
]);
const PHASES = new Set<DisputeState['phase']>(['undisputed', 'proposed', 'in-dispute', 'settled']);

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function integerNonnegative(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function stepsOf(value: unknown): ResolutionStep[] | undefined {
  return Array.isArray(value) && value.every((step): step is ResolutionStep => STEPS.has(step as ResolutionStep))
    ? value
    : undefined;
}

function toSeen(value: unknown, expectedId?: string): Seen | undefined {
  const raw = record(value);
  const conditionId = safeHash(raw?.conditionId);
  const steps = stepsOf(raw?.steps);
  const at = isoDate(raw?.at);
  const pool = finiteNonnegative(raw?.pool);
  if (!raw || !conditionId || (expectedId && conditionId !== expectedId) || !steps || !at || pool === undefined) {
    return undefined;
  }
  if (typeof raw.settled !== 'boolean') return undefined;

  return {
    conditionId,
    slug: safeText(raw.slug, 120),
    question: safeText(raw.question) || '(untitled market)',
    steps,
    settled: raw.settled,
    pool,
    at,
  };
}

function toConcentration(value: unknown): Concentration | undefined {
  const raw = record(value);
  const topN = integerNonnegative(raw?.topN);
  const holderCount = integerNonnegative(raw?.holderCount);
  const topShare = finiteNonnegative(raw?.topShare);
  const topSize = finiteNonnegative(raw?.topSize);
  const totalSize = finiteNonnegative(raw?.totalSize);
  const floor = raw?.floor === undefined ? undefined : finiteNonnegative(raw.floor);
  if (
    !raw || (raw.side !== 'YES' && raw.side !== 'NO')
    || !['wiped', 'redeemed', 'leading'].includes(String(raw.meaning))
    || (raw.basis !== 'balances' && raw.basis !== 'trades')
    || topN === undefined || topN < 1 || holderCount === undefined || holderCount < topN
    || topShare === undefined || topShare > 1
    || topSize === undefined || totalSize === undefined || topSize > totalSize
    || (raw.floor !== undefined && floor === undefined)
  ) return undefined;

  return {
    side: raw.side,
    meaning: raw.meaning as Concentration['meaning'],
    basis: raw.basis,
    topN,
    topShare,
    topSize,
    totalSize,
    holderCount,
    ...(floor === undefined ? {} : { floor }),
  };
}

function toEvent(value: unknown): WatchEvent | undefined {
  const raw = record(value);
  const at = isoDate(raw?.at);
  const conditionId = safeHash(raw?.conditionId);
  const steps = stepsOf(raw?.steps);
  const pool = finiteNonnegative(raw?.pool);
  const rounds = integerNonnegative(raw?.rounds);
  const previousRounds = integerNonnegative(raw?.previousRounds);
  const kind = raw?.kind as EventKind;
  const phase = raw?.phase as DisputeState['phase'];
  const origin = raw?.origin;
  if (
    !raw || !at || !conditionId || !steps || pool === undefined
    || rounds === undefined || previousRounds === undefined
    || !EVENT_KINDS.has(kind) || !PHASES.has(phase)
    || (origin !== 'watchlist' && origin !== 'discovery')
  ) return undefined;

  const deadline = isoDate(raw.deadline);
  const concentration = raw.concentration === undefined
    ? undefined
    : toConcentration(raw.concentration);
  if (raw.concentration !== undefined && !concentration) return undefined;
  return {
    at,
    kind,
    conditionId,
    slug: safeText(raw.slug, 120),
    question: safeText(raw.question) || '(untitled market)',
    rounds,
    previousRounds,
    phase,
    steps,
    pool,
    ...(deadline ? { deadline } : {}),
    origin,
    ...(concentration ? { concentration } : {}),
    ...(typeof raw.detailFailed === 'string'
      ? { detailFailed: safeText(raw.detailFailed, 300) }
      : {}),
  };
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
  const handle = await open(paths.events(), 'a', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

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
  const maxBytes = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_LOG_BYTES;
  let bytes = 0;
  let body: string;

  try {
    bytes = (await stat(paths.events())).size;

    if (bytes > maxBytes) {
      // Read the tail rather than the head: the recent past is what anyone is
      // asking about, and a log read from the front would summarise history
      // that has already scrolled out of relevance.
      const handle = await open(paths.events(), 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        await handle.read(buffer, 0, maxBytes, bytes - maxBytes);
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
  } catch (err) {
    if (isMissing(err)) return { events: [], skipped: 0, bytes: 0, truncated: false };
    throw err;
  }

  const events: WatchEvent[] = [];
  let skipped = 0;

  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = toEvent(JSON.parse(line) as unknown);
      if (event) events.push(event);
      else skipped += 1;
    } catch {
      // A partial last line from a kill mid-append. Counted, not hidden.
      skipped += 1;
    }
  }

  return { events, skipped, bytes, truncated: bytes > maxBytes };
}

/** The most recent events, newest first. */
export async function readEvents(limit = 50): Promise<{ events: WatchEvent[]; skipped: number }> {
  const { events, skipped } = await readEventLog();
  const requested = Number.isFinite(limit) ? Math.min(10_000, Math.max(0, Math.floor(limit))) : 50;
  return { events: events.reverse().slice(0, requested), skipped };
}
