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
npx recuse
```

Or `npm i -g recuse`. Node 20 or newer. No API keys, no account, no config file.

## Use

```sh
recuse                          # contested markets, most contested first
recuse market <id-or-slug>      # one market, both sides of it
recuse winners <id-or-slug>     # who bought the side that won, and for how much
recuse players                  # addresses that keep ending up on the losing side
recuse update                   # check for a newer version
recuse market <id> --json       # same data, pipeable
```

In a terminal you get an interactive list. Arrow keys move, enter opens the detail pane, q quits. Pipe it anywhere and you get a single plain table instead, so `recuse | grep Iran` does what you expect.

Useful flags: `--scan <n>` for how many markets to examine, `--limit <n>` for how many to show, `--all` to include markets nobody ever contested, `--plain` to skip the interactive view, `--theme <name>` to change the palette.

Five themes. `recuse --theme list` shows them, `RECUSE_THEME` sets a default. Inside the table only one thing is ever coloured, the dispute round count, because a table where four columns are coloured teaches you to stop reading colour.

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

State lives in `~/.recuse`: the watchlist, the last snapshot of each market, and `events.jsonl`, which is append only and one JSON object per line.

### Sending it somewhere

```sh
recuse watch --webhook https://api.telegram.org/bot<token>/sendMessage
```

POSTs each event as JSON. Telegram, Discord and Slack all take one. A webhook that is down is counted and never stops the loop, because the event is already on stdout and in the log by then.

There is no `--exec` and nothing is ever spawned. `recuse watch --json` emits one event per line as they happen, so

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

`recuse winners` goes further and prices each one. Every winning token redeems for exactly a dollar, so the profit is arithmetic and not a guess.

```
ADDRESS                                       SHARE   BOUGHT     HELD     PAID   AVG     GAIN
0x889e7f0464c72eb8cda1525ebc12b6aaba9d09e0      16%     7.1M     7.0M    $6.9M  0.98    $116K
0xc6587b11a2209e46dfe3928b31c5514a8e33b784      16%     6.9M     6.9M    $6.8M  0.98    $133K
```

Frequently unexciting, which is the point. Most of these wallets bought at 0.98 and made two cents. A tool that only ever surfaced scandals would be manufacturing them.

## What the numbers mean

`RDS` is dispute rounds. One round is one person putting up a bond to contest a proposed outcome. Two rounds means two people did.

`WIPED` is how many outcome tokens on the losing side are still sitting in wallets, worth nothing.

`TOP 5 HELD` reads as a share and then its terms: `85% 5/100` means the five largest holders we could see held 85% of that side, out of the hundred holders the API returned. The share never appears without the count behind it, because a share of an unknown denominator is not checkable.

One more thing worth knowing. In a 400 market scan, zero of the 30 contested markets were still open. Disputes finish. By the time one shows up in the history it is over, and the tool says so rather than implying you are watching something live.

## What it will not tell you

It will not tell you a market was rigged. It reports two public facts, what happened to a resolution and who held which side, and leaves the reading to you. Someone has to be on the losing side of every market. Being there repeatedly is a question worth asking, not an answer.

It holds no keys, places no orders, and never asks for a wallet. It reads public endpoints and prints tables. `recuse update` tells you a new version exists and prints the install command rather than running it.

## Reading who proposed and who disputed

Proposer and disputer addresses live in the logs of UMA's Managed Optimistic Oracle on Polygon, which needs `eth_getLogs` over a block range. The free public endpoints will not serve one. Measured while building this:

| endpoint | range it will serve |
| --- | --- |
| polygon-bor-rpc.publicnode.com | 1000 blocks, throttled to 10 under load |
| polygon.drpc.org | rejects ranges it advertises as supported |
| 1rpc.io/matic | 50 blocks |

At 50 blocks a window, one day of Polygon costs 860 requests. So this layer is off by default and the tool says so in its footer every time it runs. Set `RECUSE_RPC_URL` to any provider free tier and it turns on.

```sh
RECUSE_RPC_URL=https://polygon-mainnet.example.com/v2/key recuse
```

## Where the data comes from

Everything below is public and unauthenticated.

Market catalogue and resolution history come from `gamma-api.polymarket.com`, which exposes the lifecycle as an ordered log: proposed, disputed, proposed, resolved. Current balances come from `data-api.polymarket.com`, with the display names accounts chose for themselves. Cumulative trades come from Goldsky's `polymarket-orderbook-resync` subgraph, which is the only free source that can see a redeemed position.

Two traps worth knowing about if you build against any of it.

Gamma ignores query parameters it does not recognise and answers with its default page rather than an error, so asking for one market by an unsupported filter hands you twenty unrelated ones and nothing in the response says the filter was dropped. Every lookup here is checked against what was requested.

The subgraph will not sort positions by size without a lower bound on that size. The query times out in the store instead. `recuse` escalates the bound until the query lands and then reports which bound it used, because a floor is a fact about the reading rather than a display setting.

## Build

```sh
npm install
npm test        # 192 tests, no network
npm run build
```

Two runtime dependencies, ink and react. Chain access is 20 lines of `fetch` against JSON-RPC rather than a web3 library, because the whole job is one method and a string slice.

Remote text is treated as hostile. Display names are chosen by the same accounts the tool makes claims about, and a name carrying a terminal escape sequence could redraw the table above it. Everything is sanitised where it enters, not where it prints. See [SECURITY.md](SECURITY.md).

MIT.
