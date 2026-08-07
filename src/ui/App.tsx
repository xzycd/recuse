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
 */

import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import { formatSteps } from '../core/dispute.js';
import { clip, count, meter, money, pct, until } from './format.js';
import type { Assessment } from '../types.js';

/** The single colour ramp: how many times a market was contested. */
function roundsColour(rounds: number): string | undefined {
  if (rounds === 0) return 'gray';
  if (rounds === 1) return 'yellow';
  return 'red';
}

interface Props {
  assessments: Assessment[];
  scanned: number;
  contestedTotal: number;
}

export function App({ assessments, scanned, contestedTotal }: Props) {
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
    return <Detail assessment={selected} width={width} />;
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>recuse</Text>
        <Text dimColor>
          {` · ${contestedTotal} contested of ${scanned} scanned · showing ${assessments.length}`}
        </Text>
      </Text>
      <Text dimColor>{'─'.repeat(width)}</Text>

      <Text dimColor>
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
          <Text key={a.market.conditionId || i} inverse={on}>
            {clip(a.market.question, nameW).padEnd(nameW)}
            <Text color={roundsColour(rounds)}>
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

      <Text dimColor>{'─'.repeat(width)}</Text>
      <Text dimColor>
        {`${scanned - contestedTotal} markets hidden — never contested`}
      </Text>
      <Text dimColor>
        {assessments[0]?.tier === 'positions'
          ? 'positions only — set RECUSE_RPC_URL to read proposer and disputer'
          : 'positions + chain'}
      </Text>
      <Text dimColor>{'↑↓ move   enter detail   q quit'}</Text>
    </Box>
  );
}

function Detail({ assessment: a, width }: { assessment: Assessment; width: number }) {
  const c = a.concentration;
  const label = (t: string) => t.padEnd(14);

  return (
    <Box flexDirection="column">
      <Text bold>{clip(a.market.question, width)}</Text>
      <Text dimColor>{clip(a.market.conditionId, width)}</Text>
      <Text dimColor>{'─'.repeat(width)}</Text>

      <Text>
        {label('disputes')}
        <Text color={roundsColour(a.dispute.rounds)}>
          {a.dispute.rounds > 0 ? `${a.dispute.rounds} round(s)` : 'never contested'}
        </Text>
      </Text>
      <Text>{label('lifecycle') + formatSteps(a.dispute.steps)}</Text>
      <Text>{label('phase') + a.dispute.phase}</Text>
      <Text>{label('volume') + money(a.pool)}</Text>
      {a.market.umaBond ? <Text>{label('bond') + `$${a.market.umaBond}`}</Text> : null}
      {a.dispute.deadline ? <Text>{label('ends') + until(a.dispute.deadline)}</Text> : null}

      {c ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {c.meaning === 'wiped'
              ? `${c.side} side lost — ${count(c.totalSize)} tokens went to zero`
              : `${c.side} side leads — market still open`}
          </Text>
          <Text>
            {label('  top holders') + `${meter(c.topShare)} ${pct(c.topShare)} `}
            <Text dimColor>
              {`(${c.topN} of ${c.holderCount} holders, ${count(c.topSize)} of ${count(c.totalSize)} tokens)`}
            </Text>
          </Text>
        </Box>
      ) : null}

      {a.market.resolutionSource ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>resolution source</Text>
          <Text>{'  ' + clip(a.market.resolutionSource, width - 2)}</Text>
        </Box>
      ) : null}

      {a.caveats.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>caveats</Text>
          {a.caveats.map((text) => (
            <Text key={text} dimColor>{'  · ' + clip(text, width - 4)}</Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>{'esc back   q quit'}</Text>
      </Box>
    </Box>
  );
}
