#!/usr/bin/env node
/**
 * recuse: see who decides a Polymarket market, and what they own.
 *
 * Every command takes --json. The renderers are one consumer of the engine,
 * not the product, and anything you can read you can pipe.
 */

import { readFileSync } from 'node:fs';
import { assess, assessAll, assessWallet, tallyRepeatPlayers } from './core/assess.js';
import { checkForUpdate, updateNotice } from './core/update.js';
import { checkWebhook } from './core/notify.js';
import { chainNote } from './sources/chain.js';
import { redactMessage } from './core/safe.js';
import {
  addToWatchlist, readEventLog, readEvents, readRadar, readSeen, readWatchlist,
  removeFromWatchlist, writeRadar, type SeenState,
} from './core/store.js';
import { recall, recallNote } from './core/recall.js';
import { recuseTools, serve, type Engine } from './core/mcp.js';
import { snapshot } from './core/watch.js';
import { runLoop, runPass, type PassResult } from './core/watcher.js';
import type { EventKind } from './core/watch.js';
import { fetchBothStates, fetchContestedMarkets, fetchMarket, fetchMarkets } from './sources/gamma.js';
import { queue } from './core/queue.js';
import { summarise } from './core/ledger.js';
import { detectStyle } from './ui/format.js';
import { splash } from './ui/logo.js';
import { startSpinner } from './ui/loading.js';
import {
  renderCard, renderEvent, renderLedger, renderMarket, renderPassSummary, renderPlayers,
  renderQueue, renderRadar, renderThemes, renderWallet, renderWatchlist, renderWatchStart,
  renderWinners,
} from './ui/plain.js';
import { colourise, THEMES, themeNames } from './ui/theme.js';

/**
 * The installed version, read from the package rather than duplicated here so
 * the update check cannot compare against a number someone forgot to bump.
 */
export function version(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const USAGE = `usage
  recuse                      contested markets, most contested first
  recuse queue                markets whose resolution has not finished
  recuse market <id|slug>     one market: resolution history, both sides
  recuse winners <id|slug>    who bought the side that won, and for how much
  recuse wallet <address>     one wallet's record, disputed markets first
  recuse players              addresses left holding losing sides, repeatedly
  recuse update               check whether a newer version was published
  recuse serve --mcp          answer over MCP, for an agent rather than a person
  recuse --help

watching
  recuse watch                poll for resolutions that move, until stopped
  recuse watch --once         one pass and exit, for cron or a systemd timer
  recuse watch add <id|slug>  put a market on the watchlist
  recuse watch rm <id|slug>   take one off
  recuse watch list           show the watchlist and what was last seen
  recuse events               the log of everything that moved
  recuse ledger               what the log has accumulated, summarised

serving
  recuse serve --mcp          one JSON-RPC message per line on stdin and stdout.
                              stdout is the transport, so nothing else prints:
                              no banner, no spinner, no update check.

options
  --json            machine-readable output
  --card            market: a block sized for pasting into a chat
  --plain           force the plain renderer
  --limit <n>       rows to show, or positions to read for wallet (default 25)
  --scan <n>        markets to examine (default 600)
  --all             include markets that were never contested
  --winners         rebuild the winning side on the radar too, one query per row
  --theme <name>    ${themeNames().join(', ')}, or "list"
  --no-color        monochrome
  --no-logo         skip the banner

watch options
  --once            a single pass instead of a loop
  --interval <sec>  seconds between passes (default 300, minimum 30)
  --discover        also report disputes on markets you did not name
  --min-pool <n>    ignore anything under this much volume
  --only <kinds>    comma separated: disputed,proposed,resolved,reset,settled,appeared,rewritten
  --webhook <url>   POST each event as JSON. works with telegram, discord, slack
  --no-detail       skip the holder lookup that enriches each event

environment
  RECUSE_THEME      default theme
  RECUSE_RPC_URL    reserved. the oracle reading is not built yet, so this is
                    validated and then unused. no reading stands on chain data.
  RECUSE_HOME       where the watchlist, state and event log live (default ~/.recuse)
  RECUSE_NO_UPDATE_CHECK  skip the version check entirely
  NO_COLOR          monochrome
`;

interface Args {
  command: string;
  /** `watch add`, `watch rm`, `watch list`. Empty for every other command. */
  sub?: string;
  target?: string;
  json: boolean;
  plain: boolean;
  limit: number;
  scan: number;
  all: boolean;
  winners: boolean;
  theme?: string;
  logo: boolean;
  colour?: boolean;
  help: boolean;
  once: boolean;
  intervalMs: number;
  discover: boolean;
  minPool?: number;
  only?: string;
  webhook?: string;
  detail: boolean;
  card: boolean;
  /** serve: speak MCP. Required, so a bare `serve` does not pick a protocol. */
  mcp: boolean;
}

/** Anything under this hammers Gamma for no benefit; disputes do not move in seconds. */
const MIN_INTERVAL_MS = 30_000;

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'radar', json: false, plain: false, limit: 25, scan: 600,
    all: false, winners: false, logo: true, help: false,
    once: false, intervalMs: 300_000, discover: false, detail: true, card: false,
    mcp: false,
  };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--plain') args.plain = true;
    else if (a === '--all') args.all = true;
    else if (a === '--winners') args.winners = true;
    else if (a === '--no-logo') args.logo = false;
    else if (a === '--no-color' || a === '--no-colour') args.colour = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--once') args.once = true;
    else if (a === '--discover') args.discover = true;
    else if (a === '--no-detail') args.detail = false;
    else if (a === '--card') args.card = true;
    else if (a === '--mcp') args.mcp = true;
    else if (a === '--limit') args.limit = Number(argv[++i]) || args.limit;
    else if (a === '--scan') args.scan = Number(argv[++i]) || args.scan;
    else if (a === '--min-pool') args.minPool = Number(argv[++i]) || args.minPool;
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--webhook') args.webhook = argv[++i];
    else if (a === '--theme') args.theme = argv[++i];
    else if (a === '--interval') {
      const seconds = Number(argv[++i]);
      // Clamped rather than rejected. Someone asking for five seconds wants it
      // responsive, and the right answer is to give them the fastest polite
      // rate rather than an error.
      args.intervalMs = Number.isFinite(seconds) && seconds > 0
        ? Math.max(MIN_INTERVAL_MS, seconds * 1000)
        : args.intervalMs;
    }
    else if (a?.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else if (a) rest.push(a);
  }

  if (rest[0]) args.command = rest[0];

  // `watch` is the only command with a subcommand, so the second positional
  // means different things depending on the first. Everywhere else it is the
  // market, and treating `watch add <slug>` as `command=watch target=add` would
  // silently look up a market called "add".
  if (args.command === 'watch') {
    if (rest[1]) args.sub = rest[1];
    if (rest[2]) args.target = rest[2];
  } else if (rest[1]) {
    args.target = rest[1];
  }

  return args;
}

function emit(text: string): void {
  process.stdout.write(`${text}\n`);
}

function emitJson(value: unknown): void {
  emit(JSON.stringify(value, null, 2));
}

/** Dim, for the CLI's own asides. Colour resolves through the active theme. */
function dimly(text: string, style: ReturnType<typeof detectStyle>): string {
  return colourise(text, style.theme.dim, style.depth);
}

/**
 * Should the banner be drawn?
 *
 * Not into a pipe, not alongside JSON, and not when asked not to. A logo in
 * `recuse | grep` output is somebody else's problem to strip.
 */
function wantsChrome(args: Args): boolean {
  return args.logo && !args.json && process.stdout.isTTY === true;
}

function showSplash(args: Args, style: ReturnType<typeof detectStyle>, hint?: string): void {
  if (!wantsChrome(args)) return;
  emit('');
  emit(splash({ theme: style.theme, depth: style.depth, width: style.width, version: version(), hint }));
  emit('');
}

/** Start the update check now so it has resolved by the time a scan finishes. */
function beginUpdateCheck(args: Args): Promise<string | undefined> {
  if (args.json || !process.stdout.isTTY) return Promise.resolve(undefined);
  return checkForUpdate(version())
    .then(updateNotice)
    .catch(() => undefined);
}

async function runRadar(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour, theme: args.theme });
  showSplash(args, style);

  const pending = beginUpdateCheck(args);
  const spinner = args.json
    ? { update() {}, stop() {} }
    : startSpinner('scanning markets', { theme: style.theme, depth: style.depth });

  let found: { markets: Awaited<ReturnType<typeof fetchMarkets>>; scanned: number };
  let assessments: Awaited<ReturnType<typeof assessAll>>;
  try {
    found = args.all
      ? await fetchMarkets({ limit: args.scan }).then((m) => ({ markets: m, scanned: m.length }))
      : await fetchContestedMarkets(args.scan);

    const shown = found.markets.slice(0, args.limit);
    spinner.update(`0/${shown.length} read`);

    assessments = await assessAll(shown, { winners: args.winners }, (done, total) =>
      spinner.update(`${done}/${total} read`),
    );
  } finally {
    spinner.stop();
  }

  const { markets, scanned } = found;

  // What changed since the last run, and the record of this one. Read before
  // the write, obviously, and the write is best effort: a radar that cannot
  // save its snapshot should still print the table it already has.
  const previous: SeenState = await readRadar().catch(() => ({ markets: {} }));
  const moved = recall(assessments, previous, new Date());
  const note = recallNote(moved, assessments.length);

  const now = new Date();
  await writeRadar({
    baselineAt: previous.baselineAt ?? now.toISOString(),
    markets: {
      ...previous.markets,
      ...Object.fromEntries(
        assessments
          .filter((a) => a.market.conditionId)
          .map((a) => [a.market.conditionId, snapshot(a.market, now)]),
      ),
    },
  }).catch(() => {});

  if (args.json) {
    emitJson({
      scanned,
      contested: markets.length,
      shown: assessments.length,
      // Same figures the table shows. Anything you can read you can pipe.
      recall: {
        since: moved.since,
        baseline: moved.baseline,
        compared: moved.compared,
        moved: moved.moved,
        rewritten: moved.rewritten,
        unseen: moved.unseen,
        movement: Object.fromEntries(moved.movement),
      },
      assessments,
    });
    return 0;
  }

  const notice = await pending;

  // The interactive view needs a real terminal to draw into and keys to read
  // from. Piped, redirected or explicitly asked for plain, it renders once and
  // exits, which is also what makes `recuse | grep` behave.
  const interactive = !args.plain && process.stdout.isTTY === true && process.stdin.isTTY === true;

  if (interactive) {
    const [{ render }, React, { App }] = await Promise.all([
      import('ink'),
      import('react'),
      import('./ui/App.js'),
    ]);
    const app = render(
      React.createElement(App, {
        assessments,
        scanned,
        contestedTotal: markets.length,
        theme: style.theme,
        evidence: chainNote(),
        movement: moved.movement,
        // Opens on what changed when something did, and on the familiar
        // ranking when nothing did. A default that reorders the table for no
        // visible reason is worse than one that never moves.
        sort: moved.moved + moved.rewritten > 0 ? ('moved' as const) : ('rounds' as const),
        recall: note,
        notice,
      }),
    );
    await app.waitUntilExit();
    return 0;
  }

  emit(
    renderRadar(
      assessments,
      {
        scanned,
        hidden: scanned - markets.length,
        contestedTotal: markets.length,
        evidence: chainNote(),
        recall: note,
        notice,
      },
      style,
    ),
  );
  return 0;
}

/** Shared lookup for the commands that take one market. */
async function lookup(args: Args, style: ReturnType<typeof detectStyle>) {
  if (!args.target) {
    process.stderr.write(`recuse ${args.command}: needs a condition id or slug\n`);
    return undefined;
  }

  const spinner = args.json
    ? { update() {}, stop() {} }
    : startSpinner('reading market', { theme: style.theme, depth: style.depth });

  try {
    const market = await fetchMarket(args.target);
    if (!market) {
      // Gamma answers an unrecognised filter with its default page, so a lookup
      // that cannot be verified is reported as a miss rather than guessed at.
      process.stderr.write(`no market matched ${args.target}\n`);
      return undefined;
    }
    return { market, spinner };
  } catch (err) {
    spinner.stop();
    throw err;
  }
}

async function runMarket(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour, theme: args.theme });
  const found = await lookup(args, style);
  if (!found) return 1;

  let assessment;
  try {
    // Both sides, always, for a single market. One extra request buys back the
    // half of a settled market that redemption erased.
    assessment = await assess(found.market, { winners: true });
  } finally {
    found.spinner.stop();
  }

  if (args.json) {
    emitJson(assessment);
    return 0;
  }

  // Never coloured, whatever the terminal supports. This exists to be pasted
  // somewhere that is not a terminal, and escape codes in a chat message are
  // somebody else's problem to strip.
  if (args.card) {
    emit(renderCard(assessment));
    return 0;
  }

  emit(renderMarket(assessment, style));
  return 0;
}

/** Markets whose resolution record has not reached a terminal step. */
async function runQueue(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour, theme: args.theme });
  showSplash(args, style);

  const spinner = args.json
    ? { update() {}, stop() {} }
    : startSpinner('reading lifecycles', { theme: style.theme, depth: style.depth });

  let scan;
  try {
    const { markets } = await fetchBothStates(args.scan);
    scan = queue(markets);
  } finally {
    spinner.stop();
  }

  const rows = scan.pending.slice(0, args.limit);

  if (args.json) {
    emitJson({
      scanned: scan.scanned,
      pending: scan.pending.length,
      finished: scan.finished,
      noLifecycle: scan.noLifecycle,
      undated: scan.undated,
      markets: rows.map((p) => ({
        conditionId: p.market.conditionId,
        slug: p.market.slug,
        question: p.market.question,
        last: p.last,
        rounds: p.dispute.rounds,
        phase: p.dispute.phase,
        steps: p.dispute.steps,
        since: p.since?.toISOString(),
        waitedMs: p.waited,
        pool: p.market.volume,
      })),
    });
    return 0;
  }

  emit(renderQueue(scan, rows, style));
  return 0;
}

/** What the event log has accumulated. */
async function runLedger(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour, theme: args.theme });
  const { events, skipped, truncated } = await readEventLog();
  const summary = summarise(events, skipped, args.limit, truncated);

  if (args.json) {
    emitJson(summary);
    return 0;
  }

  emit(renderLedger(summary, style));
  return 0;
}

async function runWinners(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour, theme: args.theme });
  const found = await lookup(args, style);
  if (!found) return 1;

  let assessment;
  try {
    found.spinner.update('naming the winning side');
    assessment = await assess(found.market, {
      winners: true,
      winnerLimit: args.limit,
      // The one surface whose entire output is a list of wallets, so it is
      // worth a request each to say who they are.
      winnerNames: true,
    });
  } finally {
    found.spinner.stop();
  }

  if (args.json) {
    emitJson({
      market: assessment.market.conditionId,
      question: assessment.market.question,
      concentration: assessment.winnerConcentration,
      winners: assessment.winners ?? [],
      caveats: assessment.caveats,
    });
    return 0;
  }

  emit(renderWinners(assessment, assessment.winners ?? [], style));
  return 0;
}

async function runWallet(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour, theme: args.theme });

  if (!args.target) {
    process.stderr.write('recuse wallet: needs a 0x address\n');
    return 2;
  }

  const spinner = args.json
    ? { update() {}, stop() {} }
    : startSpinner('reading positions', { theme: style.theme, depth: style.depth });

  let ledger;
  try {
    ledger = await assessWallet(args.target, { limit: args.limit });
  } finally {
    spinner.stop();
  }

  if (args.json) {
    emitJson(ledger);
    return 0;
  }

  emit(renderWallet(ledger, style));
  // A wallet that returned nothing at all is a miss worth an exit code, so a
  // script can tell "no positions" from "here they are".
  return ledger.entries.length === 0 ? 1 : 0;
}

async function runPlayers(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour, theme: args.theme });
  showSplash(args, style);

  const spinner = args.json
    ? { update() {}, stop() {} }
    : startSpinner('reading holders', { theme: style.theme, depth: style.depth });

  let result;
  try {
    const { markets } = await fetchContestedMarkets(args.scan);
    result = await tallyRepeatPlayers(markets.slice(0, args.limit), {}, (done, total) =>
      spinner.update(`${done}/${total} markets`),
    );
  } finally {
    spinner.stop();
  }

  if (args.json) {
    emitJson(result);
    return 0;
  }

  emit(renderPlayers(result.players, result, style));
  return 0;
}

async function runUpdate(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour, theme: args.theme });
  const status = await checkForUpdate(version(), { force: true });

  if (args.json) {
    emitJson(status);
    return 0;
  }

  if (status.reason) {
    emit(`no answer on ${status.current}: ${redactMessage(status.reason)}`);
    return 1;
  }

  if (!status.behind) {
    emit(`recuse ${status.current} is current`);
    return 0;
  }

  // It prints the command rather than running it. A CLI that installs its own
  // updates is a CLI that will run whatever is at that name on the registry
  // the next time the name changes hands.
  emit(`recuse ${status.latest} is out, you have ${status.current}`);
  emit('');
  emit(`  npm i -g recuse`);
  emit('');
  emit(
    style.colour
      ? colourise('recuse never installs anything itself. run that when you want it.', style.theme.dim, style.depth)
      : 'recuse never installs anything itself. run that when you want it.',
  );
  return 0;
}

/** `watch add`, `watch rm`, `watch list`. Everything that is not the loop. */
async function runWatchAdmin(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour, theme: args.theme });

  if (args.sub === 'add' || args.sub === 'rm' || args.sub === 'remove') {
    if (!args.target) {
      process.stderr.write(`recuse watch ${args.sub}: needs a condition id or slug\n`);
      return 2;
    }

    const adding = args.sub === 'add';
    const result = adding
      ? await addToWatchlist(args.target)
      : await removeFromWatchlist(args.target);
    const changed = 'added' in result ? result.added : result.removed;

    if (args.json) {
      emitJson({ action: args.sub, target: args.target, changed, watching: result.list.markets });
      return 0;
    }

    const verb = changed ? (adding ? 'watching' : 'dropped') : (adding ? 'already watching' : 'was not watching');
    emit(`${verb} ${args.target}`);
    emit(dimly(`${result.list.markets.length} on the watchlist`, style));
    return 0;
  }

  // `watch list`, and the default when a subcommand is not recognised as an
  // action, because showing the watchlist is the harmless reading of it.
  const [list, state] = await Promise.all([readWatchlist(), readSeen()]);
  const byId = new Map(Object.values(state.markets).map((s) => [s.conditionId, s]));
  const bySlug = new Map(Object.values(state.markets).map((s) => [s.slug, s]));

  const entries = list.markets.map((target) => {
    const seen = byId.get(target.toLowerCase()) ?? bySlug.get(target);
    return seen ? { target, seen } : { target };
  });

  if (args.json) {
    emitJson({ watching: list.markets, baselineAt: state.baselineAt, entries });
    return 0;
  }

  emit(renderWatchlist(entries, style));
  return 0;
}

/** The loop, or one pass of it. */
async function runWatch(args: Args): Promise<number> {
  if (args.sub && args.sub !== 'run') return runWatchAdmin(args);

  const style = detectStyle({ colour: args.colour, theme: args.theme });

  // Checked before the first pass rather than on the first event. A watcher
  // that runs all night and only discovers its webhook is malformed when
  // something finally happens has failed at the one job it had.
  if (args.webhook) {
    try {
      checkWebhook(args.webhook);
    } catch (err) {
      process.stderr.write(`--webhook rejected: ${(err as Error).message}\n`);
      return 2;
    }
  }

  const kinds = args.only
    ? new Set(args.only.split(',').map((k) => k.trim()).filter(Boolean) as EventKind[])
    : undefined;

  const list = await readWatchlist();
  if (list.markets.length === 0 && !args.discover) {
    process.stderr.write(
      'nothing to watch. add a market with `recuse watch add <id-or-slug>`, ' +
        'or pass --discover to watch for disputes on markets you did not name.\n',
    );
    return 2;
  }

  const options = {
    discover: args.discover,
    scan: args.scan,
    minPool: args.minPool,
    kinds,
    detail: args.detail,
    webhook: args.webhook,
  };

  const report = (result: PassResult) => {
    if (args.json) {
      // One event per line, so `recuse watch --json | while read` works and a
      // consumer never has to wait for the process to end.
      for (const event of result.events) emit(JSON.stringify(event));
      return;
    }
    for (const event of result.events) emit(renderEvent(event, style));
    const summary = renderPassSummary(result, style);
    if (summary) emit(summary);
  };

  if (args.once) {
    report(await runPass(options));
    return 0;
  }

  if (!args.json) {
    showSplash(args, style);
    emit(
      renderWatchStart(
        {
          watching: list.markets.length,
          discover: args.discover,
          scan: args.scan,
          intervalMs: args.intervalMs,
          webhook: Boolean(args.webhook),
        },
        style,
      ),
    );
  }

  // Ctrl-c resolves this, and the loop races it against its own sleep, so a
  // stop during a five minute wait exits now rather than in five minutes.
  let release: () => void = () => {};
  const stop = new Promise<void>((resolve) => {
    release = resolve;
  });
  const onSignal = () => {
    release();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  await runLoop({ ...options, intervalMs: args.intervalMs, onPass: report, stop });

  if (!args.json) emit(dimly('stopped', style));
  return 0;
}

async function runEvents(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour, theme: args.theme });
  const { events, skipped } = await readEvents(args.limit);

  if (args.json) {
    emitJson({ events, skipped });
    return 0;
  }

  if (events.length === 0) {
    emit(dimly('no events recorded yet. run `recuse watch`.', style));
    return 0;
  }

  for (const event of events) emit(renderEvent(event, style));
  if (skipped > 0) {
    // A partial last line from a process killed mid-append. Counted, not hidden.
    emit(dimly(`${skipped} unreadable lines in the log`, style));
  }
  return 0;
}

/**
 * Serve the engine over MCP on stdin and stdout.
 *
 * The engine is assembled here rather than inside `core/mcp.ts` so that module
 * stays testable without a network, and so this surface cannot grow a second
 * way of reading a market that drifts from what the table prints. Every method
 * below is the same call the matching command makes.
 *
 * Nothing writes to stdout except the protocol. No banner, no spinner, no
 * update check: one stray line and the client sees a parse error and hangs up.
 * The spinner already writes to stderr and the banner already refuses to draw
 * into a pipe, so this is a matter of not calling them rather than of
 * suppressing them.
 */
async function runServe(args: Args): Promise<number> {
  if (!args.mcp) {
    process.stderr.write(
      'recuse serve: needs --mcp\n\n'
        + '  recuse serve --mcp    speak MCP over stdin and stdout\n\n'
        + 'There is no HTTP server yet. The flag is required rather than assumed so\n'
        + 'that adding one later does not change what a bare `serve` already does.\n',
    );
    return 2;
  }

  const engine: Engine = {
    async contested(scan) {
      const { markets, scanned } = await fetchContestedMarkets(scan);
      const assessments = await assessAll(markets, {});
      return { assessments, scanned, contested: markets.length };
    },
    async market(idOrSlug) {
      const market = await fetchMarket(idOrSlug);
      if (!market) return undefined;
      return assess(market, { winners: true });
    },
    async winners(idOrSlug, limit) {
      const market = await fetchMarket(idOrSlug);
      if (!market) return undefined;
      return assess(market, { winners: true, winnerLimit: limit, winnerNames: true });
    },
    wallet(address, limit) {
      return assessWallet(address, { limit });
    },
    async pending(scan) {
      const { markets } = await fetchBothStates(scan);
      return queue(markets);
    },
  };

  await serve(
    { input: process.stdin, write: (line) => process.stdout.write(`${line}\n`) },
    recuseTools(engine),
    { name: 'recuse', version: version() },
  );

  return 0;
}

function runThemeList(args: Args): number {
  const style = detectStyle({ colour: args.colour });
  const list = Object.values(THEMES).map((t) => ({ name: t.name, blurb: t.blurb, ramp: t.ramp }));

  if (args.json) {
    emitJson(list);
    return 0;
  }

  emit(
    renderThemes(style.theme.name, style, list, (text, hex) => colourise(text, hex, style.depth)),
  );
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (args.theme === 'list') return runThemeList(args);

  if (args.help) {
    const style = detectStyle({ colour: args.colour, theme: args.theme });
    showSplash(args, style);
    emit(USAGE);
    return 0;
  }

  try {
    switch (args.command) {
      case 'radar':
        return await runRadar(args);
      case 'queue':
        return await runQueue(args);
      case 'ledger':
        return await runLedger(args);
      case 'market':
        return await runMarket(args);
      case 'winners':
        return await runWinners(args);
      case 'wallet':
      case 'actor':
        return await runWallet(args);
      case 'players':
        return await runPlayers(args);
      case 'watch':
        return await runWatch(args);
      case 'events':
        return await runEvents(args);
      case 'update':
        return await runUpdate(args);
      case 'serve':
        return await runServe(args);
      default:
        process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    // Errors are scrubbed before they are printed. RECUSE_RPC_URL usually has
    // an API key in it, node puts request URLs in some network error messages,
    // and the natural next step after an error is pasting it into an issue.
    process.stderr.write(`${redactMessage((err as Error).message ?? String(err))}\n`);
    return 1;
  }
}

// Only run when invoked directly, so the module stays importable and testable.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().then((code) => {
    process.exitCode = code;
  });
}
