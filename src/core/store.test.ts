import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addToWatchlist, appendEvents, paths, readEvents, readSeen, readWatchlist,
  removeFromWatchlist, writeSeen,
} from './store.js';
import type { Seen, WatchEvent } from './watch.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'recuse-store-'));
  process.env.RECUSE_HOME = dir;
});

afterEach(async () => {
  delete process.env.RECUSE_HOME;
  await rm(dir, { recursive: true, force: true });
});

const event = (overrides: Partial<WatchEvent> = {}): WatchEvent =>
  ({
    at: '2026-08-07T09:30:00.000Z',
    kind: 'disputed',
    conditionId: `0x${'a'.repeat(64)}`,
    slug: 'zelenskyy-suit',
    question: 'Will Zelenskyy wear a suit before July?',
    rounds: 1,
    previousRounds: 0,
    phase: 'in-dispute',
    steps: ['proposed', 'disputed'],
    pool: 242_200_000,
    origin: 'watchlist',
    ...overrides,
  }) as WatchEvent;

const seen = (id: string): Seen => ({
  conditionId: id,
  slug: 's',
  question: 'q',
  steps: ['proposed'],
  settled: false,
  pool: 1,
  at: '2026-08-07T09:00:00.000Z',
});

describe('watchlist', () => {
  it('starts empty rather than failing when nothing was ever written', () => {
    return expect(readWatchlist()).resolves.toEqual({ markets: [] });
  });

  it('adds, refuses a duplicate, and removes', async () => {
    expect((await addToWatchlist('zelenskyy-suit')).added).toBe(true);
    expect((await addToWatchlist('zelenskyy-suit')).added).toBe(false);
    expect((await readWatchlist()).markets).toEqual(['zelenskyy-suit']);

    expect((await removeFromWatchlist('zelenskyy-suit')).removed).toBe(true);
    expect((await removeFromWatchlist('zelenskyy-suit')).removed).toBe(false);
    expect((await readWatchlist()).markets).toEqual([]);
  });

  it('sanitises what it reads back, because hand editing this file is supported', async () => {
    // A watchlist entry goes on to be interpolated into a URL, and a file the
    // user is invited to edit is an expected way to get a bad value in.
    await writeFile(paths.watchlist(), JSON.stringify({ markets: ['ok[2Jbad'] }));
    expect((await readWatchlist()).markets[0]).not.toContain('');
  });

  it('survives a corrupt file by starting over rather than throwing', async () => {
    await writeFile(paths.watchlist(), 'not json at all');
    await expect(readWatchlist()).resolves.toEqual({ markets: [] });
  });

  it('creates its files unreadable by anyone else', async () => {
    await addToWatchlist('zelenskyy-suit');
    const mode = (await stat(paths.watchlist())).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('seen state', () => {
  it('round trips, and remembers when the baseline was taken', async () => {
    const id = `0x${'a'.repeat(64)}`;
    await writeSeen({ baselineAt: '2026-08-07T09:00:00.000Z', markets: { [id]: seen(id) } });

    const back = await readSeen();
    expect(back.baselineAt).toBe('2026-08-07T09:00:00.000Z');
    expect(back.markets[id]?.steps).toEqual(['proposed']);
  });

  it('drops a key that is not a condition id', async () => {
    // These keys are compared against ids from Gamma, so a hand edited or
    // corrupted one is dropped rather than carried into a comparison.
    await writeFile(paths.seen(), JSON.stringify({ markets: { 'not-an-id': seen('x') } }));
    expect(Object.keys((await readSeen()).markets)).toEqual([]);
  });

  it('leaves no temporary file behind, so a rename actually happened', async () => {
    await writeSeen({ markets: {} });
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('evicts the least recently polled once over the cap', async () => {
    const markets: Record<string, Seen> = {};
    for (let i = 0; i < 5_010; i++) {
      const id = `0x${i.toString(16).padStart(64, '0')}`;
      markets[id] = { ...seen(id), at: new Date(1_700_000_000_000 + i * 1000).toISOString() };
    }
    await writeSeen({ markets });

    const back = await readSeen();
    expect(Object.keys(back.markets)).toHaveLength(5_000);
    // The oldest ten went, not the newest.
    expect(back.markets[`0x${(0).toString(16).padStart(64, '0')}`]).toBeUndefined();
    expect(back.markets[`0x${(5_009).toString(16).padStart(64, '0')}`]).toBeDefined();
  });
});

describe('event log', () => {
  it('returns nothing rather than failing before anything is written', async () => {
    await expect(readEvents()).resolves.toEqual({ events: [], skipped: 0 });
  });

  it('appends without rewriting, and reads back newest first', async () => {
    await appendEvents([event({ at: '2026-08-07T09:00:00.000Z' })]);
    await appendEvents([event({ at: '2026-08-07T10:00:00.000Z' })]);

    const { events } = await readEvents();
    expect(events.map((e) => e.at)).toEqual([
      '2026-08-07T10:00:00.000Z',
      '2026-08-07T09:00:00.000Z',
    ]);

    // Two appends, two lines, nothing overwritten.
    const body = await readFile(paths.events(), 'utf8');
    expect(body.trim().split('\n')).toHaveLength(2);
  });

  it('writes one line per event, so jq and wc work on it', async () => {
    await appendEvents([event(), event(), event()]);
    const body = await readFile(paths.events(), 'utf8');
    expect(body.trim().split('\n')).toHaveLength(3);
    for (const line of body.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('counts an unreadable line rather than hiding it or throwing', async () => {
    // What a process killed mid-append leaves behind.
    await appendEvents([event()]);
    await writeFile(paths.events(), `${JSON.stringify(event())}\n{"partial":`, { flag: 'a' });

    const { events, skipped } = await readEvents();
    expect(events).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it('writes nothing at all when there is nothing to write', async () => {
    await appendEvents([]);
    await expect(readFile(paths.events(), 'utf8')).rejects.toThrow();
  });

  it('honours the limit', async () => {
    await appendEvents([event(), event(), event(), event()]);
    expect((await readEvents(2)).events).toHaveLength(2);
  });
});
