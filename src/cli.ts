#!/usr/bin/env node
/**
 * recuse: see who decides a Polymarket market, and what they own.
 *
 * Every command takes --json. The renderers are one consumer of the engine,
 * not the product, and anything you can read you can pipe.
 */

import { assess, assessAll, tallyRepeatPlayers } from './core/assess.js';
import { fetchContestedMarkets, fetchMarket, fetchMarkets } from './sources/gamma.js';
import { detectStyle } from './ui/format.js';
import { renderMarket, renderPlayers, renderRadar } from './ui/plain.js';

const USAGE = `recuse: who decides a Polymarket market, and what they own

usage
  recuse                      contested markets, most contested first
  recuse market <id|slug>     one market: its resolution history and holders
  recuse players              addresses holding the winning side, repeatedly
  recuse --help

options
  --json            machine-readable output
  --plain           force the plain renderer
  --limit <n>       rows to show (default 25)
  --scan <n>        markets to examine (default 600)
  --all             include markets that were never contested
  --no-color        monochrome

environment
  RECUSE_RPC_URL    a Polygon endpoint that serves eth_getLogs ranges. without
                    it, proposer and disputer identities are not read. the free
                    public endpoints cap at 10-50 blocks and cannot be used.
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
  colour?: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'radar', json: false, plain: false, limit: 25, scan: 600, all: false, help: false,
  };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--plain') args.plain = true;
    else if (a === '--all') args.all = true;
    else if (a === '--no-color' || a === '--no-colour') args.colour = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--limit') args.limit = Number(argv[++i]) || args.limit;
    else if (a === '--scan') args.scan = Number(argv[++i]) || args.scan;
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

async function runRadar(args: Args): Promise<number> {
  const style = detectStyle({ colour: args.colour });

  const { markets, scanned } = args.all
    ? await fetchMarkets({ limit: args.scan }).then((m) => ({ markets: m, scanned: m.length }))
    : await fetchContestedMarkets(args.scan);

  const shown = markets.slice(0, args.limit);
  const assessments = await assessAll(shown);

  if (args.json) {
    emitJson({ scanned, contested: markets.length, shown: assessments.length, assessments });
    return 0;
  }

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
      React.createElement(App, { assessments, scanned, contestedTotal: markets.length }),
    );
    await app.waitUntilExit();
    return 0;
  }

  emit(
    renderRadar(
      assessments,
      { scanned, hidden: scanned - markets.length, contestedTotal: markets.length },
      style,
    ),
  );
  return 0;
}

async function runMarket(args: Args): Promise<number> {
  if (!args.target) {
    process.stderr.write('recuse market: needs a condition id or slug\n');
    return 2;
  }

  const market = await fetchMarket(args.target);
  if (!market) {
    // Gamma answers an unrecognised filter with its default page, so a lookup
    // that cannot be verified is reported as a miss rather than guessed at.
    process.stderr.write(`no market matched ${args.target}\n`);
    return 1;
  }

  const assessment = await assess(market);

  if (args.json) {
    emitJson(assessment);
    return 0;
  }

  emit(renderMarket(assessment, detectStyle({ colour: args.colour })));
  return 0;
}

async function runPlayers(args: Args): Promise<number> {
  const { markets } = await fetchContestedMarkets(args.scan);
  const result = await tallyRepeatPlayers(markets.slice(0, args.limit));

  if (args.json) {
    emitJson(result);
    return 0;
  }

  emit(renderPlayers(result.players, result, detectStyle({ colour: args.colour })));
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

  if (args.help) {
    emit(USAGE);
    return 0;
  }

  try {
    switch (args.command) {
      case 'radar':
        return await runRadar(args);
      case 'market':
        return await runMarket(args);
      case 'players':
        return await runPlayers(args);
      default:
        process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

// Only run when invoked directly, so the module stays importable and testable.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().then((code) => {
    process.exitCode = code;
  });
}
