/**
 * The interactive radar.
 *
 * Two levels and no more: a list of contested markets, and one detail pane for
 * the selected row. A third level would need its own navigation model and the
 * data does not go that deep. The help overlay is not a third level, it is a
 * modal over the first one.
 *
 * Everything here is a view over the same assessments the plain renderer and
 * `--json` receive. If a number is visible in one surface it is present in all
 * three, so nobody can be shown a figure they cannot pipe. Sorting and
 * filtering live in `core/rank.ts` and are pure, because a sort order is a
 * claim about what matters and deserves a test.
 *
 * Ink takes hex colours directly, so the theme is handed in whole rather than
 * translated. One colour table, two surfaces.
 */

import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import { formatSteps } from '../core/dispute.js';
import {
  filterAssessments, nextSort, SORT_LABELS, sortAssessments, viewport, type SortMode,
} from '../core/rank.js';
import { clip, count, meter, money, pct, until } from './format.js';
import { FACE, WORDMARK } from './logo.js';
import { THEMES, themeNames, type Theme } from './theme.js';
import type { Assessment } from '../types.js';

/** Rows of chrome above and below the table. Used to size the viewport. */
const CHROME_ROWS = 12;

interface Props {
  assessments: Assessment[];
  scanned: number;
  contestedTotal: number;
  theme: Theme;
  notice?: string;
}

export function App({ assessments, scanned, contestedTotal, theme: initial, notice }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const [helping, setHelping] = useState(false);
  const [sort, setSort] = useState<SortMode>('rounds');
  const [theme, setTheme] = useState(initial);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [size, setSize] = useState({ w: stdout?.columns ?? 80, h: stdout?.rows ?? 24 });

  // A resize that is not handled leaves a table wrapping into garbage, which
  // in a dense layout is worse than not rendering at all.
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ w: stdout.columns ?? 80, h: stdout.rows ?? 24 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const rows = useMemo(
    () => sortAssessments(filterAssessments(assessments, query), sort),
    [assessments, query, sort],
  );

  // A filter that shortens the list must not leave the cursor past the end.
  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, rows.length - 1)));
  }, [rows.length]);

  useInput((input, key) => {
    // Search owns the keyboard while it is open, or typing "q" to search for
    // Qatar would quit instead.
    if (searching) {
      if (key.escape) {
        setSearching(false);
        setQuery('');
        return;
      }
      if (key.return) return setSearching(false);
      if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setQuery((q) => q + input);
      return;
    }

    if (key.ctrl && input === 'c') return exit();

    if (helping) {
      setHelping(false);
      return;
    }

    if (input === 'q' || key.escape) {
      if (open) return setOpen(false);
      if (query) return setQuery('');
      return exit();
    }

    if (input === '?') return setHelping(true);
    if (input === '/') {
      setSearching(true);
      setQuery('');
      return;
    }
    if (input === 's') return setSort((m) => nextSort(m));
    if (input === 't') {
      // Cycling themes live is the cheapest delight in the whole tool and it
      // costs one line of state.
      const names = themeNames();
      const next = names[(names.indexOf(theme.name) + 1) % names.length]!;
      return setTheme(THEMES[next]!);
    }

    if (key.return) return setOpen((v) => !v);
    if (key.downArrow || input === 'j') setCursor((c) => Math.min(c + 1, rows.length - 1));
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(c - 1, 0));
    if (input === 'g') setCursor(0);
    if (input === 'G') setCursor(rows.length - 1);
    if (key.pageDown) setCursor((c) => Math.min(c + 10, rows.length - 1));
    if (key.pageUp) setCursor((c) => Math.max(c - 10, 0));
  });

  const width = size.w;
  const roundsColour = (n: number) => theme.ramp[n === 0 ? 0 : n === 1 ? 1 : 2];
  const selected = rows[cursor];

  if (helping) return <Help theme={theme} width={width} />;
  if (open && selected) return <Detail assessment={selected} width={width} theme={theme} />;

  const cols = {
    pool: width >= 74,
    lifecycle: width >= 106,
    clock: width >= 120,
  };
  // Two extra cells on the left for the selection gutter.
  const nameW = Math.max(
    18,
    width - (2 + 5 + 9 + 16 + (cols.pool ? 9 : 0) + (cols.lifecycle ? 24 : 0) + (cols.clock ? 7 : 0)),
  );

  const height = Math.max(3, size.h - CHROME_ROWS);
  const { start, end } = viewport(rows.length, cursor, height);
  const visible = rows.slice(start, end);

  const wide = width >= 62;

  return (
    <Box flexDirection="column">
      {width >= 34 ? (
        <Box flexDirection="row">
          {wide ? (
            <Box flexDirection="column" marginRight={2}>
              {FACE.map((row, i) => (
                <Text key={i} color={theme.ramp[1]}>{row}</Text>
              ))}
            </Box>
          ) : null}
          <Box flexDirection="column">
            {WORDMARK.map((row, i) => (
              <Text key={i} color={theme.accent} bold>{row}</Text>
            ))}
            <Text color={theme.dim}>
              {`${contestedTotal} contested of ${scanned} · ${SORT_LABELS[sort]} · ${theme.name}`}
            </Text>
          </Box>
        </Box>
      ) : null}

      <Text color={theme.rule}>{'─'.repeat(width)}</Text>

      <Text color={theme.dim}>
        {'  '}
        {'MARKET'.padEnd(nameW)}
        {'RDS'.padStart(5)}
        {'WIPED'.padStart(9)}
        {'TOP 5 HELD'.padStart(16)}
        {cols.pool ? 'POOL'.padStart(9) : ''}
        {cols.lifecycle ? '  ' + 'LIFECYCLE'.padEnd(22) : ''}
        {cols.clock ? 'ENDS'.padStart(7) : ''}
      </Text>

      {visible.length === 0 ? (
        <Text color={theme.dim}>{`  nothing matches "${query}"`}</Text>
      ) : null}

      {visible.map((a, i) => {
        const c = a.concentration;
        const on = start + i === cursor;
        const n = a.dispute.rounds;

        return (
          <Text key={a.market.conditionId || start + i}>
            {/* A gutter bar rather than a full inverse row. Inverse repaints the
                whole line and buries the one coloured signal in it. */}
            <Text color={theme.accent}>{on ? '▍ ' : '  '}</Text>
            <Text color={on ? theme.accent : theme.text} bold={on}>
              {clip(a.market.question, nameW).padEnd(nameW)}
            </Text>
            <Text color={roundsColour(n)}>{(n > 0 ? `${n}×` : '·').padStart(5)}</Text>
            <Text color={theme.text}>
              {(c && c.meaning === 'wiped' ? count(c.totalSize) : '—').padStart(9)}
              {/* The share never appears without the terms behind it. */}
              {(c ? `${meter(c.topShare)} ${pct(c.topShare)} ${c.topN}/${c.holderCount}` : '—').padStart(16)}
              {cols.pool ? money(a.pool).padStart(9) : ''}
            </Text>
            {cols.lifecycle ? (
              <Text color={theme.dim}>{'  ' + clip(formatSteps(a.dispute.steps), 22).padEnd(22)}</Text>
            ) : null}
            {cols.clock ? <Text color={theme.text}>{until(a.dispute.deadline).padStart(7)}</Text> : null}
          </Text>
        );
      })}

      <Text color={theme.rule}>{'─'.repeat(width)}</Text>

      {/* Nothing is filtered away silently, including by the search box. */}
      <Text color={theme.dim}>
        {rows.length === assessments.length
          ? `${scanned - contestedTotal} never contested and not shown`
          : `${rows.length} of ${assessments.length} shown, filtered by "${query}"`}
        {rows.length > 0 ? `  ·  ${cursor + 1} of ${rows.length}` : ''}
      </Text>

      <Text color={theme.dim}>
        {(assessments[0]?.tier ?? '').includes('chain')
          ? assessments[0]!.tier
          : 'positions only, set RECUSE_RPC_URL to read proposer and disputer'}
      </Text>

      {notice ? <Text color={theme.ramp[1]}>{notice}</Text> : null}

      {searching ? (
        <Text>
          <Text color={theme.accent}>{'/'}</Text>
          <Text color={theme.text}>{query}</Text>
          <Text color={theme.accent}>▏</Text>
          <Text color={theme.dim}>{`   ${rows.length} match   enter keep   esc clear`}</Text>
        </Text>
      ) : (
        <Text color={theme.dim}>
          {wide
            ? 'j k move   enter detail   / search   s sort   t theme   ? keys   q quit'
            : 'j k  enter  /  s  t  ?  q'}
        </Text>
      )}
    </Box>
  );
}

function Help({ theme, width }: { theme: Theme; width: number }) {
  const keys: [string, string][] = [
    ['j k  ↑ ↓', 'move the cursor'],
    ['g  G', 'first row, last row'],
    ['pgup pgdn', 'jump ten rows'],
    ['enter', 'open and close the detail pane'],
    ['/', 'filter by question or slug, esc clears it'],
    ['s', `cycle the sort: ${Object.values(SORT_LABELS).join(', ')}`],
    ['t', `cycle the theme: ${themeNames().join(', ')}`],
    ['?', 'this'],
    ['q  esc', 'back, then quit'],
  ];

  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>keys</Text>
      <Text color={theme.rule}>{'─'.repeat(width)}</Text>
      {keys.map(([k, what]) => (
        <Text key={k}>
          <Text color={theme.accent}>{'  ' + k.padEnd(12)}</Text>
          <Text color={theme.text}>{clip(what, Math.max(10, width - 16))}</Text>
        </Text>
      ))}
      <Text color={theme.rule}>{'─'.repeat(width)}</Text>
      <Text color={theme.dim}>
        {'every screen here is also --json. anything you can read you can pipe.'}
      </Text>
      <Text color={theme.dim}>{'any key to go back'}</Text>
    </Box>
  );
}

function Detail({
  assessment: a, width, theme,
}: { assessment: Assessment; width: number; theme: Theme }) {
  const c = a.concentration;
  const wc = a.winnerConcentration;
  const label = (t: string) => t.padEnd(14);
  const roundsColour = (n: number) => theme.ramp[n === 0 ? 0 : n === 1 ? 1 : 2];

  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>{clip(a.market.question, width)}</Text>
      <Text color={theme.dim}>{clip(a.market.conditionId, width)}</Text>
      <Text color={theme.rule}>{'─'.repeat(width)}</Text>

      <Text color={theme.text}>
        {label('disputes')}
        <Text color={roundsColour(a.dispute.rounds)}>
          {a.dispute.rounds > 0 ? `${a.dispute.rounds} round(s)` : 'never contested'}
        </Text>
      </Text>
      <Text color={theme.text}>{label('lifecycle') + formatSteps(a.dispute.steps)}</Text>
      <Text color={theme.text}>{label('phase') + a.dispute.phase}</Text>
      <Text color={theme.text}>{label('volume') + money(a.pool)}</Text>
      {a.market.umaBond ? <Text color={theme.text}>{label('bond') + `$${a.market.umaBond}`}</Text> : null}
      {a.dispute.deadline ? <Text color={theme.text}>{label('ends') + until(a.dispute.deadline)}</Text> : null}

      {c ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>
            {c.meaning === 'wiped'
              ? `${c.side} side lost, ${count(c.totalSize)} tokens went to zero`
              : `${c.side} side leads, market still open`}
          </Text>
          <Text color={theme.text}>
            {label('  top holders') + `${meter(c.topShare)} ${pct(c.topShare)} `}
            <Text color={theme.dim}>
              {`(${c.topN} of ${c.holderCount} holders, ${count(c.topSize)} of ${count(c.totalSize)} tokens)`}
            </Text>
          </Text>
        </Box>
      ) : null}

      {wc ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>
            {`${wc.side} side won, ${count(wc.totalSize)} tokens rebuilt from trades`}
          </Text>
          <Text color={theme.text}>
            {label('  top buyers') + `${meter(wc.topShare)} ${pct(wc.topShare)} `}
            <Text color={theme.dim}>
              {`(${wc.topN} of ${wc.holderCount} wallets, ${count(wc.topSize)} of ${count(wc.totalSize)} tokens)`}
            </Text>
          </Text>
        </Box>
      ) : null}

      {a.market.slug ? (
        <Box flexDirection="column" marginTop={1}>
          {/* Printed rather than opened. Opening it would need a spawned
              process, and nothing here spawns anything. Most terminals make
              this clickable on their own. */}
          <Text color={theme.dim}>{clip(`https://polymarket.com/event/${a.market.slug}`, width)}</Text>
        </Box>
      ) : null}

      {a.caveats.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>caveats</Text>
          {a.caveats.map((text) => (
            <Text key={text} color={theme.dim}>{'  · ' + clip(text, width - 4)}</Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.dim}>{'esc back   q quit'}</Text>
      </Box>
    </Box>
  );
}
