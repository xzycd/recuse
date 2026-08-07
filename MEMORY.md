# Memory

Decisions and their reasons, so the next session does not relitigate them. Newest at the bottom.

## Why this and not funding-rate arbitrage

Three ideas were tested against live data and dropped before this one.

A cross-venue funding-rate carry scanner is well covered by Coinglass and a dozen free tools. It also fails on its own terms: of the top ten spreads by size, six sat on markets with under $1M open interest and five had literally zero.

Cross-venue prediction-market arbitrage has at least three shipped competitors. Pricing 25 liquid multi-outcome Polymarket sets against real orderbooks turned up exactly one genuine risk-free arb, worth about two dollars.

Liquidity-reward optimisation is covered by opt.markets plus three open-source market-making bots.

The pattern is that every "find the mispricing" idea is crowded, because that is where everyone looks. This one prices who decides rather than what things cost.

## Dispute data is richer than expected

In the top 100 closed markets by volume, 74 carry a UMA lifecycle and 19 went through at least one dispute round. The "Will Zelenskyy wear a suit before July?" market went five rounds on $242M of volume. MicroStrategy sells Bitcoin went two on $375M.

Gamma exposes this as `umaResolutionStatuses`, an ordered array like `["proposed","disputed","proposed","resolved"]`. No chain access needed for the lifecycle itself.

## Gamma answers questions you did not ask

Asking for a market with an unsupported filter name returns twenty unrelated markets and a 200. The first one looks like a perfectly good answer. This cost an hour and is now the reason `matchesRequest` exists and every lookup is verified.

The correct parameter is `condition_ids`, and it needs `closed=true` for settled markets since Gamma defaults to open ones.

## Winners redeem, losers do not

The important correctness finding. Concentration was originally measured on the winning side of a contested market, which is wrong: settled winners redeem their tokens for a dollar and their balances go to zero, while losers keep worthless tokens forever.

Measured on the Zelenskyy market, the winning side had 907 tokens left against the losing side's 52,137,899. The original 86% concentration figure was computed over those 907 stragglers.

So the tool measures the losing side and labels it, and `players` counts losses rather than wins. Recovering winner-side positions would need the Goldsky subgraph's `marketPosition` entity, which records holdings over time. That is the obvious next step and is not built.

## Contested markets are corpses

Zero of 30 contested markets in a 400-market scan were still unsettled. Disputes resolve. Any feature premised on watching a live dispute will mostly be looking at finished ones, and a live-alerting product would need to poll for new disputes rather than enumerate existing ones.

## The chain layer had to become opt in

Polymarket migrated off UMA's Optimistic Oracle V2 to the Managed Optimistic Oracle after UMIP-189, which also restricted proposals to a whitelist. The live oracle is `0x2c0367a9db231ddebd88a94b4f6461a6e47c58b1`, found by reading a market-creation transaction receipt rather than from documentation, which lists three adapters that are all dormant. The live adapters are `0x65070be9...` and `0x69c47de9...`.

Reading proposer and disputer identities needs `eth_getLogs` over a range. All three free public Polygon endpoints refuse: publicnode serves 1000 blocks and drops to 10 under load, drpc rejects ranges it says it supports, 1rpc caps at 50. At 50 blocks a window, a day of Polygon is 860 requests.

So the layer is gated on `RECUSE_RPC_URL` and its absence is announced in the footer on every run. Decoded constants are in `src/sources/chain.ts` so the work does not need repeating.

## An early scan lied

The oracle scan swallowed RPC errors with `if (j.result)` and reported "0 disputes over 30,000 blocks" after all thirty windows failed. Given what this tool is for, that was a useful thing to do to oneself. Everything that scans now returns its failure count and callers surface it.

## The subgraph recovers the winners, with a condition

The next step from the redemption note above is built. Goldsky's
`polymarket-orderbook-resync` subgraph has a `marketPosition` entity keyed by
outcome token, and `quantityBought` is cumulative. Redemption does not touch it.

On the Zelenskyy market the winning side shows 907 tokens in current balances and
71,435,381 in cumulative buys across the top 20. The largest winner bought 7.1
million tokens and is absent from the holder list entirely.

`netValue` is exactly `valueBought - valueSold`, verified against the raw fields on
six live positions. So for a settled market the profit is `netQuantity - netValue`,
because every held token on the winning side redeems for one dollar. That is
arithmetic, not an estimate, which is why the gain column is allowed to exist.

The condition: the store cannot serve `where market = X order by quantityBought
desc` without a `quantityBought_gt` floor, and times out intermittently even with
one. `fetchTokenPositions` walks a floor ladder of 1000, 10000, 100000 tokens and
reports which rung answered. The floor is a fact about the reading, so it travels
with the data and appears as a caveat.

The two numbers are never summed. A balance is a position now and a cumulative buy
is everything ever bought. `Concentration.basis` records which one produced a
figure, on every surface including JSON.

## Display names are an attack surface

Not theoretical. Polymarket display names are chosen by the account holder, and the
tool prints them next to claims about that account. A name containing `\x1b[2J` can
clear the screen and let the wallet forge every row above it. `U+202E` reverses how
an address renders, which matters more than usual here because every finding is
anchored to an address.

`core/safe.ts` filters on ingest in the source modules, never at render time. A
render-time filter is one forgotten call site from a hole and would leave `--json`
dirty while the table looked clean. It denies by code point rather than matching
escape-sequence grammar, because grammars keep growing and the control set does not.

Same pass: responses are capped at 32MB, errors are redacted before printing because
`RECUSE_RPC_URL` carries an API key, and the RPC URL is checked for an http scheme
so `file:` cannot turn a config value into a file read.

Worth remembering from that pass: `safeEndpoint` sat written and completely unwired
for an hour, and read exactly like a working defence. Grep for call sites, not for
definitions.

## Themes did not break the colour rule

Five themes, and inside the data table colour still carries exactly one signal, the
dispute round count. Themes recolour that ramp and the chrome around it. Chrome is
the banner, spinner, rules and headings, where nothing is being read off the colour.

The banner and spinner are both suppressed outside a real terminal. The spinner is
on stderr specifically so `recuse --json | jq` stays clean.
