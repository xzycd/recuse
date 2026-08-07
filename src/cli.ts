#!/usr/bin/env node
/**
 * recuse: see who decides a Polymarket market, and what they own.
 *
 * Every command takes --json. The renderers are one consumer of the engine,
 * not the product, and anything you can read you can pipe.
 */

import { readFileSync } from 'node:fs';
import { assess, assessAll, tallyRepeatPlayers } from './core/assess.js';
import { checkForUpdate, updateNotice } from './core/update.js';
import { redactMessage } from './core/safe.js';
import { fetchContestedMarkets, fetchMarket, fetchMarkets } from './sources/gamma.js';
import { detectStyle } from './ui/format.js';
import { splash } from './ui/logo.js';
import { startSpinner } from './ui/loading.js';
import { renderMarket, renderPlayers, renderRadar, renderThemes, renderWinners } from './ui/plain.js';
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
  recuse market <id|slug>     one market: resolution history, both sides
  recuse winners <id|slug>    who bought the side that won, and for how much
  recuse players              addresses left holding losing sides, repeatedly
  recuse update               check whether a newer version was published
  recuse --help

options
  --json            machine-readable output
  --plain           force the plain renderer
  --limit <n>       rows to show (default 25)
  --scan <n>        markets to examine (default 600)
  --all             include markets that were never contested
  --winners         rebuild the winning side on the radar too, one query per row
  --theme <name>    ${themeNames().join(', ')}, or "list"
  --no-color        monochrome
  --no-logo         skip the banner

environment
  RECUSE_THEME      default theme
  RECUSE_RPC_URL    a Polygon endpoint that serves eth_getLogs ranges. without
                    it, proposer and disputer identities are not read. the free
                    public endpoints cap at 10-50 blocks and cannot be used.
  RECUSE_HOME       where the update cache lives (default ~/.recuse)
  RECUSE_NO_UPDATE_CHECK  skip the version check entirely
  NO_COLOR          monochrome
`;

interface Args {
  command: string;
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
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'radar', json: false, plain: false, limit: 25, scan: 600,
    all: false, winners: false, logo: true, help: false,
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
    else if (a === '--limit') args.limit = Number(argv[++i]) || args.limit;
    else if (a === '--scan') args.scan = Number(argv[++i]) || args.scan;
    else if (a === '--theme') args.theme = argv[++i];
    else if (a?.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else if (a) rest.push(a);
  }

  if (rest[0]) args.command = rest[0];
  if (rest[1]) args.target = rest[1];

  return args;
}

function emit(text: string): void {
  process.stdout.write(`${text}\n`);
}

function emitJson(value: unknown): void {
  emit(JSON.stringify(value, null, 2));
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

  if (args.json) {
    emitJson({ scanned, contested: markets.length, shown: assessments.length, assessments });
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
        notice,
      }),
    );
    await app.waitUntilExit();
    return 0;
  }

  emit(
    renderRadar(
      assessments,
      { scanned, hidden: scanned - markets.length, contestedTotal: markets.length, notice },
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

  emit(renderMarket(assessment, style));
  return 0;
}

async function runWinners(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour, theme: args.theme });
  const found = await lookup(args, style);
  if (!found) return 1;

  let assessment;
  try {
    assessment = await assess(found.market, { winners: true, winnerLimit: args.limit });
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
      case 'market':
        return await runMarket(args);
      case 'winners':
        return await runWinners(args);
      case 'players':
        return await runPlayers(args);
      case 'update':
        return await runUpdate(args);
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
