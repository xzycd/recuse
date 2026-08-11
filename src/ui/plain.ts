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
  accent, bold, clip, count, dim, displayName, label, meter, money, padEnd, padStart, paintRounds,
  pct, rule, shortAddress, until, wrap,
} from './format.js';
import { formatSteps } from '../core/dispute.js';
import { winnerMoney, winningSide } from '../core/capture.js';
import { waited, type Pending, type QueueScan } from '../core/queue.js';
import { span, type LedgerSummary } from '../core/ledger.js';
import type { Style } from './format.js';
import type { Assessment, Concentration, Regular, RepeatPlayer, Winner } from '../types.js';
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
    /**
     * What this reading stood on, passed in rather than inferred from a tier
     * string. The renderer used to decide this by searching the tier for the
     * substring "chain", which made a display decision the authority on an
     * evidence question.
     */
    evidence?: string;
    /** What moved since the last run, already worded by core/recall.ts. */
    recall?: string;
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

  if (meta.recall) lines.push(dim(meta.recall, style));

  const tier = assessments[0]?.tier;
  if (tier || meta.evidence) {
    lines.push(dim([tier, meta.evidence].filter(Boolean).join('. '), style));
  }

  if (meta.notice) lines.push(dim(meta.notice, style));

  return lines.join('\n');
}

/**
 * A sentence under a table, wrapped to the terminal.
 *
 * The footers say what a reading did not cover, and they got longer as the
 * coverage got more complicated. At eighty columns the line naming where the
 * index stops and how much of the gap the log filled ran two thirds again past
 * the edge, which on most terminals wraps mid-word and on the rest is simply
 * gone.
 */
function note(text: string, style: Style): string[] {
  return wrap(text, style.width).map((line) => dim(line, style));
}

/**
 * The caveat block, wrapped rather than cut.
 *
 * Every surface here prints the whole list, and every one of them used to clip
 * each line to the terminal width. The longest caveat in the tool, the one
 * naming where the trade index stops and what was read instead, ended at "so
 * t…" in eighty columns, which is a caveat that cannot do its job. Cutting is
 * right for a table cell whose column has to hold its width, and wrong for a
 * sentence, where nothing below depends on where the line ends.
 */
function caveatBlock(caveats: string[], style: Style): string[] {
  const out: string[] = [];

  for (const caveat of caveats) {
    const [first, ...rest] = wrap(caveat, Math.max(20, style.width - 4));
    out.push(dim(`  \u00b7 ${first}`, style));
    // Indented past the bullet, so a wrapped caveat reads as one item and not
    // as two.
    for (const line of rest) out.push(dim(`    ${line}`, style));
  }

  return out;
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

    const m = a.winners ? winnerMoney(a.winners) : undefined;
    if (m) {
      // Arithmetic. Every held token on the winning side redeemed for a dollar,
      // so this is the difference between two sums and not a model.
      lines.push(
        `${padEnd('  they paid', 14)}${money(m.paid)} ` +
          dim(`for ${count(m.tokens)} tokens that redeemed for ${money(m.redeemed)}`, style),
      );
      lines.push(
        `${padEnd('  net', 14)}${money(m.gain)} ` +
          dim(`across ${m.wallets} wallets read`, style),
      );
    }
  }

  if (a.market.resolutionSource) {
    lines.push('');
    lines.push(dim('resolution source', style));
    lines.push(`  ${clip(a.market.resolutionSource, w - 2)}`);
  }

  if (a.caveats.length > 0) {
    lines.push('');
    lines.push(dim('caveats', style));
    lines.push(...caveatBlock(a.caveats, style));
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
    const named = displayName(p.name, p.address);
    const name = named
      ? padEnd(named, nameW)
      : dim(padEnd('(anon)', nameW), style);

    lines.push(
      // `0x614f…3b8a`, not the first twelve characters. A full address cut to
      // fit reads like an identifier and cannot be checked against anything,
      // which is the rule the winners table already follows. The full form is
      // in --json.
      padEnd(shortAddress(p.address), 14) +
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
 * Who keeps ending up on the winning side of contested markets.
 *
 * The counterpart to `renderPlayers`, and the numbers are not comparable with
 * it: that table counts balances, this one counts trades, and the footer says
 * so on both. `wins` carries `marketsScored` as its denominator on every row,
 * because "won 5" means nothing without how many were opened.
 */
export function renderRegulars(
  scan: {
    regulars: Regular[];
    marketsRead: number;
    marketsScored: number;
    marketsFailed: number;
    undecided: number;
    empty: number;
    beyondIndex: number;
    coverageUnknown: number;
    indexHead?: string;
    fromLog: number;
    fromLogPastIndex: number;
    logCut: number;
    logFloorLow: number;
    logFloorHigh: number;
    floorLow: number;
    floorHigh: number;
    floorRaised: number;
    wallets: number;
    namesAsked: number;
    namesFailed: number;
    positionsDropped: number;
    tradesDropped: number;
  },
  style: Style,
): string {
  const lines: string[] = [];

  lines.push(
    bold('regulars', style) +
      dim(` · winning side of ${scan.marketsScored} contested markets rebuilt from trades`, style),
  );
  lines.push(rule(style));

  if (scan.regulars.length === 0) {
    lines.push(
      dim(
        scan.marketsScored === 0
          ? 'no winning side could be rebuilt for any market scanned.'
          : `no address won more than one of the ${scan.marketsScored} markets scored.`,
        style,
      ),
    );
    if (scan.marketsFailed > 0) {
      lines.push(dim(`${scan.marketsFailed} markets could not be read at all.`, style));
    }
    if (scan.empty > 0) {
      lines.push(dim(`${scan.empty} markets had no position above the floor.`, style));
    }
    if (scan.beyondIndex > 0) {
      const unread = scan.beyondIndex - scan.fromLogPastIndex;
      lines.push(
        ...note(
          `${scan.beyondIndex} markets were beyond the trade index; `
            + `${scan.fromLogPastIndex} were rebuilt from the live log and ${unread} stayed unread.`,
          style,
        ),
      );
    }
    if (scan.coverageUnknown > 0) {
      lines.push(dim(`${scan.coverageUnknown} markets had unknown index coverage and stayed unread.`, style));
    }
    if (scan.positionsDropped > 0) {
      lines.push(dim(`${scan.positionsDropped} malformed positions were omitted.`, style));
    }
    if (scan.tradesDropped > 0) {
      lines.push(dim(`${scan.tradesDropped} malformed trades were omitted.`, style));
    }
    return lines.join('\n');
  }

  const nameW = Math.max(12, style.width - 46);

  lines.push(
    dim(
      padEnd('ADDRESS', 14) + padEnd('NAME', nameW) +
        padStart('WON', 5) + padStart('OF', 5) + padStart('TOKENS', 9) + padStart('NET', 9),
      style,
    ),
  );

  scan.regulars.slice(0, 40).forEach((r, i) => {
    // Padded before dimming, or the escape sequence eats cells the column
    // budgeted for. Same rule as every other table here.
    const named = displayName(r.name, r.address);
    // Three states, not two. `(anon)` is a claim that the account has no name,
    // and it can only be made about a row a request was actually made for.
    // Past that, the honest cell is the no-data glyph.
    const name = named
      ? padEnd(named, nameW)
      : dim(padEnd(i < scan.namesAsked ? '(anon)' : '—', nameW), style);

    lines.push(
      padEnd(shortAddress(r.address), 14) +
        name +
        // Coloured on the win count, which is the one ramp this tool has and
        // the closest thing here to the dispute rounds it usually carries.
        paintRounds(r.wins > 2 ? 2 : r.wins - 1, padStart(String(r.wins), 5), style) +
        dim(padStart(String(scan.marketsScored), 5), style) +
        padStart(count(r.tokens), 9) +
        padStart(signed(r.gain), 9),
    );
  });

  lines.push(rule(style));
  lines.push(
    dim(
      `${scan.regulars.length} of ${scan.wallets} winning wallets took more than one, `
        + `across ${scan.marketsScored} markets scored.`,
      style,
    ),
  );

  // Everything the tally did not cover, counted rather than implied. A market
  // neither trade source read is not a market nobody won.
  const gaps: string[] = [];
  if (scan.marketsFailed > 0) gaps.push(`${scan.marketsFailed} could not be read`);
  if (scan.undecided > 0) gaps.push(`${scan.undecided} not settled yet`);
  if (scan.empty > 0) gaps.push(`${scan.empty} had no position above the floor and are not scored`);
  if (scan.coverageUnknown > 0) gaps.push(`${scan.coverageUnknown} had unknown index coverage`);
  if (gaps.length > 0) lines.push(dim(`${gaps.join(', ')}.`, style));

  if (scan.positionsDropped + scan.tradesDropped > 0) {
    lines.push(
      ...note(
        `${scan.positionsDropped} malformed index positions and ${scan.tradesDropped} malformed log trades were omitted.`,
        style,
      ),
    );
  }

  // The gap that used to be invisible. These markets were not quiet, they were
  // never reached, and the store reports both the same way. Now most of them
  // are answered from the trade log, so the line says how many and on what
  // terms rather than writing them all off.
  if (scan.beyondIndex > 0) {
    const where = scan.indexHead ? ` at ${scan.indexHead.slice(0, 10)}` : '';
    // Only the ones past the index count against this sentence. `fromLog` also
    // holds markets the store refused outright, and subtracting all of it from
    // `beyondIndex` printed 22 of 18 rescued.
    const unread = scan.beyondIndex - scan.fromLogPastIndex;
    lines.push(
      ...note(
        `${scan.beyondIndex} closed after the trade index stops${where}. `
          + (scan.fromLogPastIndex > 0
            ? `${scan.fromLogPastIndex} of those were rebuilt from the trade log instead`
              + (unread > 0 ? `, and ${unread} were not read at all.` : '.')
            : 'none of them could be read at all.'),
        style,
      ),
    );
  }

  const rescued = scan.fromLog - scan.fromLogPastIndex;
  if (rescued > 0) {
    lines.push(
      ...note(`${rescued} more came from the log where the index could not provide a reliable answer.`, style),
    );
  }

  if (scan.logFloorHigh > 0) {
    lines.push(
      ...note(
        `the log counted only trades of $${scan.logFloorLow} or more`
          + (scan.logFloorHigh > scan.logFloorLow
            ? `, rising to $${scan.logFloorHigh} on the markets too busy to read below that.`
            : '.'),
        style,
      ),
    );
  }

  // Worse than a floor and reported separately. A floor drops the small trades
  // and names its size; this drops the older half of a market and keeps the
  // recent one, so those rows are partial rather than cumulative.
  if (scan.logCut > 0) {
    lines.push(
      ...note(
        `${scan.logCut} of those had more trades than the log will page to, `
          + 'so their totals cover only the most recent ones.',
        style,
      ),
    );
  }

  if (scan.floorHigh > 0) {
    // The floor is per market, because the store makes us raise it whenever it
    // times out. Reporting the largest as though it applied everywhere would
    // overstate what was left out of the markets that answered cheaply.
    lines.push(
      ...note(
        scan.floorRaised > 0
          ? `positions at or below ${scan.floorLow} tokens were never requested, and ${scan.floorRaised} markets `
            + `needed a higher floor, up to ${scan.floorHigh}.`
          : `positions at or below ${scan.floorLow} tokens were never requested, so small wins are absent.`,
        style,
      ),
    );
  }
  if (scan.regulars.length > scan.namesAsked) {
    lines.push(
      ...note(`names were looked up for the top ${scan.namesAsked} rows only. below that the column is unread.`, style),
    );
  }
  if (scan.namesFailed > 0) {
    lines.push(dim(`${scan.namesFailed} names could not be looked up and show as addresses.`, style));
  }
  lines.push(
    dim('from trades, not balances. these wallets redeemed and hold nothing now.', style),
  );
  // The restraint that has to be on screen, not only in the docs.
  lines.push(
    dim('someone wins every market. repeatedly is a question, not a finding.', style),
  );

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
  // Which side won comes from the market's own prices, not from the trade
  // reading. Taking it off `winnerConcentration` printed "? side won" on every
  // market past the trade index, where the outcome is not in doubt at all and
  // only the wallets behind it are unread.
  const side = wc?.side ?? winningSide(a.market);
  lines.push(
    dim(
      `${side ?? '?'} side won after ${a.dispute.rounds} dispute round(s) · ${money(a.pool)} traded`,
      style,
    ),
  );
  lines.push(rule(style));

  if (winners.length === 0) {
    // Read off `winners` rather than the old index boundary. A successful live
    // log can authoritatively return no surviving positions for a market the
    // index never reached, and calling that result unread discards the source
    // that answered.
    const unread = a.winners === undefined;
    lines.push(
      dim(
        unread && a.tradeIndexCoverage?.status === 'beyond'
          ? `the winning side was not read. the trade index stops at ${a.tradeIndexCoverage.lastTradeAt.slice(0, 10)} `
            + 'and this market closed after that.'
          : unread && a.tradeIndexCoverage?.status === 'unknown'
            ? `the winning side was not read. ${a.tradeIndexCoverage.reason}.`
            : unread
              ? 'the winning side was not read.'
              : 'no winning positions were returned for this market.',
        style,
      ),
    );
    lines.push(...caveatBlock(a.caveats, style));
    return lines.join('\n');
  }

  // The trade sources have no display names, so these are joined in from the
  // data API's activity records. A name never replaces the address: it is
  // chosen by the account and nothing stops one calling itself another
  // account's address, so the anchor stays on screen and the full form stays in
  // --json.
  const addrW = Math.min(44, Math.max(14, style.width - 52));
  const named = winners.some((w) => w.name);
  // 42 is a full address. Below that, or once names need room beside them,
  // the whole column abbreviates rather than truncating some rows and not others.
  const short = named || addrW < 42;
  const total = wc?.totalSize ?? 0;

  lines.push(
    dim(
      padEnd(named ? 'WHO' : 'ADDRESS', addrW) +
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
      padEnd(label(w.name, w.address, addrW, short), addrW) +
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
  // Every caveat about this reading, not a chosen subset. This used to keep
  // only the two that start "winning side" and "more winning", which dropped
  // the floor the subgraph needed, the count of names that could not be looked
  // up, and the note that no oracle data was read at all. The comment already
  // said every one of them, which is the version that was right: the caveats
  // are assembled as data precisely so no surface can quietly choose among
  // them, and the empty-winners branch above prints the whole list.
  lines.push(...caveatBlock(a.caveats, style));

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
  return `${n >= 0 ? '+' : '-'}${money(Math.abs(n))}`;
}

/**
 * One wallet's settlement positions, contested markets first.
 *
 * Sorted that way because someone opening this in `recuse` rather than in a
 * generic wallet tracker is here for the disputed ones. The summary reports
 * contested separately from everything for the same reason.
 */
export function renderWallet(
  ledger: {
    address: string;
    name?: string;
    entries: {
      question: string; side: string; rounds: number; net: number; cost: number;
      gain?: number; payout?: number; resolved: boolean;
    }[];
    won: number; lost: number; split: number; exited: number; open: number;
    gain: number; contestedGain: number; contested: number; caveats: string[];
  },
  style: Style,
): string {
  const lines: string[] = [];

  // The address leads, always. A name is chosen by the account and the address
  // is what every row below joins on. A name that is just the address again is
  // dropped rather than printed twice in two different cases.
  const walletName = displayName(ledger.name, ledger.address);
  lines.push(
    bold(ledger.address, style) + (walletName ? dim(`  ${walletName}`, style) : ''),
  );

  const resolved = ledger.won + ledger.lost + ledger.split + ledger.exited;
  if (resolved === 0 && ledger.open === 0) {
    lines.push(rule(style));
    lines.push(dim('no positions found for this address.', style));
    lines.push(...caveatBlock(ledger.caveats, style));
    return lines.join('\n');
  }

  const summary = [
    `${resolved} resolved`,
    `${ledger.won} won`,
    `${ledger.lost} lost`,
    ledger.split > 0 ? `${ledger.split} split` : '',
    ledger.exited > 0 ? `${ledger.exited} exited` : '',
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
      // Held nothing when it settled, so it was paid nothing. Checked ahead of
      // the payout, because a wallet that sold out of the winning side would
      // otherwise read as having won a market it was not in.
      : e.net <= 0
        ? dim(padEnd('exited', 8), style)
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
  lines.push(...caveatBlock(ledger.caveats, style));

  return lines.join('\n');
}

/**
 * What has not finished, longest wait first.
 *
 * The counts under the table are the point as much as the rows are. A list of
 * 40 unfinished markets means nothing without how many were examined and how
 * many of those never reached the oracle at all.
 */
export function renderQueue(scan: QueueScan, rows: Pending[], style: Style): string {
  const lines: string[] = [];
  const w = style.width;

  lines.push(bold('in the oracle', style));
  lines.push(
    dim('markets whose resolution record has not reached a terminal step', style),
  );
  lines.push(rule(style));

  if (rows.length === 0) {
    lines.push(dim(`nothing pending in ${scan.scanned} markets examined.`, style));
    return lines.join('\n');
  }

  const showPool = w >= 72;
  const nameW = Math.max(20, w - (8 + 6 + 5 + (showPool ? 9 : 0) + 12));

  lines.push(
    dim(
      padEnd('MARKET', nameW) +
        padStart('WAITED', 8) +
        padStart('RDS', 5) +
        '  ' + padEnd('LIFECYCLE', 12) +
        (showPool ? padStart('POOL', 9) : ''),
      style,
    ),
  );

  for (const p of rows) {
    lines.push(
      padEnd(p.market.question, nameW) +
        padStart(waited(p.waited), 8) +
        paintRounds(p.dispute.rounds, padStart(p.dispute.rounds > 0 ? `${p.dispute.rounds}×` : '·', 5), style) +
        '  ' + dim(padEnd(clip(formatSteps(p.dispute.steps), 12), 12), style) +
        (showPool ? padStart(money(p.market.volume), 9) : ''),
    );
  }

  lines.push(rule(style));
  lines.push(
    dim(
      `${scan.pending.length} pending of ${scan.scanned} examined. ` +
        `${scan.finished} finished, ${scan.noLifecycle} never reached the oracle.`,
      style,
    ),
  );
  if (scan.undated > 0) {
    lines.push(dim(`${scan.undated} have no deadline recorded and sort last.`, style));
  }
  // The honest caveat. A lifecycle that stopped short is not proof of a stall.
  lines.push(
    dim('a record that stops short may be a slow oracle or a feed that never appended.', style),
  );

  return lines.join('\n');
}

/**
 * The event log, summarised.
 *
 * This is the one thing here that cannot be recomputed from a public endpoint,
 * so the header leads with how much of it there is.
 */
export function renderLedger(s: LedgerSummary, style: Style): string {
  const lines: string[] = [];
  const w = style.width;

  if (s.events === 0) {
    return dim('no events recorded yet. run `recuse watch` and leave it running.', style);
  }

  const days = span(s);
  lines.push(bold('the log', style));
  lines.push(
    dim(
      `${s.events} events across ${s.markets} markets` +
        (days === undefined ? '' : days < 1 ? ', all inside one day' : `, over ${Math.round(days)} days`),
      style,
    ),
  );
  if (s.first && s.last) {
    lines.push(dim(`${s.first.slice(0, 16).replace('T', ' ')} to ${s.last.slice(0, 16).replace('T', ' ')}`, style));
  }
  lines.push(rule(style));

  const kinds = Object.entries(s.byKind).sort((a, b) => b[1] - a[1]);
  if (kinds.length > 0) {
    lines.push(dim('what happened', style));
    for (const [kind, n] of kinds) {
      lines.push(`  ${padEnd(kind, 12)}${padStart(String(n), 6)}`);
    }
  }

  if (s.busiest.length > 0) {
    lines.push('');
    lines.push(dim('moved most often', style));
    const nameW = Math.max(20, w - 22);
    // Both numbers are counts and neither is a duration, which is worth saying
    // in a view whose header is measuring the log in days. The rounds column
    // read `3d` here and `3×` in every other table in the tool, so next to an
    // events count it parsed as three days rather than three disputes.
    lines.push(
      dim('  ' + padEnd('MARKET', nameW) + padStart('EVENTS', 6) + padStart('RDS', 5), style),
    );
    for (const m of s.busiest) {
      lines.push(
        '  ' + padEnd(m.question, nameW) +
          padStart(`${m.events}×`, 6) +
          paintRounds(m.rounds, padStart(m.rounds > 0 ? `${m.rounds}×` : '·', 5), style),
      );
    }
  }

  if (s.unfinished.length > 0) {
    lines.push('');
    lines.push(dim('last seen unfinished', style));
    const nameW = Math.max(20, w - 26);
    lines.push(
      dim('  ' + padEnd('MARKET', nameW) + padStart('LAST STEP', 11) + padStart('SEEN', 7), style),
    );
    for (const m of s.unfinished) {
      lines.push(
        '  ' + padEnd(m.question, nameW) +
          padStart(m.lastKind, 11) +
          dim(padStart(m.lastAt.slice(5, 10), 7), style),
      );
    }
  }

  lines.push(rule(style));
  if (s.truncated) {
    // The counts above are over the tail, not the log. Saying so is the whole
    // difference between a summary and a wrong total.
    lines.push(dim('log too large to read whole. everything above is its most recent part.', style));
  }
  if (s.skipped > 0) {
    lines.push(dim(`${s.skipped} unreadable lines, from a process killed mid-append.`, style));
  }
  lines.push(
    dim('append only, never rewritten. this file is the part nobody else is keeping.', style),
  );

  return lines.join('\n');
}

/**
 * A market as a block you can paste into a chat.
 *
 * Deliberately not the table. This is sized for a phone-width chat window,
 * carries no colour and no box drawing, and every share still arrives with its
 * denominator, because the whole reason to paste one of these is to settle an
 * argument and a number nobody can check settles nothing.
 */
export function renderCard(a: Assessment): string {
  const lines: string[] = [];
  const W = 58;

  lines.push(clip(a.market.question, W));
  lines.push('');

  const rounds = a.dispute.rounds;
  lines.push(
    rounds > 0
      ? `${rounds} dispute round${rounds === 1 ? '' : 's'}  ${formatSteps(a.dispute.steps)}  ${money(a.pool)} traded`
      : `never contested  ${formatSteps(a.dispute.steps)}  ${money(a.pool)} traded`,
  );

  const c = a.concentration;
  if (c && c.meaning === 'wiped') {
    lines.push('');
    lines.push(`${c.side} lost. ${count(c.totalSize)} tokens went to zero.`);
    lines.push(
      `  top ${c.topN} of ${c.holderCount} holders held ${pct(c.topShare)} of it`,
    );
  }

  const wc = a.winnerConcentration;
  if (wc) {
    lines.push('');
    lines.push(`${wc.side} won. ${count(wc.totalSize)} tokens, rebuilt from trades.`);
    lines.push(
      `  top ${wc.topN} of ${wc.holderCount} wallets bought ${pct(wc.topShare)} of it`,
    );

    const m = a.winners ? winnerMoney(a.winners) : undefined;
    if (m) {
      lines.push(`  they paid ${money(m.paid)} and redeemed ${money(m.redeemed)}`);
    }
    lines.push('');
    lines.push('balances cannot see this side. winners redeem and leave.');
  }

  if (a.market.slug) {
    lines.push('');
    lines.push(`https://polymarket.com/event/${a.market.slug}`);
  }

  lines.push('');
  lines.push(`${a.tier} · recuse market ${a.market.slug || a.market.conditionId}`);

  return lines.join('\n');
}
