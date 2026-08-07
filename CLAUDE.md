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
    wallet.ts     one wallet's ledger, priced from the on-chain payout. pure
    rank.ts       sort order, filtering, viewport. pure
    watch.ts      what counts as a resolution moving. pure
    recall.ts     what moved since the last radar run. pure, reuses watch.ts
    queue.ts      lifecycles that never terminated, and how long. pure
    ledger.ts     the event log summarised. pure
    update.ts     version check. checks and prints, never installs
    assess.ts     assembles one answer from every source (does I/O)
    watcher.ts    one poll pass, and the loop (does I/O)
    store.ts      the watchlist, both snapshots, the event log, under ~/.recuse
    notify.ts     webhook delivery. the only outbound sink
  ui/
    theme.ts      five themes, colour depth detection, hex to escape
    format.ts     numbers, widths, NO_COLOR and non-TTY detection
    logo.ts       the wordmark, the face, and the launch banner
    loading.ts    the spinner, on stderr, silent when piped
    plain.ts      the plain renderer, and the fallback for pipes
    App.tsx       the ink radar
  cli.ts      arg parsing, command dispatch, --json on every path
tools/
  logo.mjs          regenerates assets/. run after changing the wordmark
  site.mjs          builds site/, flat HTML, no backend and no client JS
  housekeeping.mjs  the house rules, checked. run by CI
.github/workflows/
  ci.yml      build, test and check on node 20 and 22
  site.yml    nightly site build, publishes to Pages
```

`core/dispute.ts`, `core/capture.ts`, `core/safe.ts`, `core/watch.ts`, `core/recall.ts`, `core/queue.ts`, `core/ledger.ts`, `core/wallet.ts` and `core/rank.ts` are pure. Keep them that way. They hold every judgement the tool makes, which is why they carry most of the tests.

## Commands

```sh
npm test          # 277 tests, no network, sub-second
npm run build     # tsc, output to dist/
npm run dev       # tsc --watch
npm run check     # the house rules below, enforced
npm run site      # regenerate site/ from live data, needs a build first
node tools/logo.mjs   # regenerate assets/banner.svg and assets/mark.svg
```

CI runs `build`, `test` and `check` on Node 20 and 22 for every push and pull request. The site rebuilds nightly and publishes to Pages, and refuses to publish a snapshot with fewer than five pages, because a scan that returned nothing is a failed scan rather than an empty day.

## Testing policy

Test the arithmetic, not the rendering. A column width is not worth a test and a share calculation is. The exception is width arithmetic itself: `padEnd` counting UTF-16 units instead of code points shifts every column to its right, and that is a correctness bug wearing a cosmetic disguise.

Fixtures come from real markets. The dispute parser is pinned to lifecycles pulled from live Gamma, including the Zelenskyy market at five rounds and the MicroStrategy market at two. The subgraph tests are pinned to the top winning position on that same market. If a refactor breaks one of those, the code is wrong, not the test.

Before trusting a change to anything that touches an API, run it against live data. Four separate bugs here were invisible to unit tests and obvious the moment real data went through. They are in the log at the bottom of this file.

## Things that will bite you

**Gamma caps `limit` at 100** no matter what you pass, and defaults to open markets, so a settled market is invisible without `closed=true`. It also ignores query parameters it does not recognise and returns its default page rather than an error. Always verify the record matches what you asked for, with `matchesRequest`.

**Several Gamma fields arrive as JSON inside a string.** `outcomes` comes back as the literal text `["Yes", "No"]`. Use `parseEmbeddedJson`, which returns a fallback rather than throwing, so one malformed field costs a column instead of the run.

**Winners are invisible in balances.** They redeem and their balances go to zero. On the Zelenskyy market the winning side shows 907 tokens in `data-api` and 71,435,381 in the subgraph. Anything reasoning about "who won" from current holders is wrong. Use `sources/subgraph.ts`, and never add a balance to a cumulative buy.

**The subgraph needs a lower bound to answer at all.** `where market = X order by quantityBought desc` times out in the store without a `quantityBought_gt` floor, and intermittently even with one. `fetchTokenPositions` escalates the floor and reports which one worked. That floor is a fact about the reading, not a display preference, so it travels with the data.

**The subgraph reports `outcomeIndex` as null, and `Number(null)` is 0.** Reading which side a position was on from that field gives a complete table of confident wrong answers with everything on outcome 0. It reads like working code. The index comes from Gamma's `clobTokenIds`, which is index aligned with `outcomes`, and a token missing from that array is dropped rather than guessed at. See `core/wallet.ts`.

**A settled position pays `numerator / denominator`, not one dollar.** UMA resolves markets 50/50 sometimes, and treating that as a loss on both sides is wrong on both.

**Gamma accepts `condition_ids` repeated**, up to its page size, and returns every match. A wallet lookup is one request per hundred markets rather than one per market. Still verify each record against what was asked for.

**Free public Polygon RPCs cannot scan logs.** They cap `eth_getLogs` between 10 and 50 blocks and throttle further under load. This is why the chain layer is opt in. Do not try to work around it by scanning harder.

**Contested markets are almost never still open.** Zero of 30 in a 400 market scan. Code that assumes a live dispute will mostly be running against settled ones.

## Remote text is hostile

Every string from an API goes through `core/safe.ts` on the way in, in the source module, never at render time. Display names are chosen by the account holder and printed next to claims about that account, so a name carrying `\x1b[2J` could redraw the table above it and a name carrying `U+202E` could reverse how an address renders.

Sanitising at ingest rather than at render is deliberate: a render-time filter is one forgotten call site from a hole, and it would leave `--json` dirty while the table looked clean.

Errors are scrubbed too. `RECUSE_RPC_URL` usually holds an API key, and the natural next step after an error is pasting it into an issue.

## The watcher

`core/watch.ts` is pure and holds every judgement: first sight is a baseline and reports nothing, a lifecycle that changes other than by growing is `rewritten`, and a market that could not be read produces no event at all. That last one is the same rule as the oracle scan: not-read and nothing-happened are different statements.

State is written to a temporary file and renamed. A watcher runs for days and will eventually be killed mid-write, and a truncated `seen.json` silently re-baselines every market in it.

`events.jsonl` is append only and never rewritten. It is the artefact worth keeping, since the actor record compounds and nobody else is keeping one.

There is deliberately no `--exec` and nothing is spawned. SECURITY.md claims the tool touches no `child_process`, and `recuse watch --json` piped into a shell loop gives anyone the same power. Keeping the claim true is worth more than the flag.

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
npm run check
```

That is `tools/housekeeping.mjs`, and CI runs it too. It checks prose files for em dashes and emoji, source comments for em dashes, and the commit log for attribution trailers. It skips fenced code blocks deliberately: the renderers use `—` as a no-data glyph in a column, the README shows sample output containing it, and this file documents the check. A flat grep flags all three, and a check that cries wolf gets deleted.

## Handing off

`HANDOFF.md` is the first thing to read when picking this up and the last thing to touch before putting it down. Keep it to a page: what state it is in, what is next, and what would waste the next person's time. It is local and gitignored, so nothing in it has to be diplomatic. Update it at the end of every session, even a short one, and delete from it as freely as you add.

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
- The watcher enriched every event with a holder lookup, so a lifecycle that grew three steps made three identical requests. Memoise per market per pass.
- Gamma does not always append a `resolved` step when a market lands, so settlement has to be detected from prices as well as from the lifecycle.
- The subgraph's `outcomeIndex` is null everywhere, and `Number(null)` is 0. Any absent numeric coerced with `Number` becomes a real-looking answer. Check for null before coercing, always.
- `MarketPosition.market` is non-null in the schema and dangles on real records, so traversing it fails the whole query. The token id is the position id after character 42.
- The radar drew every row and overflowed any terminal shorter than the list. Anything that renders a list needs a viewport.
- The evidence tier was built from `Boolean(process.env.RECUSE_RPC_URL)` rather than from what answered, so setting the variable to anything printed `positions+chain` over an empty actor list. Derive a claim about evidence from the data you got back, never from configuration.
- That also meant `safeEndpoint` never ran, because it lived in a constructor nothing constructs. Second time here. A defence needs a test that fails when it stops being called, not just a call site.
- The radar and the watcher cannot share `seen.json`. A radar run would write baselines for markets the daemon never polled, and the daemon stays quiet on a market's first move once it has a baseline. Two readers, two files.
- A full address clipped to fit a narrow column reads like an identifier and cannot be checked. Abbreviate the whole column or none of it.
- Gamma serves `closedTime` as `2025-07-09 00:30:39+00`: a space instead of the T, and a two digit offset where ISO wants four. `new Date` returns Invalid Date, and an unparsed clock reads as "no deadline recorded" rather than as an error. Repair both defects or lose the field silently.
- The CLOB serves no price history for a settled market. Zero of six checked returned a point, at any interval or explicit timestamp range. Anything wanting price movement against the lifecycle is off the table, and settled markets are the only interesting ones.
