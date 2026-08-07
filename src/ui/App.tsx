/**
 * The interactive radar.
 *
 * Two levels and no more: a list of contested markets, and one detail pane for
 * the selected row. A third level would need its own navigation model and the
 * data does not go that deep.
 *
 * Everything here is a view over the same assessments the plain renderer and
 * `--json` receive. If a number is visible in one surface it is present in all
 * three, so nobody can be shown a figure they cannot pipe.
 *
 * Ink takes hex colours directly, so the theme is handed in whole rather than
 * translated. The plain renderer converts the same hex values to whatever
 * escape depth the terminal admits to. One colour table, two surfaces.
 */

import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import { formatSteps } from '../core/dispute.js';
import { clip, count, meter, money, pct, until } from './format.js';
import { WORDMARK } from './logo.js';
import type { Theme } from './theme.js';
import type { Assessment } from '../types.js';

interface Props {
  assessments: Assessment[];
  scanned: number;
  contestedTotal: number;
  theme: Theme;
  notice?: string;
}

export function App({ assessments, scanned, contestedTotal, theme, notice }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(stdout?.columns ?? 80);

  // A resize that is not handled leaves a table wrapping into garbage, which
  // in a dense layout is worse than not rendering at all.
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setWidth(stdout.columns ?? 80);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (open) return setOpen(false);
      return exit();
    }
    if (key.ctrl && input === 'c') return exit();
    if (key.return) return setOpen((v) => !v);
    if (key.downArrow || input === 'j') setCursor((c) => Math.min(c + 1, assessments.length - 1));
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(c - 1, 0));
    if (input === 'g') setCursor(0);
    if (input === 'G') setCursor(assessments.length - 1);
  });

  /** The one colour ramp: how many times a market was contested. */
  const roundsColour = (rounds: number) => theme.ramp[rounds === 0 ? 0 : rounds === 1 ? 1 : 2];

  const selected = assessments[cursor];
  const cols = useMemo(
    () => ({ pool: width >= 72, lifecycle: width >= 104, clock: width >= 118 }),
    [width],
  );

  const nameW = Math.max(
    18,
    width - (5 + 9 + 16 + (cols.pool ? 9 : 0) + (cols.lifecycle ? 24 : 0) + (cols.clock ? 7 : 0)),
  );

  if (open && selected) {
    return <Detail assessment={selected} width={width} theme={theme} />;
  }

  return (
    <Box flexDirection="column">
      {/* The wordmark stays on screen in the interactive view. It costs three
          rows and it is the only thing telling a full terminal which tool it
          is looking at. Below 34 columns those rows are worth more as data. */}
      {width >= 34 ? (
        <Box flexDirection="column" marginBottom={1}>
          {WORDMARK.map((row, i) => (
            <Text key={i} color={theme.accent} bold>{row}</Text>
          ))}
        </Box>
      ) : null}

      <Text>
        <Text color={theme.accent} bold>recuse</Text>
        <Text color={theme.dim}>
          {` · ${contestedTotal} contested of ${scanned} scanned · showing ${assessments.length}`}
        </Text>
      </Text>
      <Text color={theme.rule}>{'─'.repeat(width)}</Text>

      <Text color={theme.dim}>
        {'MARKET'.padEnd(nameW)}
        {'RDS'.padStart(5)}
        {'WIPED'.padStart(9)}
        {'TOP 5 HELD'.padStart(16)}
        {cols.pool ? 'POOL'.padStart(9) : ''}
        {cols.lifecycle ? '  ' + 'LIFECYCLE'.padEnd(22) : ''}
        {cols.clock ? 'ENDS'.padStart(7) : ''}
      </Text>

      {assessments.map((a, i) => {
        const c = a.concentration;
        const on = i === cursor;
        const rounds = a.dispute.rounds;

        return (
          <Text key={a.market.conditionId || i} inverse={on} color={on ? undefined : theme.text}>
            {clip(a.market.question, nameW).padEnd(nameW)}
            <Text color={on ? undefined : roundsColour(rounds)}>
              {(rounds > 0 ? `${rounds}×` : '·').padStart(5)}
            </Text>
            {(c && c.meaning === 'wiped' ? count(c.totalSize) : '—').padStart(9)}
            {/* The share never appears without the terms behind it. */}
            {(c ? `${meter(c.topShare)} ${pct(c.topShare)} ${c.topN}/${c.holderCount}` : '—').padStart(16)}
            {cols.pool ? money(a.pool).padStart(9) : ''}
            {cols.lifecycle ? '  ' + clip(formatSteps(a.dispute.steps), 22).padEnd(22) : ''}
            {cols.clock ? until(a.dispute.deadline).padStart(7) : ''}
          </Text>
        );
      })}

      <Text color={theme.rule}>{'─'.repeat(width)}</Text>
      <Text color={theme.dim}>
        {`${scanned - contestedTotal} markets hidden, never contested`}
      </Text>
      <Text color={theme.dim}>
        {a0Tier(assessments)}
      </Text>
      {notice ? <Text color={theme.ramp[1]}>{notice}</Text> : null}
      <Text color={theme.dim}>{'↑↓ move   enter detail   q quit'}</Text>
    </Box>
  );
}

/** What evidence the rows are standing on, said out loud on every screen. */
function a0Tier(assessments: Assessment[]): string {
  const tier = assessments[0]?.tier ?? 'positions';
  return tier.includes('chain')
    ? tier
    : 'positions only, set RECUSE_RPC_URL to read proposer and disputer';
}

function Detail({
  assessment: a, width, theme,
}: { assessment: Assessment; width: number; theme: Theme }) {
  const c = a.concentration;
  const wc = a.winnerConcentration;
  const label = (t: string) => t.padEnd(14);
  const roundsColour = (rounds: number) => theme.ramp[rounds === 0 ? 0 : rounds === 1 ? 1 : 2];

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

      {a.market.resolutionSource ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>resolution source</Text>
          <Text color={theme.text}>{'  ' + clip(a.market.resolutionSource, width - 2)}</Text>
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
