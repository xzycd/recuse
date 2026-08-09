# Changelog

## Versioning

The number that matters is the shape of `--json`, not the look of the tables.

While this is `0.x`, both can change. From `1.0` the JSON shapes are the contract: fields get added in minor releases and only ever removed in a major one, because the tables are for reading and the JSON is what people build on. Table layout, colours and key bindings stay outside that promise at every version, since a terminal is allowed to be redecorated.

Dates are the day the work landed, not the day it was published.

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
