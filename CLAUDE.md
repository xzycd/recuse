# Working in this repo

Read DNA.md first. It has the rules. This file is the mechanics.

## Layout

```
src/
  sources/    one module per external service, each returning typed records
    http.ts       fetch with timeout, backoff, a body size cap, embedded JSON
    gamma.ts      market catalogue and resolution lifecycles
    dataapi.ts    current balances, with the display names accounts chose
    subgraph.ts   cumulative trades, which is how the winning side is recovered,
                  and the index head, which is how far back that recovery works
    trades.ts     the trade log, which is current and answers past that head
    chain.ts      the oracle layer, unbuilt. reports that it read nothing,
                  and validates RECUSE_RPC_URL on every reading
  core/       pure logic, no I/O except where noted
    safe.ts       making remote text safe to put on a terminal. pure
    dispute.ts    parses umaResolutionStatuses into rounds, phase, clock
    capture.ts    which side is measurable, concentration, repeat tallies
    rebuild.ts    cumulative positions summed out of fills. pure
    wallet.ts     one wallet's ledger, priced from the on-chain payout. pure
    rank.ts       sort order, filtering, viewport. pure
    watch.ts      what counts as a resolution moving. pure
    recall.ts     what moved since the last radar run. pure, reuses watch.ts
    queue.ts      lifecycles that never terminated, and how long. pure
    ledger.ts     the event log summarised. pure
    mcp.ts        the MCP protocol, pure. the engine is injected
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
  prepare.mjs       builds on install, so a git install produces a binary
  reachable.mjs     which symbols the entry point can get to. pure, tested
  housekeeping.mjs  the house rules, checked. run by CI
.github/workflows/
  ci.yml      build, test and check on node 20 and 22
  site.yml    nightly site build, publishes to Pages
```

`core/dispute.ts`, `core/capture.ts`, `core/safe.ts`, `core/watch.ts`, `core/recall.ts`, `core/queue.ts`, `core/ledger.ts`, `core/wallet.ts`, `core/rebuild.ts`, `core/mcp.ts` and `core/rank.ts` are pure. Keep them that way. They hold every judgement the tool makes, which is why they carry most of the tests.

## Commands

```sh
npm test          # 364 tests, no network, sub-second
npm run build     # tsc, output to dist/
npm run dev       # tsc --watch
npm run check     # the house rules below, enforced
npm run site      # regenerate site/ from live data, needs a build first
node tools/logo.mjs   # regenerate assets/banner.svg and assets/mark.svg
recuse serve --mcp    # answer over MCP on stdin and stdout
recuse regulars       # wallets that won more than one contested market
```

CI runs `build`, `test` and `check` on Node 20 and 22 for every push and pull request. The site rebuilds nightly and publishes to Pages, and refuses to publish a snapshot with fewer than five pages, because a scan that returned nothing is a failed scan rather than an empty day.

## Testing policy

Test the arithmetic, not the rendering. A column width is not worth a test and a share calculation is. The exception is width arithmetic itself: `padEnd` counting UTF-16 units instead of code points shifts every column to its right, and that is a correctness bug wearing a cosmetic disguise.

Fixtures come from real markets. The dispute parser is pinned to lifecycles pulled from live Gamma, including the Zelenskyy market at five rounds and the MicroStrategy market at two. The subgraph tests are pinned to the top winning position on that same market. If a refactor breaks one of those, the code is wrong, not the test.

Before trusting a change to anything that touches an API, run it against live data. Four separate bugs here were invisible to unit tests and obvious the moment real data went through. They are in the log at the bottom of this file.

## Things that will bite you

**Gamma caps `limit` at 100** no matter what you pass, and defaults to open markets, so a settled market is invisible without `closed=true`. It also ignores query parameters it does not recognise and returns its default page rather than an error. Always verify the record matches what you asked for, with `matchesRequest`.

**Several Gamma fields arrive as JSON inside a string.** `outcomes` comes back as the literal text `["Yes", "No"]`. Use `parseEmbeddedJson`, which returns a fallback rather than throwing, so one malformed field costs a column instead of the run.

**The trade log defaults to half the fills.** `data-api.polymarket.com/trades` takes `takerOnly`, and it defaults to true. One market returns 11,135 trades on the default and over 20,000 with it off, and wallet totals built on the default were short by up to 40%. HTTP 200, a plausible history, nothing saying so. `sources/trades.ts` sets it explicitly on every request and offers no way to unset it.

**That log pages to 20,000 records and no further.** Offsets past 10,000 come back as `max historical trades offset of 10000 exceeded`, in a JSON object, with HTTP 200. A reader that treats a non-list body as the end of the data silently shortens every busy market. Use `filterType=CASH` with a dollar floor to read a market whole rather than reading the most recent slice of one, and report the floor.

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

That is `tools/housekeeping.mjs`, and CI runs it too. It checks prose files for em dashes and emoji, source comments for em dashes, the commit log for attribution trailers, and every symbol in `src/` for whether the program can reach it. It skips fenced code blocks deliberately: the renderers use `—` as a no-data glyph in a column, the README shows sample output containing it, and this file documents the check. A flat grep flags all three, and a check that cries wolf gets deleted.

## Nothing unreachable

`npm run check` fails if a symbol in `src/` cannot be reached from `src/cli.ts`. Finish it, wire it up, or delete it. Git keeps whatever you delete.

This rule is here because the alternative was tried twice. `safeEndpoint` lived in a constructor nothing constructed and read as a working defence for weeks. The evidence tier claimed oracle data from a file nothing had wired in. The note written after the first one, grep for call sites and not for definitions, did not prevent the second, because remembering to grep is not a check.

Two things about the implementation matter if you touch it:

**It walks rather than counts.** The deleted chain layer was eight exports that called each other, and three of them had passing tests, so every symbol in it had references and looked used. Reference counting cannot tell a live call graph from an island.

**Tests are not callers.** A symbol only a test can reach is a symbol the program cannot, so test files are not roots and are not scanned. That is deliberate and is the case worth reporting rather than the case to excuse.

The analysis is in `tools/reachable.mjs`, separate from the script that runs it, so it is tested against files built to be dead. Running it over a clean repo proves nothing, which is the same failure mode it exists to catch.

## The MCP surface

`recuse serve --mcp` is JSON-RPC over stdin and stdout, one message per line. No SDK, no dependency.

**stdout is the transport.** Anything that prints corrupts the session. `runServe` calls no banner, no spinner and no update check, and nothing outside `cli.ts` writes to stdout, which is what makes that a one line rule instead of an audit. Keep it that way.

**The consumer is a summariser.** Every other surface here is read by a person who can see the denominator next to the share. A model will keep `85%` and drop the `5 of 100` that made it checkable. So the guardrails are data: `evidence`, `caveats` and `limits` on every payload, a share that ships as one unsplittable string, and what was not covered as a field rather than a footnote. `src/core/mcp.test.ts` asserts all of it, because trimming a payload for size is the change that would look harmless.

**`core/safe.ts` cannot help here.** It strips control characters, not sentences. A display name reading like an instruction reaches a model's context intact. That is stated in SECURITY.md rather than defended against, and the reason it is survivable is that nothing in this tool acts on what it reads.

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
- `prepublishOnly` does not run when npm installs from a git URL. `prepare` does. With `dist/` gitignored, that difference meant `npm i github:...` installed three files, linked no binary, and printed "added 41 packages".
- A reference count cannot find dead code that references itself. Eight exports calling each other, three with tests, all unreachable. Walk from the entry point instead.
- Parsing strings out of source before analysing it is a trap. Dropping string bodies turned `${BASE}/markets?${params}` into one token and reported `BASE` as dead in two modules, and a `'` inside a regex character class swallowed the line after it. Strip comments only, and accept missing the dead symbol whose name appears in a string.
- An empty array in a JSON payload is a claim. `"actors": []` says the oracle was read and nobody was there. Absent says nothing, which was the truth.
- The entry point guard compared basenames, so the installed `recuse` symlink failed it and every command printed nothing and exited 0. `node dist/cli.js` passes it for the wrong reason, which is why nothing here caught it. Run the binary the way a user gets it.
- data-api serves a display name defaulted to the account's own address, and serves it pre-truncated with an ellipsis at 40 characters. It is neither equal to the address nor the length of one, so both obvious checks miss it.
- A claim in a generator outlives the same claim in prose. The README stopped saying `npx recuse` a release before the site did, because prose gets reread and a template does not. Check the generated surface, not the document about it.
- The orderbook subgraph is roughly seven months behind the chain, and it answers a market it never indexed with `[]` and HTTP 200, identically to a market nobody traded. Two thirds of contested markets were being reported as markets nobody won. Read the head with `fetchIndexHead` and compare it to the market's close before believing an empty position list. A source with no errors to report is not a source that covered the ground.
- `enrichedOrderFilleds`, `redemptions` and `marketProfits` all exist in that subgraph and all time out with any `where` clause on market or condition, floors included. Unfiltered and sorted on an indexed column is the one shape that answers, which is exactly enough to read the index head and nothing more. Timestamped trades are off the table for the same reason price history was.
- `umaResolutionStatuses` is bare strings with no per-step outcome, so what was proposed in each round, and whether a dispute changed the answer, is not recoverable from Gamma.
- The winning side has a second source and it is current. `data-api` serves a trade log, one record per fill, filterable by market or by wallet. Above a cash floor it reproduced the subgraph's top six wallets within 0.2%, in the same order, on a market the subgraph had indexed. The subgraph stays first where it reaches, because it needs no floor and counts back to the first trade.
- `takerOnly` on that endpoint defaults to true, which is one side of each fill and looks exactly like the whole market. That default cost 40% of some wallet totals and nothing in the response mentioned it. Read the parameter list of any endpoint before trusting its shape.
- The chain payout stops at the same head the trades do. `fetchTokenPayouts` on a token from this year returns `found: 0` with no error, so a ledger built on it prices every recent position at nothing. Gamma's closing prices stand in, and only where the chain answered with nothing.
- A position the wallet had traded out of before settlement was neither won nor lost. It could not arise while positions came from the index, which was asked for survivors only, and it is ordinary in the log. `exited` counts it, and its trading profit stays in the total.
- `Number(null)` is 0, and a range check catches that only where zero is illegal. Size and timestamp were safe; price was not, because a losing side really does trade at zero. Check for the absence itself, not for a value the absence happens to produce.
- Caveats were clipped to the terminal width like table cells. The longest one ended at "so t…" in eighty columns. A sentence wraps and a cell truncates, and a caveat nobody can read is a caveat that is not there.
