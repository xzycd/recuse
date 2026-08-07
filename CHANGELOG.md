# Changelog

## Versioning

The number that matters is the shape of `--json`, not the look of the tables.

While this is `0.x`, both can change. From `1.0` the JSON shapes are the contract: fields get added in minor releases and only ever removed in a major one, because the tables are for reading and the JSON is what people build on. Table layout, colours and key bindings stay outside that promise at every version, since a terminal is allowed to be redecorated.

Dates are the day the work landed, not the day it was published.

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
