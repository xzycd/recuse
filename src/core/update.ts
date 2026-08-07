/**
 * Checking whether a newer version was published.
 *
 * It checks and it tells you. It does not install anything, and that is a
 * deliberate line rather than an unfinished feature. A CLI that can update
 * itself is a CLI that will run whatever is at that name on the registry the
 * next time someone takes the name over or pushes a compromised version. The
 * install command is printed so a person decides.
 *
 * The check is also never allowed to make the tool slower or noisier: it is
 * capped at two seconds, cached for a day, off entirely without a terminal, and
 * every failure is silent. Nobody wants a version check to be the reason a
 * market lookup failed.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const REGISTRY = 'https://registry.npmjs.org/recuse/latest';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 2_000;

export interface UpdateStatus {
  current: string;
  latest?: string;
  behind: boolean;
  /** Why there is no answer. Empty when there is one. */
  reason?: string;
}

/** Where the cache lives. Honours the override so tests never touch a real home. */
export function cachePath(): string {
  const base = process.env.RECUSE_HOME || join(homedir(), '.recuse');
  return join(base, 'update.json');
}

/**
 * Compare two semver strings. Prerelease tags lose to their own release, which
 * is the only prerelease rule this needs.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre] = v.trim().replace(/^v/, '').split('-', 2);
    const parts = core.split('.').map((n) => Number.parseInt(n, 10));
    return { nums: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre };
  };

  const a = parse(candidate);
  const b = parse(current);

  for (let i = 0; i < 3; i++) {
    const x = a.nums[i] ?? 0;
    const y = b.nums[i] ?? 0;
    if (x !== y) return x > y;
  }

  // Same numbers: a release beats a prerelease of itself, nothing else moves.
  if (a.pre === undefined && b.pre !== undefined) return true;
  return false;
}

interface Cache {
  latest: string;
  checkedAt: number;
}

async function readCache(): Promise<Cache | undefined> {
  try {
    const raw = JSON.parse(await readFile(cachePath(), 'utf8')) as Partial<Cache>;
    if (typeof raw.latest !== 'string' || typeof raw.checkedAt !== 'number') return undefined;
    // A version string from disk gets the same shape check as one off the wire.
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(raw.latest)) return undefined;
    return { latest: raw.latest, checkedAt: raw.checkedAt };
  } catch {
    return undefined;
  }
}

async function writeCache(latest: string): Promise<void> {
  try {
    const path = cachePath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // 0600. There is nothing secret in here today, but this directory is the
    // obvious home for anything stateful added later, and a directory that
    // starts world-readable stays world-readable.
    await writeFile(path, JSON.stringify({ latest, checkedAt: Date.now() }), { mode: 0o600 });
  } catch {
    // A read-only or missing home is not a reason to fail a command.
  }
}

async function fetchLatest(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(REGISTRY, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
    });
    // 404 is not a failure to reach the registry, it is the registry saying
    // this name has nothing published under it. Someone running from a clone
    // sees this, and telling them the network is broken would be wrong.
    if (res.status === 404) throw new Error('not published to npm under this name');
    if (!res.ok) throw new Error(`registry answered ${res.status}`);

    const body = (await res.json()) as { version?: unknown };
    const version = body.version;
    if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error('registry returned no usable version');
    }
    return version;
  } finally {
    clearTimeout(timer);
  }
}

export interface CheckOptions {
  /** Skip the cache. What `recuse update` does. */
  force?: boolean;
}

/**
 * Is there a newer version?
 *
 * Never throws and never blocks for long. A failure comes back as a reason on
 * the status so a caller that wants to say so can, and the passive path can
 * ignore it.
 */
export async function checkForUpdate(
  current: string,
  opts: CheckOptions = {},
): Promise<UpdateStatus> {
  if (!opts.force && process.env.RECUSE_NO_UPDATE_CHECK) {
    return { current, behind: false, reason: 'disabled by RECUSE_NO_UPDATE_CHECK' };
  }

  if (!opts.force) {
    const cached = await readCache();
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      return { current, latest: cached.latest, behind: isNewer(cached.latest, current) };
    }
  }

  try {
    const latest = await fetchLatest();
    await writeCache(latest);
    return { current, latest, behind: isNewer(latest, current) };
  } catch (err) {
    return { current, behind: false, reason: (err as Error).message ?? 'check failed' };
  }
}

/** The line the radar prints when a newer version exists. */
export function updateNotice(status: UpdateStatus): string | undefined {
  if (!status.behind || !status.latest) return undefined;
  return `${status.current} installed, ${status.latest} published. npm i -g recuse`;
}
