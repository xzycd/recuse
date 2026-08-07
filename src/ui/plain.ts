/**
 * The plain renderer. Used when stdout is not a terminal, when --plain is
 * passed, and as the single-shot output for `market` and `players`.
 *
 * Columns drop in a fixed order as the terminal narrows, so the leftmost
 * columns, the ones carrying the finding, survive at 80 characters and below.
 */

import {
  bold, clip, count, dim, meter, money, padEnd, padStart, paintRounds, pct, rule, until,
} from './format.js';
import { formatSteps } from '../core/dispute.js';
import type { Style } from './format.js';
import type { Assessment, RepeatPlayer } from '../types.js';

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

export function renderRadar(
  assessments: Assessment[],
  meta: { scanned: number; hidden: number; contestedTotal: number },
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

    // The share never travels without its terms. "100% 5/100" says five of the
    // hundred holders we could see hold all of it, which is checkable. A bare
    // 100% is not, and would read as far stronger than the data supports.
    const conc = c
      ? padStart(`${meter(c.topShare)} ${pct(c.topShare)} ${c.topN}/${c.holderCount}`, W_CONC)
      : dim(padStart('—', W_CONC), style);

    // Tokens on the losing side of a settled market. Each one paid a dollar
    // and is now worth nothing, so the count is also the loss.
    const wiped = c && c.meaning === 'wiped' ? padStart(count(c.totalSize), 9) : dim(padStart('—', 9), style);

    let row =
      padEnd(a.market.question, nameW) +
      paintRounds(rounds, padStart(rounds > 0 ? `${rounds}×` : '·', W_ROUNDS), style) +
      wiped +
      conc;

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

  if ((assessments[0]?.tier ?? 'positions') === 'positions') {
    lines.push(
      dim('positions only, proposer and disputer unread. set RECUSE_RPC_URL to read them.', style),
    );
  }

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
    lines.push(
      padEnd(p.address.slice(0, 12), 14) +
        padEnd(p.name ?? dim('(anon)', style), nameW) +
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
