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
