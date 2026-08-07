# Changelog

## Versioning

The number that matters is the shape of `--json`, not the look of the tables.

While this is `0.x`, both can change. From `1.0` the JSON shapes are the contract: fields get added in minor releases and only ever removed in a major one, because the tables are for reading and the JSON is what people build on. Table layout, colours and key bindings stay outside that promise at every version, since a terminal is allowed to be redecorated.

Dates are the day the work landed, not the day it was published.

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
