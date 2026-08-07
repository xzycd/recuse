/**
 * The plain renderer. Used when stdout is not a terminal, when --plain is
 * passed, and as the single-shot output for `market`, `players` and `winners`.
 *
 * Columns drop in a fixed order as the terminal narrows, so the leftmost
 * columns, the ones carrying the finding, survive at 80 characters and below.
 *
 * Padding always happens before colouring. An escape sequence is zero cells
 * wide on screen but several characters long in the string, so padding a
 * coloured value silently shortens the column by however many bytes the escape
 * took.
 */

import {
  accent, bold, clip, count, dim, meter, money, padEnd, padStart, paintRounds, pct, rule, until,
} from './format.js';
import { formatSteps } from '../core/dispute.js';
import type { Style } from './format.js';
import type { Assessment, Concentration, RepeatPlayer, Winner } from '../types.js';

/**
 * Which optional columns fit.
 *
 * Market name, rounds and concentration never drop, they carry the finding.
 * Everything else goes as the terminal narrows, widest-cost first.
 */
function columns(width: number) {
  return {
    pool: width >= 72,
    lifecycle: width >= 104,
    clock: width >= 118,
  };
}

const W_ROUNDS = 5;
/** Wide enough for "●●● 100% 5/100": the meter, the share, and its terms. */
const W_CONC = 16;

function nameWidth(width: number, col: ReturnType<typeof columns>): number {
  const fixed =
    W_ROUNDS + 9 + W_CONC + (col.pool ? 9 : 0) + (col.lifecycle ? 24 : 0) + (col.clock ? 7 : 0);
  return Math.max(18, width - fixed);
}

/** The share and its terms, in one cell. Never the share on its own. */
function concCell(c: Concentration | undefined, style: Style): string {
  if (!c) return dim(padStart('—', W_CONC), style);
  return padStart(`${meter(c.topShare)} ${pct(c.topShare)} ${c.topN}/${c.holderCount}`, W_CONC);
}

export function renderRadar(
  assessments: Assessment[],
  meta: {
    scanned: number;
    hidden: number;
    contestedTotal: number;
    /** Printed under the table when a newer version exists. */
    notice?: string;
  },
  style: Style,
): string {
  const lines: string[] = [];
  const col = columns(style.width);
  const nameW = nameWidth(style.width, col);

  lines.push(
    bold('recuse', style) +
      dim(
        ` · ${meta.contestedTotal} contested of ${meta.scanned} scanned · showing ${assessments.length}`,
        style,
      ),
  );
  lines.push(rule(style));

  const head =
    padEnd('MARKET', nameW) +
    padStart('RDS', W_ROUNDS) +
    padStart('WIPED', 9) +
    padStart('TOP 5 HELD', W_CONC) +
    (col.pool ? padStart('POOL', 9) : '') +
    (col.lifecycle ? '  ' + padEnd('LIFECYCLE', 22) : '') +
    (col.clock ? padStart('ENDS', 7) : '');
  lines.push(dim(head, style));

  for (const a of assessments) {
    const c = a.concentration;
    const rounds = a.dispute.rounds;

    // Tokens on the losing side of a settled market. Each one paid a dollar
    // and is now worth nothing, so the count is also the loss.
    const wiped =
      c && c.meaning === 'wiped' ? padStart(count(c.totalSize), 9) : dim(padStart('—', 9), style);

    let row =
      padEnd(a.market.question, nameW) +
      paintRounds(rounds, padStart(rounds > 0 ? `${rounds}×` : '·', W_ROUNDS), style) +
      wiped +
      concCell(c, style);

    if (col.pool) row += padStart(money(a.pool), 9);
    if (col.lifecycle) row += '  ' + dim(padEnd(formatSteps(a.dispute.steps), 22), style);
    if (col.clock) row += padStart(until(a.dispute.deadline), 7);

    lines.push(row);
  }

  lines.push(rule(style));

  // Nothing is filtered away silently. If rows were dropped, the count and the
  // reason are on screen.
  if (meta.hidden > 0) {
    lines.push(dim(`${meta.hidden} markets hidden, never contested. --all to include them.`, style));
  }

  if (!(assessments[0]?.tier ?? '').includes('chain')) {
    lines.push(
      dim('positions only, proposer and disputer unread. set RECUSE_RPC_URL to read them.', style),
    );
  }

  if (meta.notice) lines.push(dim(meta.notice, style));

  return lines.join('\n');
}

export function renderMarket(a: Assessment, style: Style): string {
  const lines: string[] = [];
  const w = style.width;

  lines.push(bold(clip(a.market.question, w), style));
  lines.push(dim(clip(a.market.conditionId, w), style));
  lines.push(rule(style));

  const rounds = a.dispute.rounds;
  lines.push(
    `${padEnd('disputes', 14)}${paintRounds(rounds, rounds > 0 ? `${rounds} round(s)` : 'never contested', style)}`,
  );
  lines.push(`${padEnd('lifecycle', 14)}${formatSteps(a.dispute.steps)}`);
  lines.push(`${padEnd('phase', 14)}${a.dispute.phase}`);
  lines.push(`${padEnd('volume', 14)}${money(a.pool)}`);
  if (a.market.umaBond) lines.push(`${padEnd('bond', 14)}$${a.market.umaBond}`);
  if (a.dispute.deadline) {
    lines.push(`${padEnd('ends', 14)}${until(a.dispute.deadline)} (${a.dispute.deadline.toISOString()})`);
  }

  const c = a.concentration;
  if (c) {
    lines.push('');
    lines.push(
      c.meaning === 'wiped'
        ? dim(`${c.side} side lost, ${count(c.totalSize)} tokens went to zero`, style)
        : dim(`${c.side} side leads, market still open`, style),
    );
    lines.push(
      `${padEnd('  top holders', 14)}${meter(c.topShare)} ${pct(c.topShare)} ` +
        dim(`(${c.topN} of ${c.holderCount} holders, ${count(c.topSize)} of ${count(c.totalSize)} tokens)`, style),
    );
  }

  const wc = a.winnerConcentration;
  if (wc) {
    lines.push('');
    lines.push(
      dim(
        `${wc.side} side won, ${count(wc.totalSize)} tokens rebuilt from trades. balances show almost none of this.`,
        style,
      ),
    );
    lines.push(
      `${padEnd('  top buyers', 14)}${meter(wc.topShare)} ${pct(wc.topShare)} ` +
        dim(`(${wc.topN} of ${wc.holderCount} wallets, ${count(wc.topSize)} of ${count(wc.totalSize)} tokens)`, style),
    );
  }

  if (a.market.resolutionSource) {
    lines.push('');
    lines.push(dim('resolution source', style));
    lines.push(`  ${clip(a.market.resolutionSource, w - 2)}`);
  }

  if (a.caveats.length > 0) {
    lines.push('');
    lines.push(dim('caveats', style));
    for (const c of a.caveats) lines.push(dim(`  · ${clip(c, w - 4)}`, style));
  }

  return lines.join('\n');
}

export function renderPlayers(
  players: RepeatPlayer[],
  meta: { marketsRead: number; marketsFailed: number },
  style: Style,
): string {
  const lines: string[] = [];

  lines.push(
    bold('repeat holders', style) +
      dim(` · across ${meta.marketsRead} settled contested markets`, style),
  );
  lines.push(rule(style));

  if (players.length === 0) {
    lines.push(dim('no address held a position in more than one of these markets.', style));
    return lines.join('\n');
  }

  const nameW = Math.max(12, style.width - 38);

  // No rate column. Because winners redeem and vanish, essentially everyone
  // visible in a settled market's book is a loser, so a loss rate here is
  // pinned at 100% by construction. Printing it would put a number that cannot
  // vary next to numbers that can, and it would read as a finding.
  lines.push(
    dim(
      padEnd('ADDRESS', 14) + padEnd('NAME', nameW) +
        padStart('WIPED IN', 10) + padStart('OF', 5) + padStart('TOKENS', 9),
      style,
    ),
  );

  for (const p of players.slice(0, 40)) {
    // The name cell is padded before it is dimmed, or the escape sequence would
    // eat cells the column thought it had.
    const name = p.name
      ? padEnd(p.name, nameW)
      : dim(padEnd('(anon)', nameW), style);

    lines.push(
      padEnd(p.address.slice(0, 12), 14) +
        name +
        padStart(String(p.losses), 10) +
        padStart(String(p.appearances), 5) +
        padStart(count(p.size), 9),
    );
  }

  lines.push(rule(style));
  lines.push(
    dim('losses, not wins: winners redeem and leave the book, losers keep worthless tokens.', style),
  );
  lines.push(dim('someone has to lose every market. repeatedly is a question, not a finding.', style));
  if (meta.marketsFailed > 0) {
    lines.push(dim(`${meta.marketsFailed} markets could not be read, tallies are incomplete.`, style));
  }

  return lines.join('\n');
}

/**
 * The side redemption erases.
 *
 * Reported in tokens and in what was paid for them, because the interesting
 * number is the gap: at settlement every winning token is worth a dollar, so a
 * wallet that paid 0.30 and held to the end made 70 cents on each one.
 */
export function renderWinners(a: Assessment, winners: Winner[], style: Style): string {
  const lines: string[] = [];
  const wc = a.winnerConcentration;

  lines.push(bold(clip(a.market.question, style.width), style));
  lines.push(
    dim(
      `${wc?.side ?? '?'} side won after ${a.dispute.rounds} dispute round(s) · ${money(a.pool)} traded`,
      style,
    ),
  );
  lines.push(rule(style));

  if (winners.length === 0) {
    lines.push(dim('no winning positions were returned for this market.', style));
    for (const c of a.caveats) lines.push(dim(`  · ${c}`, style));
    return lines.join('\n');
  }

  // The address is the only identity here. The subgraph has no display names,
  // and inventing a blank column to hold the ones it does not have would just
  // push the numbers off the right of an 80 column terminal.
  const addrW = Math.min(44, Math.max(14, style.width - 52));
  const total = wc?.totalSize ?? 0;

  lines.push(
    dim(
      padEnd('ADDRESS', addrW) +
        padStart('SHARE', 7) + padStart('BOUGHT', 9) + padStart('HELD', 9) +
        padStart('PAID', 9) + padStart('AVG', 6) + padStart('GAIN', 9),
      style,
    ),
  );

  for (const w of winners) {
    // Average price paid per token still held, from the net cost basis rather
    // than from everything ever bought, so a wallet that traded in and out is
    // priced on the position it actually carried into settlement.
    const avg = w.net > 0 ? w.netSpent / w.net : 0;
    // Every held token on the winning side redeems for exactly one dollar, so
    // this is arithmetic and not an estimate. It is also frequently unexciting:
    // most of these wallets bought at 0.98 and made two cents.
    const gain = w.net - w.netSpent;
    // Share of the winning positions returned, whose size is on the line below
    // the table. Never a share of "the market", which we did not measure.
    const share = total > 0 ? w.net / total : 0;

    lines.push(
      padEnd(w.address, addrW) +
        padStart(pct(share), 7) +
        padStart(count(w.bought), 9) +
        padStart(count(w.net), 9) +
        padStart(money(w.netSpent), 9) +
        padStart(avg > 0 ? avg.toFixed(2) : '—', 6) +
        padStart(money(gain), 9),
    );
  }

  lines.push(rule(style));
  if (wc) {
    lines.push(
      dim(
        `top ${wc.topN} of ${wc.holderCount} wallets returned hold ${pct(wc.topShare)} of ${count(wc.totalSize)} tokens`,
        style,
      ),
    );
  }
  lines.push(
    dim('from trades, not balances. these wallets redeemed and hold nothing now.', style),
  );
  // Every caveat about this reading, not a chosen subset. The truncation one
  // matters most: a share is of what came back, and the page size is ours.
  for (const c of a.caveats) {
    if (/^(winning side|more winning)/.test(c)) lines.push(dim(`  · ${c}`, style));
  }

  return lines.join('\n');
}

/** `--theme list`. Shows each theme drawn in its own colours. */
export function renderThemes(current: string, style: Style, themes: {
  name: string; blurb: string; ramp: readonly string[];
}[], paint: (t: string, hex: string) => string): string {
  const lines: string[] = [bold('themes', style), rule(style)];

  for (const t of themes) {
    const swatch = t.ramp.map((hex) => paint('███', hex)).join(' ');
    const marker = t.name === current ? accent(' ·', style) : '  ';
    lines.push(`${marker} ${padEnd(t.name, 8)} ${swatch}  ${dim(t.blurb, style)}`);
  }

  lines.push(rule(style));
  lines.push(dim('recuse --theme <name>, or set RECUSE_THEME', style));
  return lines.join('\n');
}
