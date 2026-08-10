/**
 * One pass of the watcher, and the loop that repeats it.
 *
 * The pure comparison lives in `watch.ts` and the persistence in `store.ts`.
 * This is the part that does I/O and decides what a failure means, the same
 * division as `assess.ts`.
 *
 * The rule that shapes all of it: a market that could not be read produces no
 * event and is counted separately. "Nothing happened" and "we did not look" are
 * different statements, and a watcher that conflates them is the same bug as an
 * oracle scan reporting zero after all its windows errored.
 */

import { assess } from './assess.js';
import { appendEvents, readSeen, readWatchlist, writeSeen } from './store.js';
import { compare, passesFilters } from './watch.js';
import { deliver } from './notify.js';
import { fetchContestedMarkets, fetchMarket } from '../sources/gamma.js';
import { redactMessage } from './safe.js';
import type { EventKind, Seen, WatchEvent } from './watch.js';
import type { Market } from '../types.js';

export interface PassOptions {
  /** Also scan for disputes on markets nobody named. */
  discover: boolean;
  /** How many markets discovery walks. */
  scan: number;
  minPool?: number;
  kinds?: Set<EventKind>;
  /** Attach holder concentration to each event. One request per event, not per market. */
  detail: boolean;
  webhook?: string;
  now?: Date;
}

export interface PassResult {
  events: WatchEvent[];
  /** Markets successfully read this pass. */
  polled: number;
  /** Named markets that could not be read. Never counted as unchanged. */
  failed: string[];
  /** True when this pass established the baseline and therefore reported nothing. */
  baseline: boolean;
  /** Events that were produced and then filtered out, with the reason implied. */
  suppressed: number;
  /** Webhook failures this pass. */
  undelivered: number;
}

/** Decide whether a pass actually established a usable baseline. */
export function baselineAfterPass(
  existing: string | undefined,
  answered: boolean,
  now: Date,
): { baselineAt?: string; established: boolean } {
  if (existing) return { baselineAt: existing, established: false };
  return answered
    ? { baselineAt: now.toISOString(), established: true }
    : { established: false };
}

/**
 * Attach who held what to an event.
 *
 * Best effort, and only for events, which are rare. Doing it for every polled
 * market would multiply the request count by the size of the watchlist to
 * decorate rows nobody is going to read.
 *
 * Memoised per market for the length of one pass. A lifecycle that grew by
 * three steps produces three events on the same market, and the holders behind
 * them are identical, so looking them up once is both faster and politer.
 */
function detailCache() {
  const cache = new Map<string, Promise<Partial<WatchEvent>>>();

  return async function addDetail(event: WatchEvent, market: Market): Promise<WatchEvent> {
    let pending = cache.get(market.conditionId);

    if (!pending) {
      pending = assess(market, { winners: false })
        .then((assessment) =>
          assessment.concentration
            ? { concentration: assessment.concentration }
            : { detailFailed: 'no holders returned' },
        )
        // An alert that arrives without the extra detail beats an alert that
        // does not arrive, so this never propagates.
        .catch((err: Error) => ({
          detailFailed: redactMessage(err.message ?? 'holder lookup failed'),
        }));
      cache.set(market.conditionId, pending);
    }

    return { ...event, ...(await pending) };
  };
}

/**
 * Poll once: read everything being watched, diff it, record and report.
 *
 * Markets are gathered before anything is compared so that a duplicate between
 * the watchlist and the discovery scan is compared once. Without that, a market
 * on the watchlist that also turns up in the scan would fire twice, and the
 * second comparison would run against a snapshot the first one just wrote.
 */
export async function runPass(opts: PassOptions): Promise<PassResult> {
  const now = opts.now ?? new Date();
  const [watchlist, state] = await Promise.all([readWatchlist(), readSeen()]);

  const found = new Map<string, { market: Market; origin: 'watchlist' | 'discovery' }>();
  const failed: string[] = [];

  for (const target of watchlist.markets) {
    try {
      const market = await fetchMarket(target);
      // Gamma answers a filter it does not recognise with its default page, so
      // a lookup that could not be verified is a failure, not a miss.
      if (!market) failed.push(target);
      else found.set(market.conditionId, { market, origin: 'watchlist' });
    } catch {
      failed.push(target);
    }
  }

  if (opts.discover) {
    try {
      const { markets } = await fetchContestedMarkets(opts.scan);
      for (const market of markets) {
        if (!market.conditionId || found.has(market.conditionId)) continue;
        found.set(market.conditionId, { market, origin: 'discovery' });
      }
    } catch (err) {
      failed.push(`discovery scan: ${redactMessage((err as Error).message ?? 'failed')}`);
    }
  }

  const baselineDone = Boolean(state.baselineAt);
  const raw: { event: WatchEvent; market: Market }[] = [];
  const next: Record<string, Seen> = { ...state.markets };

  for (const [conditionId, { market, origin }] of found) {
    const { events, next: snap } = compare(state.markets[conditionId], market, {
      origin,
      baselineDone,
      now,
    });
    next[conditionId] = snap;
    for (const event of events) raw.push({ event, market });
  }

  const kept = raw.filter(({ event }) => passesFilters(event, { minPool: opts.minPool, kinds: opts.kinds }));
  const suppressed = raw.length - kept.length;

  const addDetail = detailCache();
  const events: WatchEvent[] = [];
  for (const { event, market } of kept) {
    events.push(opts.detail ? await addDetail(event, market) : event);
  }

  // The log is the durable fact and is written before the checkpoint. If the
  // second write fails, the next pass may repeat an event, which is visible and
  // recoverable. Writing the checkpoint first could lose the event forever.
  await appendEvents(events);
  const passAnswered = found.size > 0 || failed.length === 0;
  const baseline = baselineAfterPass(state.baselineAt, passAnswered, now);
  await writeSeen({
    ...(baseline.baselineAt ? { baselineAt: baseline.baselineAt } : {}),
    markets: next,
  });

  let undelivered = 0;
  if (opts.webhook) {
    for (const event of events) {
      const result = await deliver(opts.webhook, event);
      if (!result.ok) undelivered += 1;
    }
  }

  return {
    events,
    polled: found.size,
    failed,
    baseline: baseline.established,
    suppressed,
    undelivered,
  };
}

export interface LoopOptions extends PassOptions {
  intervalMs: number;
  /** Called after every pass, including quiet ones. */
  onPass: (result: PassResult) => void | Promise<void>;
  /** Resolves when the loop should stop. */
  stop: Promise<void>;
}

/**
 * Poll until told to stop.
 *
 * The sleep races against the stop signal rather than being interrupted, so
 * ctrl-c during a five minute wait exits immediately instead of after the wait.
 */
export async function runLoop(opts: LoopOptions): Promise<void> {
  let running = true;
  const stopped = new AbortController();
  void opts.stop.then(() => {
    running = false;
    stopped.abort();
  });

  while (running) {
    try {
      await opts.onPass(await runPass(opts));
    } catch (err) {
      // A pass that throws outright, usually a network partition. The loop is
      // the thing that has to survive; a watcher that exits on the first bad
      // night is not watching.
      await opts.onPass({
        events: [],
        polled: 0,
        failed: [`pass failed: ${redactMessage((err as Error).message ?? 'unknown')}`],
        baseline: false,
        suppressed: 0,
        undelivered: 0,
      });
    }

    if (!running) break;

    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        stopped.signal.removeEventListener('abort', wake);
        resolve();
      };
      const timer = setTimeout(wake, opts.intervalMs);
      stopped.signal.addEventListener('abort', wake, { once: true });
    });
  }
}
