# Changelog

## Versioning

The number that matters is the shape of `--json`, not the look of the tables.

While this is `0.x`, both can change. From `1.0` the JSON shapes are the contract: fields get added in minor releases and only ever removed in a major one, because the tables are for reading and the JSON is what people build on. Table layout, colours and key bindings stay outside that promise at every version, since a terminal is allowed to be redecorated.

Dates are the day the work landed, not the day it was published.

## 0.8.1, 2026-08-11

**A valid record from the wrong request is not a partial answer.** The historical trade index now checks the wallet and token encoded in every position id, checks payout rows against the exact token set requested, and verifies that `netValue` is exactly `valueBought - valueSold`. The last identity was documented as the basis of the profit column but `valueSold` was not even in the query, so a plausible wrong net cost could pass every check. Gamma pages, holder groups, repeated holder assets and activity-name lookups now get the same request-scope treatment. A source that ignores a filter fails the reading instead of lending another wallet's data to the requested one.

Numeric and resource boundaries are explicit one layer earlier. Oversized Gamma quantities, holder amounts and cumulative holder sums are refused before they can poison concentration arithmetic. Embedded arrays, raw market pages and returned page sizes are bounded by what the caller asked to examine. A non-array HTTP 200 from the activity endpoint is a failed name lookup, not an unnamed wallet.

**One settlement could send two alerts.** If Gamma appended `resolved` and moved prices to their terminal values in the same poll, the watcher emitted both `resolved` and the synthetic `settled` fallback. The fallback now exists only for feeds that omitted the lifecycle step. The spinner also sent the literal characters `[2K` instead of a terminal erase sequence and accumulated exit listeners after stopping; both are fixed.

The interactive table now uses the same code-point-aware padding as the plain renderer, so an astral character in a market question cannot shift every column to its right. Invalid or enormous terminal dimensions fall back or cap before a render allocates a line. CLI diagnostics, site failures and additional invisible Unicode characters go through the same hostile-text boundary as API data. The site validates its public base URL, escapes sitemap locations and refuses to overwrite two markets whose remote slugs collapse to one filename.

The public tagline no longer claims this build identifies who decided a resolution. Proposer, disputer and voter identities are still unread, so the release says what it can prove: it rebuilds what settlement erased. `winners --limit` also rejects values above its 100-row source ceiling instead of accepting them and silently returning fewer rows.

**This is the first registry-shaped release.** Package metadata, the lockfile, CLI version, changelog and release examples are `0.8.1`; the README, generated site and update notice all use the npm install path. The package now carries its verified MCP name and `server.json` describes the fixed `serve --mcp` stdio invocation for the official registry. `v0.8.0` landed on `main` but was never tagged or published, so this release advances to `v0.8.1` rather than inventing a historical tag. The existing annotated `v0.7.0` remains untouched.

The release workflow builds and tests without npm credentials or OIDC write permission. It uploads one checksummed tarball, then separate least-privilege jobs attach that artifact to GitHub and, only after an explicit dispatch through the `npm` environment, publish the exact same tarball with provenance. The `recuse` name was still unclaimed during this verification, so the first publication still needs the maintainer's one-time npm authentication. After that, the workflow moves to short-lived trusted publishing and the bootstrap token is deleted.

The two runtime dependencies are pinned to the audited versions in this release. Dependabot can still propose each update as a reviewed change, while a new install no longer selects unreviewed runtime minors that were absent from the release checks.

## 0.8.0, 2026-08-11

**The last release found the hole. This one fills it.**

0.7.0 established that the trade index behind the winning side stops at 2026-01-05 and that 25 of 38 contested markets in a 600 market scan closed after it, and taught every surface to say so instead of printing an empty list. That was the right first move and it was still a tool that could not answer the question it exists to answer about anything recent.

Polymarket serves its own trade log, one record per fill, and it is current. `recuse` asks the index first, because where it reaches it counts back to a market's first trade with no floor and no ceiling. Where it does not reach, the log answers, and every reading says which of the two it stood on. On a market the index had covered, the log reproduced its winning side to within 0.2% on every wallet of the top six, in the same order.

`recuse regulars --scan 600` went from 20 markets scored to 34, and from 494 winning wallets to 751. Of the 25 contested markets past the old index head, the live log recovered 21 and left four explicitly unread.

Live-log winner reconstruction now removes wallets that sold out before applying the per-market row limit. Limiting first let a large historical buyer consume a slot even though it held nothing at settlement, which could hide a smaller wallet that actually carried the winning side. This is why the corrected live tally is higher than the first 0.8 reading.

Two properties of that log decide the shape of everything built on it, and both are stated in every reading rather than assumed away.

`takerOnly` defaults to true. The default view is one side of each fill: a market that returns 11,135 trades returns over 20,000 with it off, and the wallets in the first version were short by up to 40%. HTTP 200, a plausible history, half the volume gone, nothing anywhere saying so. It is set explicitly on every request and there is no option to unset it.

Paging stops at offset 10,000, so the reachable window is the 20,000 most recent fills, and 28 of those 38 markets have more. The way through is a minimum trade size in dollars, the same bargain the index already demanded in tokens: a market read whole above a floor beats the most recent slice of one. The floor that worked travels with the data and is printed under the table. Where even the top of the ladder is not enough, the reading says the history was cut and that its totals are partial rather than cumulative, which is a worse statement than a floor and is not allowed to share a sentence with one.

**`recuse wallet` returned nothing at all for a live wallet.** It read positions from the same index, so a wallet whose trading is all after January came back as `no positions found for this address`, with `"entries": []` over `--json` and a clean empty record over MCP. Measured on one holding 5,811,667 tokens across two contested markets it had lost. The live log is now the primary wallet source, because a nonempty old-index record can still omit every newer market. The conditions come from the trades themselves, since the index maps token to market only as far as its own head, and the old index remains an explicitly dated fallback when the current source refuses.

Payouts stop at that head too, silently, with `found: 0` and no error. Where the chain payout is unreadable the market's closing prices stand in, and only there. That fallback refuses an open market, refuses a price that does not land on a half, and refuses prices that do not divide a dollar between them, because pricing a live position off an opinion is the failure it would otherwise introduce.

**`exited` is a new result, beside won and lost.** The index was queried for surviving positions only, so a wallet that traded out before settlement never appeared. The log has no such filter and that wallet is ordinary. It was paid nothing on the outcome and calling it a winner would credit it with a market it was not in when the answer landed. Its trading profit stays in the total, because that money moved.

**Caveats wrap instead of being cut.** Every surface printed them clipped to the terminal, so the longest one in the tool, the one naming where the index stops and what was read instead, ended at "so t…" in eighty columns. A caveat exists to let a reader discount the number above it and one cut before its own verb cannot. Cutting is right for a table cell and wrong for a sentence.

Also: `recuse --version`, which every other CLI has and this one answered with `unknown option`. In plain mode it prints the number and nothing else, because the one thing it is for is being compared against something.

The production reconciliation verifies that every returned trade belongs to the requested market or wallet, meets the requested cash floor, stays within the requested page size and maps each token to one condition. Malformed rows are counted on every surface. A successful upstream response is not accepted as proof that its filters were honored, which is the same boundary that already protects Gamma lookups.

And a footer claiming 22 of 18 markets were rescued, because one counter was doing the work of two.

## 0.7.0, 2026-08-09

**Two thirds of the contested set was being reported as markets nobody won.** The subgraph that rebuilds the winning side is about seven months behind the chain. Its last indexed trade is 2026-01-05, and it answers a market it never reached with an empty list and HTTP 200, which is byte for byte how it answers a market nobody traded. `recuse winners` printed "no winning positions were returned for this market" over a $375M market with two dispute rounds, and `--json` handed a consumer `"winners": []`.

In a 600 market scan, 25 of 38 contested markets closed after that head. This is the failure this project exists to catch, arriving from the one direction nobody was watching: not a scan that swallowed its errors, but a source that had no errors to report.

The head is now read once per run, from an unfiltered sorted query that costs nothing, and any market closing after it is reported as not read. The table says so instead of the old line, `--json` omits the unread winner list and carries structured `tradeIndexCoverage`, and the MCP payload sets `winningSideRead: false`. A head that cannot be read produces no claim in either direction, because not knowing how far the index reaches is not the same as knowing it reaches this market.

Nothing about the losing side, the lifecycle, the queue or the watcher was affected. Those read Gamma and are current. It is only the trade-rebuilt half that stops in January, and now it says so.

**`recuse regulars`** is the cross-market question `winners` only answers one market at a time: who keeps ending up on the winning side of contested markets. It is the mirror of `players` and it could not have been a column on it, because the two count different things from different sources. Losers sit in balances and cost one holder lookup. Winners redeemed, their balances are zero, and each one has to be rebuilt from cumulative trades at a query per market.

The distribution is what makes it worth printing. Across 20 scored markets, 494 wallets won at least one, 117 won more than one, and the top wallet took 11. A count that varies like that is a finding; the 100% rate column deleted in 0.5.0 was not.

Every row carries the markets scored as its denominator, and the denominator is markets where a winning position was actually visible, not markets opened. A market the store refused, a market past the index and a market where nothing cleared the floor are three different things and are counted separately, because folding them together is what produced the bug above. Names are looked up for the visible rows only, and a row below that line renders as unread rather than as unnamed, which is the same distinction one more time.

`repeat_winners` is the matching MCP tool, with the win count and its denominator shipped as one string that cannot be split.

**Two date parsers became one.** `core/dispute.ts` and `core/queue.ts` each had a private one and only `queue` knew that `closedTime` arrives as `2025-07-09 00:30:39+00`, so which fields a module could read depended on which module was asking.

Smaller: `recuse winners` said `? side won` on every market past the trade index, reading the side off the trades it had not fetched rather than off the prices, which were sitting right there and are not in doubt.

**The production pass made failure states explicit.** Missing financial fields are no longer zero, invalid token entries no longer shift outcome indices, duplicate wallet rows are aggregated within a market, and a wallet holding both sides is counted independently of row order. Gamma, the holders API and the subgraph are checked for the response shapes and identifiers each request asked for. Trade-index coverage is checked even when a query returned rows, because a non-empty result can still be partial when a market traded across the stale head. Wallet records carry that same head and state that later trades are absent.

Corrupt state now stops instead of silently becoming an empty watchlist or a new baseline. Snapshot writes use exclusive random temporary files, flush before rename, repair permissions and write the event log before advancing the watcher checkpoint. CLI numbers, subcommands and event kinds are rejected when malformed rather than quietly defaulted. MCP now bounds messages, preserves split UTF-8 input, validates ids and parameter containers, redacts tool errors and never replies to notifications.

Node 22 is now the runtime floor. CI covers Node 22 and 24, installs with lifecycle scripts disabled, audits production dependencies, pins actions to commits and has Dependabot tracking both action and npm updates. TypeScript now rejects unused locals and parameters, and type-checks the test suite as well as product code, which makes the existing reachability check a compile-time rule for the smaller cases too.

## 0.6.1, 2026-08-09

**The installed binary did nothing at all.** `npm i -g github:xzycd/recuse` linked the bin, printed no warning, and then every command exited 0 with empty stdout. The guard at the foot of `cli.ts` asked whether the module URL ended with the basename of `process.argv[1]`. npm links `bin` as a symlink named `recuse`, node leaves `argv[1]` pointing at that symlink, and `import.meta.url` resolves to `dist/cli.js`, so the question being asked was whether `cli.js` ends with `recuse`. It does not.

Nothing caught it because every check here runs `node dist/cli.js`, where the two basenames match and the guard passes for the wrong reason. The last release was about an install that produced no binary. This one produced a binary that did nothing, which is the same sentence one layer down, and the lesson is the same both times: the install path has to be exercised the way a user gets it, not the way the repo runs it. Both sides now resolve to a real path, and the test lays down an actual symlink and spawns through it, because that is the only shape that ever failed.

**Three surfaces told people to run a command that 404s.** `recuse` is not on the npm registry, so `npx recuse` and `npm i -g recuse` are instructions that fail for anyone who copies them. The README was corrected for exactly this in 0.6.0 and says so in the file. The site generator kept printing `npx recuse` on every page it wrote, four separate times, and `recuse update` printed `npm i -g recuse` as the thing to run next. Prose gets reread and a generator does not, and the update notice is only visible on a day a newer version exists, which for an unpublished package is no day at all.

The install line lives in one constant now. `npm run check` fails on either form of the unpublished name, in a fenced block in the prose or in a non-comment line in a tool, and that rule is written to be deleted the day the name is published. It found the update notice on its first run, which is the whole argument for checking rather than remembering.

**Two columns printed identifiers nobody could check.** `recuse players` cut the raw address to its first twelve characters, which is the failure the winners table already refuses: an address clipped to fit reads like an identifier and cannot be compared against anything. It abbreviates like everywhere else now.

The name column beside it was worse, and it took live data to see. data-api serves an account's display name defaulted to its own address, and serves it already truncated, ellipsis included: 40 characters standing in for a 42 character address. So the name was neither equal to the address nor the length of one, every check for either missed it, and the widest column in the table filled up with fragments like `0x7Ee7B7fe80641bE006601Fce0D43D0CD0A551…` sitting next to the anchor they were a copy of. A display name that is a prefix of the row's own address is now dropped, because the account did not choose a name. One that is some other address is kept and shortened, since an account calling itself by an address that is not its own is worth seeing and is only worth seeing if it can be read.

**`recuse winners` showed two of its caveats and dropped the rest.** The filter kept the two beginning "winning side" and "more winning" and silently discarded the holder truncation, the count of names that could not be looked up, and the note that no oracle data was read. The comment directly above it already said every caveat and not a chosen subset, which was the version that was right: the caveats are assembled as data precisely so that no surface can quietly pick among them. On the Zelenskyy market this is the difference between a `100%` share carrying two caveats and carrying four.

**The log's dispute column read as a duration.** `recuse ledger` rendered rounds as `3d` where every other table in the tool renders `3×`, directly under a header measuring the log in days, and next to an unlabelled event count. Both columns have headings now and the glyph matches the rest of the tool.

Also: the site links from the repo, which it did not; `signed` carried a replace of `$` with `$`; and `tools/site.mjs` had a copy of the same entry point guard, which only ever worked because `npm run site` names the file it runs.

## 0.6.0, 2026-08-08

**Installing it from git produced nothing runnable, and said it had worked.** `npm i github:xzycd/recuse` reported "added 41 packages", installed three files, linked no binary and printed no warning. `dist/` is gitignored so a clone carries no build, and `prepublishOnly` is not a script npm runs on a git install, so nothing ever compiled. It builds through `prepare` now, which is the lifecycle script that does run on that path, and the installed `recuse` was checked end to end from a clean clone. This has the same shape as the bug the last release was about: a confident success message over nothing.

There is still no `npx recuse` and no `npm i -g recuse`, because the name is not on the registry. The README claimed both for five versions. It now says what actually works.

**About two hundred lines of the oracle layer were deleted.** `sources/chain.ts` held a `Chain` class, a windowed `eth_getLogs` scanner and a log classifier, and nothing could reach any of it: `Chain` was never constructed, so `scanLogs` and `actorsInRange` were never called, and `classifyOracleLog` was kept alive by its own tests. Every symbol in it had a caller inside the island and none had one outside. Unreachable code that looks finished is how the scheme check on `RECUSE_RPC_URL` sat unexecuted for weeks reading like a working defence. The decoded oracle address, adapter addresses and topic hashes stay as prose in the file header, since the research cost the time and the code did not.

`Assessment` lost `actors` and `conflicts`, which were hardcoded empty arrays. They were kept so the JSON shape would not change on the day the oracle reading landed. That is worth less than it costs: `"actors": []` tells a consumer the oracle was read and nobody was there, which is a confident zero over ground this build never covers, and a consumer parses fields rather than caveats. An absent field cannot be misread, and the version policy above allows adding one in any minor release. `isSafeText` went too, whose comment said it was used by the source guards and which was used by one test.

**`npm run check` now fails on any symbol the program cannot reach from `cli.ts`.** This repo has shipped unreachable code that read as working twice, and the lesson written down after the first time, grep for call sites and not for definitions, did not prevent the second, because remembering to grep is not a check.

Reference counting cannot catch it, which is the part worth knowing. The deleted chain layer was eight exports that called each other, so every one of them had references and looked used. Walking out from the entry point finds all eight and nothing else in the tree. The analysis lives in `tools/reachable.mjs`, apart from the script that runs it, so it can be tested against files built to be dead: running it over a clean repo proves nothing, which is the same failure mode it exists to catch. Strings are deliberately left unparsed, because dropping them was tried and immediately reported `BASE` in two source modules as dead, since `${BASE}/markets?${params}` collapses to one token, and a quote inside a regex character class swallowed the line after it. Both of those are a check crying wolf, which is how a check gets deleted.

**`recuse serve --mcp` answers over MCP**, one JSON-RPC message per line on stdin and stdout. No SDK and no new dependency: the transport is a line protocol, which is the same reason the chain layer spoke JSON-RPC by hand. Five read only tools: `contested_markets`, `market_record`, `winning_side`, `wallet_record` and `resolution_queue`. They call the same engine the commands call, so a tool result and a table cannot drift.

stdout is the transport, so `serve` draws no banner, starts no spinner and runs no update check. That was one line rather than an audit, because the spinner already writes to stderr and the banner already refuses to draw into a pipe.

The rest of the work there is about the consumer. Every other surface here is read by a person, who can see the denominator next to the share. This one is read by a model, which will summarise, and summarising is the operation that keeps `85%` and drops the `5 of 100` that made it checkable. So the guardrails are data rather than prose. Every payload carries `evidence`, `caveats` and `limits` as arrays of short declarative strings; a share ships as one string that cannot be split, `top 5 of 100 held 32.8%`, alongside its components; what was not covered is a field rather than a footnote, so `contested_markets` states how many scanned markets are missing from its own list and `winning_side` reports the token floor the subgraph needed before it would answer. Tests assert each of those, because trimming a payload for size is the change that would look harmless.

SECURITY.md gained the limit that surface introduces. `core/safe.ts` strips control characters and cannot strip a sentence, so a display name reading like an instruction survives ingest intact and lands in a model's context. It is stated rather than defended against, and the structural mitigation is that nothing in this tool acts on what it reads.

## 0.5.0, 2026-08-07

**The evidence tier was lying, and that is the important entry.** It was assembled from whether `RECUSE_RPC_URL` was set rather than from whether anything had been read, so exporting the variable to any value, `file:///etc/passwd` included, printed `positions+chain` over an empty actor list and no oracle request. Nothing in `sources/chain.ts` has ever been wired into an assessment. The tier is now built only from sources that answered, the `+chain` variants are gone from the type until there is something to put in them, and the footer says the oracle is unread instead of implying that configuration bought something.

That also means the scheme check on `RECUSE_RPC_URL` never ran. It lived in a constructor nothing constructs. It now runs on every reading and has tests that fail if it stops. Second time an unwired defence has read like a working one here.

`recuse winners` puts names to the winning side. Those wallets redeemed and left the holder list, so the names are joined from the data API's activity records, which is the only place a redeemed wallet is still named. A name never replaces its address: display names are chosen by the account, nothing stops one calling itself another account's address, and every finding here is anchored to an address.

The radar says what moved since you last looked. It keeps its own snapshot in `radar.json`, deliberately not the watcher's `seen.json`, because sharing one file would let a plain `recuse` run write baselines for markets the daemon never polled and silence its first real alert on each of them. First run reports nothing and says how many it recorded, the same rule the watcher runs on. Counts travel with their denominator: `1 rewritten, 1 moved of 6 compared`. Rows carry `+` for moved and `!` for a history that was rewritten, as characters rather than colour, because inside the table colour still means dispute rounds and nothing else.

`data-api`'s `outcomeIndex` was read through a coercion with a `0` fallback, which would have put every holder on outcome 0 the day the field went missing. It is present on every live record today, so this was latent. It is now dropped rather than defaulted, and `numOrUndefined` exists so the next absent field has an obvious way to be read.

Removed `fetchHoldersForMarkets`, which nothing called.

`recuse queue` is new: the markets whose resolution record never reached a terminal step, longest wait first. Across 400 markets, 37 were pending, 108 had finished and 255 never reached the oracle at all, and all three counts stay on screen because a list of 37 means nothing without them. It does not claim a market is stuck. A record that stops short is either a slow oracle or a feed that never appended the last step, those are indistinguishable from here, and the footer says so.

`recuse ledger` summarises the event log: how many events over what span, what kinds, which markets moved most often, and which were last seen unfinished. This is the one artefact here that cannot be recomputed from a public endpoint, and a log nobody can look at is a log nobody leaves running. It does not tally addresses, because the event record does not carry holder identities and a ledger that looked like it did would be inventing a source.

`recuse market <id> --card` prints a block sized for pasting into a chat. No colour, no box drawing, every share still carrying its denominator, because the reason to paste one is to settle an argument and a number nobody can check settles nothing.

The detail pane and the card now show what the winning side paid and redeemed. Every held token on the winning side redeems for exactly one dollar, so the net is the difference between two sums rather than a model.

`closedTime` arrives from Gamma as `2025-07-09 00:30:39+00`, which is not ISO on two counts, and `new Date` was returning Invalid Date. A market whose only clock was that field lost it silently and sorted to the bottom as undated. Caught by a test, not by looking.

There is no `recuse replay`. The CLOB serves no price history for settled markets, zero of six checked at any interval, so showing price movement against the dispute lifecycle is not possible for the only markets worth showing it for.

`npm run site` builds a flat HTML snapshot into `site/`: one page per contested market, permanent URLs, no backend, no database, no client JavaScript and no external requests. It imports the compiled engine rather than shelling out, so a page cannot drift from what the CLI prints. Every rule survives the port: shares carry denominators, the hidden count is on the index, the evidence tier is in every footer.

The site needed its own escaping. `core/safe.ts` strips what a terminal acts on, and a browser acts on a different set, so `<` is inert on one and markup on the other. Neither pass replaces the other.

CI builds and tests on Node 20 and 22 for every push and pull request. The site rebuilds nightly and refuses to publish a snapshot with fewer than five pages, because a scan that returned nothing is a failed scan rather than an empty day.

`npm run check` is the house rules, enforced instead of remembered: em dashes and emoji in prose, em dashes in source comments, attribution trailers in the log. It skips fenced blocks and inline code, and it failed on its own source the first time CI ran it, which is the right way round.

`recuse wallet` shows the account's display name beside its address. `readEventLog` caps at 64MB and reads the tail past that, saying it did.

## 0.4.0, 2026-08-07

Added `recuse wallet <address>`. One wallet's whole record, disputed markets first, priced from the on-chain payout rather than from prices. It reads positions from trades, so wallets that redeemed and vanished from every balance-based tracker still show up. Measured on one address: 38 resolved markets, 11 of them disputed, `+$859K` net.

The subgraph's `MarketData.outcomeIndex` is null on every record checked, and `Number(null)` is `0`, so reading which side a position was on from it reports every position as outcome 0. That produces a complete table of confident wrong answers. The index now comes from Gamma's `clobTokenIds`, and a token that is not in that array is dropped rather than guessed at.

Split resolutions are counted properly. UMA does hand down 50/50 outcomes, and reporting one as a loss on both sides is wrong on both.

The radar is now navigable rather than just printable:

- `/` filters as you type, `s` cycles the sort, `t` cycles the theme live, `?` lists the keys.
- The list scrolls. It previously drew every row and overflowed any terminal shorter than the row count.
- The selected row gets a gutter bar instead of a full inverse line, which was burying the one coloured signal underneath it.
- Sorting and filtering moved into `core/rank.ts`, pure and tested, because a sort order is a claim about what matters.

New logo. X eyes, because that is what the tool measures.

Gamma accepts `condition_ids` repeated, so a wallet lookup is one request per hundred markets instead of one per market.

## 0.3.0, 2026-08-07

Added `recuse watch`, `recuse events`, and the watchlist under `~/.recuse`.

The first pass reports nothing, because there is no baseline to compare against and firing on everything the first time it runs is how a tool teaches you to ignore it. A market that could not be read produces no event and is counted separately. A lifecycle that changes in any way other than growing at the end is reported as `rewritten` rather than quietly absorbed.

Settlement is detected from prices as well as from the lifecycle, because Gamma does not always append a `resolved` step when a market lands.

`--webhook` posts each event as JSON. There is no `--exec` and nothing is spawned.

## 0.2.0, 2026-08-06

Added `recuse winners`, which rebuilds the winning side of a settled market from cumulative trades. Balances cannot see it: winners redeem and their balances go to zero. On the Zelenskyy market the winning side reads as 907 tokens in balances and 71,435,381 in trades.

`netValue` is exactly `valueBought - valueSold`, so profit on a settled position is arithmetic rather than an estimate.

Five themes, a launch banner, and a spinner that says what the scan is doing.

Security pass. Every remote string is filtered for terminal escapes at ingest, response bodies are capped, errors are redacted because `RECUSE_RPC_URL` carries an API key, and the RPC endpoint must be http or https.

## 0.1.0, 2026-08-06

First cut. The radar, `recuse market`, `recuse players`, and `--json` on every path.

Concentration is measured on the losing side, because winners redeem and leave the book. That was found by running against live data and is the reason the tool has the shape it has.
