<img src="assets/banner.svg" alt="recuse" width="100%">

Polymarket markets do not settle on facts. They settle on a vote. Someone proposes an outcome with a $500 bond, anyone can bond against it, and contested markets go to UMA token holders. `recuse` reads that record: which markets were fought over, how many rounds it took, who was left holding the losing side, and who quietly bought the winning one.

Point it at a market and it tells you what happened to the resolution. Run it bare and it ranks every contested market it can find, most contested first. Everything it prints, it will also emit as JSON.

```
recuse · 30 contested of 400 scanned · showing 8
────────────────────────────────────────────────────────────────────────────────
MARKET                                       RDS    WIPED     TOP 5 HELD    POOL
Will Zelenskyy wear a suit before July?       5×    52.1M  ●○○ 33% 5/100  $242.2M
US x Iran ceasefire extended by April 22?     3×   108.6M  ●●● 85% 5/100  $203.6M
MicroStrategy sells any Bitcoin by May 31?    2×    96.6M  ●○○ 39% 5/100  $375.8M
US forces enter Iran by April 30?             2×    41.4M  ●●○ 45% 5/100  $269.0M
────────────────────────────────────────────────────────────────────────────────
370 markets hidden, never contested. --all to include them.
```

The suit market went five rounds. 52.1 million tokens went to zero when it finally landed.

## Install

```sh
npm i -g github:xzycd/recuse
```

Node 22 or newer. No API keys, no account, no config file.

Not on the npm registry yet, so there is no `npx recuse` and there is no
`npm i -g recuse`. Both were in this file before they were true, which is a
small version of the thing this tool exists to catch, so they are gone until
the name is published.

## Use

```sh
recuse                          # contested markets, most contested first
recuse queue                    # resolutions that have not finished, longest wait first
recuse market <id-or-slug>      # one market, both sides of it
recuse winners <id-or-slug>     # who bought the side that won, and for how much
recuse wallet <address>         # settlement positions, disputed markets first
recuse players                  # addresses that keep ending up on the losing side
recuse regulars                 # addresses that keep ending up on the winning side
recuse ledger                   # what your event log has accumulated
recuse update                   # check for a newer version
recuse serve --mcp              # answer over MCP, for an agent rather than a person
recuse market <id> --json       # same data, pipeable
recuse market <id> --card       # a block sized for pasting into a chat
```

In a terminal you get an interactive list. Pipe it anywhere and you get a single plain table instead, so `recuse | grep Iran` does what you expect.

| key | |
| --- | --- |
| `j` `k` `↑` `↓` | move, `g` and `G` for the ends |
| `enter` | open the detail pane |
| `/` | filter as you type |
| `s` | cycle the sort: contested, moved, money, wiped out, deadline |
| `t` | cycle the theme without restarting |
| `?` | the full list |
| `+` `!` `·` | row moved, its history was rewritten, not seen last run |

### What moved since you last looked

The most contested markets of all time are the same markets tomorrow, which is a good ranking and a poor reason to run a command twice. So the radar keeps a snapshot of its last reading and tells you what changed:

```
1 rewritten, 1 moved of 6 compared since 2026-08-07 14:15
```

The count never travels without the ground it covered. A first run has nothing to compare against, so it reports nothing and says how many markets it recorded, the same rule the watcher runs on. When something has moved, the list opens sorted by that; when nothing has, it opens on the familiar ranking rather than reordering itself for no visible reason.

A market that was not in the previous reading is `not seen before`, never `moved`. The radar only snapshots the rows it assessed, so a market that fell out of the ranking and came back has no baseline, and calling that a move would be manufacturing news out of a change in the sort order.

This snapshot lives in `radar.json`, separate from the watcher's `seen.json` on purpose. One shared file would let a plain `recuse` run write baselines for markets the daemon never polled, and the daemon reports nothing on a market it already has a baseline for, so it would go quiet on the first real move for every market the radar happened to see first.

Five themes. `recuse --theme list` shows them, `RECUSE_THEME` sets a default. Inside the table only one thing is ever coloured, the dispute round count, because a table where four columns are coloured teaches you to stop reading colour. Themes recolour that ramp and the chrome around it; they never give a second column a meaning.

Useful flags: `--scan <n>` for how many markets to examine, `--limit <n>` for how many to show, `--all` to include markets nobody ever contested, `--plain` to skip the interactive view.

## What has not finished

```sh
recuse queue
```

```
MARKET                                    WAITED  RDS  LIFECYCLE        POOL
Trump ends Ukraine war in first 90 days?    16mo   2×  P→D→P→D        $56.5M
Israel x Iran ceasefire before July?        13mo   3×  P→D→P→D→P→D    $51.8M
Will Zelenskyy wear a suit before July?     13mo   5×  P→D→P→D→P→D…  $242.2M
────────────────────────────────────────────────────────────────────────────
37 pending of 400 examined. 108 finished, 255 never reached the oracle.
a record that stops short may be a slow oracle or a feed that never appended.
```

Those three counts are as much the point as the rows. A list of 37 unfinished markets means nothing without how many were examined and how many never entered the oracle at all.

This does not say a market is stuck. A record that stops short is either a resolution still in progress or Gamma never appending the last step, and from outside those are indistinguishable, so the tool reports the last recorded step and how long it has been rather than a diagnosis.

## Sharing one

```sh
recuse market will-zelenskyy-wear-a-suit-before-july --card
```

```
Will Zelenskyy wear a suit before July?

5 dispute rounds  P→D→P→D→P→D→P→D→P→D  $242.2M traded

YES lost. 52.1M tokens went to zero.
  top 5 of 100 holders held 33% of it

NO won. 58.9M tokens, rebuilt from trades.
  top 5 of 20 wallets bought 52% of it
  they paid $57.7M and redeemed $58.9M

balances cannot see this side. winners redeem and leave.
```

Sized for a chat window, no colour, no box drawing. Every share still arrives with its denominator, because the reason to paste one of these is to settle an argument and a number nobody can check settles nothing.

## Watching

There were more than 1,150 disputed markets in 2026. A dispute is an unhedgeable binary risk on money you already committed, and it arrives without warning. `recuse watch` polls for resolutions that move and tells you when one does.

```sh
recuse watch add will-zelenskyy-wear-a-suit-before-july
recuse watch                    # poll until stopped
recuse watch --once             # one pass, for cron or a systemd timer
recuse events                   # everything that has moved so far
```

```
03:09:34 proposed    4×  $242.2M  Will Zelenskyy wear a suit before July?
03:09:34 disputed    5×  $242.2M  Will Zelenskyy wear a suit before July?
         losing side YES: ●○○ 33% (5 of 100, 52.1M tokens)
```

One line per event, so the log stays greppable after a week of running. Each event carries who held what, looked up once per market rather than once per event.

`--discover` also reports disputes on markets you never named, which is how you find out about one before you had an opinion about it. `--min-pool` and `--only disputed` cut the noise, and anything they cut is counted on screen rather than silently dropped.

Three behaviours worth knowing, all of them deliberate:

**The first pass reports nothing.** There is no baseline to compare against, and firing on everything the first time it runs is how a tool teaches you to ignore it. It says how many markets it recorded instead.

**A market it could not read produces no event.** Not-read and nothing-happened are different statements, and it counts the first separately rather than treating an unreachable market as a quiet one.

**A lifecycle that changes in any way other than growing is reported as `rewritten`.** Settled history moving under us is itself the news, and silently accepting the new version would hide exactly the thing this tool exists to notice.

State lives in `~/.recuse`: the watchlist, the watcher's snapshot in `seen.json`, the radar's separate snapshot in `radar.json`, and `events.jsonl`, which is append only and one JSON object per line.

`recuse ledger` reads that log back:

```
52 events across 19 markets, over 34 days

what happened
  disputed        21
  proposed        12
  appeared        10
  settled          9

moved most often
  Will Zelenskyy wear a suit before July?          10×   5d
  US x Iran ceasefire extended by April 22, 2026?   6×   3d
```

This is the only thing here that cannot be recomputed from a public endpoint. A market's dispute history is public today; the record of when you saw it move is not, and it only accumulates while something is running. It does not tally addresses: the event record carries concentration but not holder identities, so an actor ledger is not derivable from this file, and writing one that looked like it was would be inventing a source.

### Sending it somewhere

```sh
recuse watch --webhook https://api.telegram.org/bot<token>/sendMessage
```

POSTs each event as JSON. Telegram, Discord and Slack all take one. A webhook that is down is counted and never stops the loop, because the event is already on stdout and in the log by then.

There is no `--exec` and the runtime CLI never spawns a process. `recuse watch --json` emits one event per line as they happen, so

```sh
recuse watch --json | while read -r e; do notify-send "$e"; done
```

does the same job without this program ever touching `child_process`.

### Leaving it running

`--once` exits after a single pass, so the scheduler already on the machine can own the loop rather than this process:

```cron
*/10 * * * * recuse watch --once --webhook https://... >> ~/recuse.log 2>&1
```

`RECUSE_HOME` moves the state, which is how you run more than one watchlist:

```sh
RECUSE_HOME=~/.recuse-iran recuse watch --once
```

Only one watcher may use a state directory at a time. A second process exits
instead of duplicating events or racing the checkpoint, and a stale lease from
a killed process is reclaimed on the next run.

## Asking it from an agent

```sh
recuse serve --mcp
```

One JSON-RPC message per line on stdin and stdout, which is all MCP over stdio
is, so this needs no SDK and adds no dependency. Six tools:
`contested_markets`, `market_record`, `winning_side`, `repeat_winners`,
`wallet_record` and `resolution_queue`. They call the same engine the commands
do, so a tool result and a table cannot drift apart.

```json
{
  "mcpServers": {
    "recuse": { "command": "recuse", "args": ["serve", "--mcp"] }
  }
}
```

Everything on this surface is read only. No tool writes a file, touches the
watchlist, or reaches the event log.

The interesting part is not the protocol. Every other consumer of this engine is
a person reading a table, and a person can see the denominator sitting next to
the share. This consumer is a language model, which will summarise, and
summarising is precisely the operation that keeps `85%` and drops the `5 of 100`
that made it checkable. A tool built on the argument that people present partial
pictures as complete ones does not get to hand the raw numbers to the most
fluent summariser ever built and hope.

So the guardrails travel as data rather than as prose:

- every payload carries `evidence`, `caveats` and `limits` as arrays of short
  declarative strings, and every tool description says to repeat them
- a share is never a bare number. It ships as one string that cannot be split:
  `"reading": "top 5 of 100 held 32.8%"`, alongside the components
- what was not covered is a field, not a footnote. `contested_markets` states
  how many scanned markets are missing from its own list, and `winning_side`
  reports the token floor the subgraph needed before it would answer
- an unread winner list is omitted. `winning_side` sets `winningSideRead: false`
  and carries a structured `tradeIndexCoverage` reason when the index is behind
  or its head cannot be established. `repeat_winners` counts those markets apart
  from the ones it actually read
- a lookup that could not be verified comes back as `found: false` rather than
  as the first row of whatever Gamma returned instead

The `limits` array is the same on every tool: this reports tallies and not
intent, no proposer or disputer is read by this build, and a display name is not
an identity.

## The half of a settled market you cannot normally see

This is the part that took live data to find, and it is the reason the tool exists in this shape.

When a market settles, winners redeem their tokens for a dollar each and their balances go to zero. Losers keep theirs, because there is nothing to redeem them for. So the holder list of a settled market is almost entirely the people who lost.

On the Zelenskyy market:

| winning side, measured by | tokens |
| --- | --- |
| current balances | 907 across 36 wallets |
| cumulative buys | 71,435,381 across the top 20 |

The single largest winner bought 7.1 million tokens and does not appear in the holder list at all. Any concentration figure read off a settled market's winning balances is measuring whoever had not got round to redeeming yet.

So `recuse` reads both, from different sources, and never mixes them. Balances give you the losing side, which is fully intact. Trades give you the winning side, rebuilt from what people bought. Each is labelled with which one it is.

```
$ recuse market will-zelenskyy-wear-a-suit-before-july

disputes      5 round(s)
lifecycle     P→D→P→D→P→D→P→D→P→D
volume        $242.2M

YES side lost, 52.1M tokens went to zero
  top holders ●○○ 33% (5 of 100 holders, 17.1M of 52.1M tokens)

NO side won, 58.9M tokens rebuilt from trades. balances show almost none of this.
  top buyers  ●●○ 52% (5 of 20 wallets, 30.5M of 58.9M tokens)
```

`recuse winners` goes further and prices each one, and puts a name to it. Every winning token redeems for exactly a dollar, so the profit is arithmetic and not a guess.

```
WHO                           SHARE   BOUGHT     HELD     PAID   AVG     GAIN
0943 0x5bff…ffbe                29%    49.7M    34.0M   $18.7M  0.55   $15.3M
TimeQuestion 0xa1d7…e17e        23%    34.1M    26.7M   $13.7M  0.51   $13.0M
0x971f…5929                      0%    32.9M        0    $-96K     —     $96K
Fredi9999 0x1f2d…d0cf           22%    25.2M    25.2M   $13.5M  0.54   $11.7M
```

Those names are the reason this is worth doing. These wallets redeemed and left the holder list, so no balance-based tracker can name them at all; they are joined in from the activity record, which is the only public place a redeemed wallet is still identified.

A name never appears without its address. Display names are chosen by the account holder, nothing stops one calling itself another account's address, and every finding here is anchored to an address. The full form is always in `--json`.

Frequently unexciting, which is the point. Plenty of these wallets bought at 0.98 and made two cents. A tool that only ever surfaced scandals would be manufacturing them.

## Who keeps winning the contested ones

`recuse winners` answers that for one market. `recuse regulars` asks it across all of them at once, which is a question no balance-based tool can ask at all: every wallet in the answer redeemed and holds nothing now.

```sh
recuse regulars
```

```
ADDRESS       NAME                          WON   OF   TOKENS      NET
0xc8ab…6418   ArmageddonRewardsBilly         11   20     2.9M    +$33K
0x24c8…23e1   debased                         9   20    10.2M   +$294K
0xed10…d2e5   elmcap2                         8   20    12.8M    +$88K
0x889e…09e0   BowlOfPunch                     7   20     9.3M   +$409K

117 of 494 winning wallets took more than one, across 20 markets scored.
18 closed after the trade index stops at 2026-01-05 and were not read at all.
positions at or below 1000 tokens were never requested, so small wins are absent.
someone wins every market. repeatedly is a question, not a finding.
```

Every row carries the number of markets scored, because "won 11" means nothing without how many were on the table. The distribution is the interesting part: on a 600 market scan, most wallets that won a contested market won exactly one, and the tail thins fast. That is what makes the top of the list worth a second look, and it is also why the last line of the footer is there. Someone wins every market. This is a tally, not an allegation, and nothing in this tool reads who proposed or disputed a resolution.

One subgraph query per market, so it is slower than everything else here and reads fewer markets by default. `--limit` sets how many contested markets to rebuild.

## What this cannot see yet

The winning side is rebuilt from a public trade index that is currently about seven months behind the chain. Its last indexed trade is 2026-01-05, and in a 600 market scan, 25 of 38 contested markets closed after that.

This matters more than it sounds, because the store answers a market it never reached with an empty list and HTTP 200, exactly as it answers a market nobody traded. So the honest reading and the wrong one look identical from the outside:

```
$ recuse winners microstrategy-sells-any-bitcoin-by-may-31-2026

NO side won after 2 dispute round(s) · $375.8M traded

the winning side was not read. the trade index stops at 2026-01-05
and this market closed after that.
```

Not "nobody won a $375M market". `--json` omits `winners` and carries a structured `tradeIndexCoverage` reason, plus `tradeIndexEndsAt` when the market is beyond the known head. The MCP payload sets `winningSideRead: false` for the same reason. An empty array is a claim, and it is not one this build is entitled to make about a recent market.

The losing side, the dispute lifecycle, the queue and the watcher all read from Gamma and are current. It is only the trade-rebuilt half that stops in January.

## Following one wallet

```sh
recuse wallet 0x889e7f0464c72eb8cda1525ebc12b6aaba9d09e0
```

This is a record of positions carried into settlement, not every trade the
wallet ever made. Positions sold before settlement and positions at or below the
reported floor are absent. The record comes from that same trade index. Its JSON includes a structured
`tradeIndex` head and every renderer states the date after which trades are
absent, so a stale position record is never presented as the wallet's whole lifetime.

```
38 resolved · 29 won · 9 lost · 1 open · +$859K net
11 of those were disputed, worth +$275K
──────────────────────────────────────────────────────────────────────────
 RDS  SIDE   RESULT      HELD      GAIN  MARKET
  5×  No     won         7.0M    +$116K  Will Zelenskyy wear a suit before July?
  2×  No     won         508K    +$152K  Trump ends Ukraine war in first 90 days?
  2×  Yes    lost        508K    -$134K  Trump ends Ukraine war in first 90 days?
  2×  Yes    won         400K     +$67K  Yoon out as president of South Korea before May?
```

Disputed markets sort to the top, because that is why you would look here rather than in a general wallet tracker. The same wallet appears on both sides of the Ukraine market: that is a spread, not a contradiction, and both legs are shown.

Every gain is arithmetic, not an estimate. The position size comes from cumulative trades and the settlement price comes from the condition's on-chain payout, so a wallet that redeemed and vanished from every balance-based tracker is still fully visible here.

Split resolutions are counted as splits. UMA does hand down 50/50 outcomes, and calling one a loss on both sides is wrong on both.


## What the numbers mean

`RDS` is dispute rounds. One round is one person putting up a bond to contest a proposed outcome. Two rounds means two people did.

`WIPED` is how many outcome tokens on the losing side are still sitting in wallets, worth nothing.

`TOP 5 HELD` reads as a share and then its terms: `85% 5/100` means the five largest holders we could see held 85% of that side, out of the hundred holders the API returned. The share never appears without the count behind it, because a share of an unknown denominator is not checkable.

One more thing worth knowing. In a 400 market scan, zero of the 30 contested markets were still open. Disputes finish. By the time one shows up in the history it is over, and the tool says so rather than implying you are watching something live.

## What it will not tell you

It will not tell you a market was rigged. It reports two public facts, what happened to a resolution and who held which side, and leaves the reading to you. Someone has to be on the losing side of every market. Being there repeatedly is a question worth asking, not an answer.

It holds no keys, places no orders, and never asks for a wallet. It reads public endpoints and prints tables. `recuse update` tells you a new version exists and prints the install command rather than running it.

## Who proposed and who disputed, which this does not read

It does not read them. No version has. Every reading here stands on positions and trades, the footer says which, and `RECUSE_RPC_URL` is validated and then unused.

That is worth stating plainly because for a while the tool implied otherwise. The evidence tier was assembled from whether the variable was set rather than from whether anything was read, so exporting it printed `positions+chain` over an empty actor list. A tool built on the argument that people present partial pictures as complete ones does not get to do that, so the tier is now assembled only from sources that answered.

Proposer and disputer addresses live in the logs of UMA's Managed Optimistic Oracle on Polygon, which needs `eth_getLogs` over a block range. The free public endpoints will not serve one. Measured while building this:

| endpoint | range it will serve |
| --- | --- |
| polygon-bor-rpc.publicnode.com | 1000 blocks, throttled to 10 under load |
| polygon.drpc.org | rejects ranges it advertises as supported |
| 1rpc.io/matic | 50 blocks |

At 50 blocks a window, one day of Polygon costs 860 requests, which is why this is the piece that is not finished.

There used to be about two hundred lines of working JSON-RPC in `src/sources/chain.ts` waiting for it: a windowed log scanner and an event classifier, none of it reachable from anything. It was deleted in 0.6.0. Code that looks finished and runs never is the same failure as a claim about evidence nobody read, one level down, and keeping it warm is how the scheme check on `RECUSE_RPC_URL` sat unexecuted for weeks. The decoded oracle address, adapter addresses and topic hashes survive as prose in that file's header, because the research was the expensive part and the code was not. `git log` has the implementation.

The `Assessment` shape lost its `actors` and `conflicts` fields in the same release. They were always empty arrays, and `"actors": []` tells whatever parses it that the oracle was read and nobody was there.

## Where the data comes from

Everything below is public and unauthenticated.

Market catalogue and resolution history come from `gamma-api.polymarket.com`, which exposes the lifecycle as an ordered log: proposed, disputed, proposed, resolved. Current balances come from `data-api.polymarket.com`, with the display names accounts chose for themselves. Cumulative trades come from Goldsky's `polymarket-orderbook-resync` subgraph, which is the only free source that can see a redeemed position.

Two traps worth knowing about if you build against any of it.

Gamma ignores query parameters it does not recognise and answers with its default page rather than an error, so asking for one market by an unsupported filter hands you twenty unrelated ones and nothing in the response says the filter was dropped. Every lookup here is checked against what was requested.

The subgraph will not sort positions by size without a lower bound on that size. The query times out in the store instead. `recuse` escalates the bound until the query lands and then reports which bound it used, because a floor is a fact about the reading rather than a display setting.

The subgraph also reports `outcomeIndex` as null on every record checked, and `Number(null)` is `0`. Reading which side a position was on from that field gives you a complete table of confident wrong answers with every position on outcome 0. The index has to come from Gamma's `clobTokenIds`, which is index-aligned with `outcomes`.

## Build

```sh
npm install     # also builds, so ./dist/cli.js works straight after
npm run typecheck
npm test        # full offline suite, sub-second
npm run build
npm run check   # the house rules, enforced
```

Two runtime dependencies, ink and react.

`npm run check` is `tools/housekeeping.mjs`, which CI also runs. It checks prose for em dashes and emoji, the commit log for attribution trailers, and every symbol in `src/` for whether the program can actually reach it. That last one exists because this repo has shipped unreachable code that read as working twice, and the note written down after the first time did not prevent the second, because remembering to grep is not a check. It walks out from `cli.ts` rather than counting references, since the dead chain layer was eight exports that called each other and three of them had passing tests.

The owner release procedure, including npm provenance and recovery checks, is in [RELEASING.md](RELEASING.md).

Remote text is treated as hostile. Display names are chosen by the same accounts the tool makes claims about, and a name carrying a terminal escape sequence could redraw the table above it. Everything is sanitised where it enters, not where it prints. See [SECURITY.md](SECURITY.md).

MIT.
