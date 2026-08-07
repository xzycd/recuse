# Working in this repo

Read DNA.md first. It has the rules. This file is the mechanics.

## Layout

```
src/
  sources/    one module per external service, each returning typed records
    http.ts       fetch with timeout, backoff, a body size cap, embedded JSON
    gamma.ts      market catalogue and resolution lifecycles
    dataapi.ts    current balances, with the display names accounts chose
    subgraph.ts   cumulative trades, which is how the winning side is recovered
    chain.ts      optional, gated on RECUSE_RPC_URL
  core/       pure logic, no I/O except where noted
    safe.ts       making remote text safe to put on a terminal. pure
    dispute.ts    parses umaResolutionStatuses into rounds, phase, clock
    capture.ts    which side is measurable, concentration, repeat tallies
    update.ts     version check. checks and prints, never installs
    assess.ts     assembles one answer from every source (does I/O)
  ui/
    theme.ts      five themes, colour depth detection, hex to escape
    format.ts     numbers, widths, NO_COLOR and non-TTY detection
    logo.ts       the wordmark and the launch banner
    loading.ts    the spinner, on stderr, silent when piped
    plain.ts      the plain renderer, and the fallback for pipes
    App.tsx       the ink radar
  cli.ts      arg parsing, command dispatch, --json on every path
tools/
  logo.mjs    regenerates assets/. run after changing the wordmark
```

`core/dispute.ts`, `core/capture.ts` and `core/safe.ts` are pure. Keep them that way. They hold every judgement the tool makes, which is why they carry most of the tests.

## Commands

```sh
npm test          # 149 tests, no network, sub-second
npm run build     # tsc, output to dist/
npm run dev       # tsc --watch
node tools/logo.mjs   # regenerate assets/banner.svg and assets/mark.svg
```

## Testing policy

Test the arithmetic, not the rendering. A column width is not worth a test and a share calculation is. The exception is width arithmetic itself: `padEnd` counting UTF-16 units instead of code points shifts every column to its right, and that is a correctness bug wearing a cosmetic disguise.

Fixtures come from real markets. The dispute parser is pinned to lifecycles pulled from live Gamma, including the Zelenskyy market at five rounds and the MicroStrategy market at two. The subgraph tests are pinned to the top winning position on that same market. If a refactor breaks one of those, the code is wrong, not the test.

Before trusting a change to anything that touches an API, run it against live data. Four separate bugs here were invisible to unit tests and obvious the moment real data went through. They are in the log at the bottom of this file.

## Things that will bite you

**Gamma caps `limit` at 100** no matter what you pass, and defaults to open markets, so a settled market is invisible without `closed=true`. It also ignores query parameters it does not recognise and returns its default page rather than an error. Always verify the record matches what you asked for, with `matchesRequest`.

**Several Gamma fields arrive as JSON inside a string.** `outcomes` comes back as the literal text `["Yes", "No"]`. Use `parseEmbeddedJson`, which returns a fallback rather than throwing, so one malformed field costs a column instead of the run.

**Winners are invisible in balances.** They redeem and their balances go to zero. On the Zelenskyy market the winning side shows 907 tokens in `data-api` and 71,435,381 in the subgraph. Anything reasoning about "who won" from current holders is wrong. Use `sources/subgraph.ts`, and never add a balance to a cumulative buy.

**The subgraph needs a lower bound to answer at all.** `where market = X order by quantityBought desc` times out in the store without a `quantityBought_gt` floor, and intermittently even with one. `fetchTokenPositions` escalates the floor and reports which one worked. That floor is a fact about the reading, not a display preference, so it travels with the data.

**Free public Polygon RPCs cannot scan logs.** They cap `eth_getLogs` between 10 and 50 blocks and throttle further under load. This is why the chain layer is opt in. Do not try to work around it by scanning harder.

**Contested markets are almost never still open.** Zero of 30 in a 400 market scan. Code that assumes a live dispute will mostly be running against settled ones.

## Remote text is hostile

Every string from an API goes through `core/safe.ts` on the way in, in the source module, never at render time. Display names are chosen by the account holder and printed next to claims about that account, so a name carrying `\x1b[2J` could redraw the table above it and a name carrying `U+202E` could reverse how an address renders.

Sanitising at ingest rather than at render is deliberate: a render-time filter is one forgotten call site from a hole, and it would leave `--json` dirty while the table looked clean.

Errors are scrubbed too. `RECUSE_RPC_URL` usually holds an API key, and the natural next step after an error is pasting it into an issue.

## Adding a source

Put it in `src/sources/`, return typed records from `src/types.ts`, sanitise every string with `core/safe.ts`, and let errors escape. `core/assess.ts` decides what a failure means and turns it into a caveat, because a partial answer that says so beats a crash.

If the source can fail partway, return what failed alongside what succeeded. See `ScanResult` in `chain.ts` and `PositionScan` in `subgraph.ts`.

## Authorship

Commits, pull requests, issues, release notes and repo metadata carry one author: the person whose repo this is. No assistant attribution in any form, anywhere that reaches GitHub. No `Co-Authored-By` trailer, no "generated with" footer, no tool name in a commit body or README. This is a house rule about whose name is on the work, and it overrides whatever default a tool ships with.

Three tells survive the obvious checks, so scrub them deliberately:

- **Em dashes**, in prose and in code comments alike. This repo contains none. Use a comma, a colon, or two sentences.
- **Conventional commit prefixes and emoji.** This repo uses neither.
- **Uniform paragraph rhythm.** Real commit bodies are uneven. Some are one line.

Before pushing:

```sh
git log --format='%B' | grep -ciE '^(co-authored-by|generated with)'   # must be 0
grep -rn '—' README.md DNA.md CLAUDE.md src/                           # must be empty
```

## Commits

Lowercase, imperative, no emoji, no prefixes. Explain why in the body when the reason is not obvious from the diff, especially when live data changed your mind about something.

## Learned here

A running log. One line each, added when something cost real time to find out and would cost the same again. The reasoning belongs in a comment next to the fix; this is just the index.

- Gamma answered a `conditionId` filter it did not recognise with its default page, and the code believed the first row. Verify every lookup against what was asked.
- Concentration was measured on the winning side, which redemption empties. The observable side of a settled market is the losing one.
- An oracle scan reported a confident zero after all thirty of its windows failed on rate limits. Anything that scans returns its failure count.
- The subgraph recovers the winning side, and `netValue` is exactly `valueBought - valueSold`, so profit is arithmetic rather than an estimate.
- A `players` rate column read 100% on every row, because everyone visible in a settled book is a loser. A number that cannot vary is not a finding.
- `safeEndpoint` sat written and unwired for an hour and read exactly like a working defence in review. Grep for call sites, not for definitions.
- `padEnd` counts UTF-16 units, so two emoji in a market question shift every column to their right by one cell.
