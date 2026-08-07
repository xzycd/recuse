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
import type { WatchEvent } from '../core/watch.js';

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

/**
 * One event, one line.
 *
 * A watcher runs for days into a scrollback buffer, so this is shaped like a log
 * line rather than like a card: fixed columns, timestamp first, greppable. The
 * only thing coloured is the round count, same ramp as everywhere else.
 */
export function renderEvent(event: WatchEvent, style: Style): string {
  const time = event.at.slice(11, 19);
  const rounds = event.rounds > 0 ? `${event.rounds}×` : '·';

  const head =
    dim(time, style) +
    ' ' +
    padEnd(event.kind, 10) +
    paintRounds(event.rounds, padStart(rounds, 4), style) +
    padStart(money(event.pool), 9) +
    '  ';

  // The question takes whatever is left. It is the only part anyone reads first,
  // so it is never the thing that gets dropped.
  const room = Math.max(20, style.width - 34);
  const line = head + clip(event.question, room);

  const c = event.concentration;
  if (!c) return line;

  // The share never travels without its terms, on this surface too.
  const side = c.meaning === 'wiped' ? 'losing' : c.meaning === 'redeemed' ? 'winning' : 'leading';
  return (
    line +
    '\n' +
    dim(
      `${' '.repeat(9)}${side} side ${c.side}: ${meter(c.topShare)} ${pct(c.topShare)} ` +
        `(${c.topN} of ${c.holderCount}, ${count(c.totalSize)} tokens)`,
      style,
    )
  );
}

/** The header the watcher prints once, before it goes quiet. */
export function renderWatchStart(
  meta: { watching: number; discover: boolean; scan: number; intervalMs: number; webhook: boolean },
  style: Style,
): string {
  const every = meta.intervalMs >= 60_000
    ? `${Math.round(meta.intervalMs / 60_000)}m`
    : `${Math.round(meta.intervalMs / 1000)}s`;

  const parts = [
    `${meta.watching} on the watchlist`,
    meta.discover ? `discovery across ${meta.scan} markets` : 'watchlist only',
    `every ${every}`,
  ];
  if (meta.webhook) parts.push('webhook on');

  return bold('recuse watch', style) + dim(` · ${parts.join(' · ')}`, style);
}

/** What a pass did, including when it did nothing. Quiet is not the same as fine. */
export function renderPassSummary(
  result: {
    polled: number; failed: string[]; baseline: boolean; suppressed: number; undelivered: number;
    events: unknown[];
  },
  style: Style,
): string | undefined {
  const notes: string[] = [];

  if (result.baseline) {
    // The first pass has no baseline to compare against, so it reports nothing
    // and says so rather than looking like a quiet night.
    notes.push(
      `baseline recorded for ${result.polled} market${result.polled === 1 ? '' : 's'}, nothing reported`,
    );
  }
  if (result.failed.length > 0) {
    notes.push(`${result.failed.length} could not be read: ${result.failed.slice(0, 3).join(', ')}`);
  }
  if (result.suppressed > 0) {
    notes.push(`${result.suppressed} events below your filters`);
  }
  if (result.undelivered > 0) {
    notes.push(`${result.undelivered} not delivered to the webhook`);
  }

  return notes.length > 0 ? dim(`  ${notes.join(' · ')}`, style) : undefined;
}

/** The stored watchlist, with what we last saw of each entry. */
export function renderWatchlist(
  entries: { target: string; seen?: { question: string; steps: string[]; at: string } }[],
  style: Style,
): string {
  const lines = [bold('watching', style), rule(style)];

  if (entries.length === 0) {
    lines.push(dim('nothing yet. recuse watch add <id-or-slug>', style));
    return lines.join('\n');
  }

  for (const entry of entries) {
    lines.push(padEnd(entry.target, Math.min(44, style.width - 30)));
    if (entry.seen) {
      lines.push(
        dim(`  ${clip(entry.seen.question, style.width - 4)}`, style),
      );
      lines.push(
        dim(`  ${entry.seen.steps.join('→') || 'no lifecycle yet'} · seen ${entry.seen.at.slice(0, 16)}`, style),
      );
    } else {
      lines.push(dim('  not polled yet', style));
    }
  }

  return lines.join('\n');
}

/** A signed dollar figure, so a loss never reads like a gain at a glance. */
function signed(n: number): string {
  return `${n >= 0 ? '+' : '-'}${money(Math.abs(n)).replace('$', '$')}`;
}

/**
 * One wallet's record, contested markets first.
 *
 * Sorted that way because someone opening this in `recuse` rather than in a
 * generic wallet tracker is here for the disputed ones. The summary reports
 * contested separately from everything for the same reason.
 */
export function renderWallet(
  ledger: {
    address: string;
    entries: {
      question: string; side: string; rounds: number; net: number; cost: number;
      gain?: number; payout?: number; resolved: boolean;
    }[];
    won: number; lost: number; split: number; open: number;
    gain: number; contestedGain: number; contested: number; caveats: string[];
  },
  style: Style,
): string {
  const lines: string[] = [];

  lines.push(bold(ledger.address, style));

  const resolved = ledger.won + ledger.lost + ledger.split;
  if (resolved === 0 && ledger.open === 0) {
    lines.push(rule(style));
    lines.push(dim('no positions found for this address.', style));
    for (const c of ledger.caveats) lines.push(dim(`  · ${c}`, style));
    return lines.join('\n');
  }

  const summary = [
    `${resolved} resolved`,
    `${ledger.won} won`,
    `${ledger.lost} lost`,
    ledger.split > 0 ? `${ledger.split} split` : '',
    ledger.open > 0 ? `${ledger.open} open` : '',
    `${signed(ledger.gain)} net`,
  ].filter(Boolean);
  lines.push(dim(summary.join(' · '), style));

  if (ledger.contested > 0) {
    // The number this tool exists to show, kept on its own line rather than
    // buried in the summary above it.
    lines.push(
      paintRounds(2, `${ledger.contested} of those were disputed`, style) +
        dim(`, worth ${signed(ledger.contestedGain)}`, style),
    );
  }

  lines.push(rule(style));

  const qW = Math.max(20, style.width - 46);
  lines.push(
    dim(
      padStart('RDS', 4) + '  ' + padEnd('SIDE', 7) + padEnd('RESULT', 8) +
        padStart('HELD', 8) + padStart('GAIN', 10) + '  ' + padEnd('MARKET', qW),
      style,
    ),
  );

  for (const e of ledger.entries.slice(0, 60)) {
    const result = !e.resolved
      ? dim(padEnd('open', 8), style)
      : e.payout === 1
        ? padEnd('won', 8)
        : e.payout === 0
          ? dim(padEnd('lost', 8), style)
          // A split resolution pays both sides something. Reporting it as a
          // loss on both would be wrong on both, and UMA does hand these down.
          : padEnd(`${Math.round((e.payout ?? 0) * 100)}%`, 8);

    lines.push(
      paintRounds(e.rounds, padStart(e.rounds > 0 ? `${e.rounds}×` : '·', 4), style) + '  ' +
        padEnd(e.side, 7) +
        result +
        padStart(count(e.net), 8) +
        padStart(e.gain === undefined ? '—' : signed(e.gain), 10) + '  ' +
        padEnd(e.question, qW),
    );
  }

  lines.push(rule(style));
  lines.push(
    dim('from trades, not balances, so positions that redeemed are still counted.', style),
  );
  for (const c of ledger.caveats) lines.push(dim(`  · ${c}`, style));

  return lines.join('\n');
}
