# Working in this repo

Read DNA.md first. It has the rules. This file is the mechanics.

## Layout

```
src/
  sources/    one module per external service, each returning typed records
    http.ts       fetch with timeout and backoff, plus the embedded-JSON decoder
    gamma.ts      market catalogue and resolution lifecycles
    dataapi.ts    holders, with the display names accounts chose
    chain.ts      optional, gated on RECUSE_RPC_URL
  core/       pure logic, no I/O except where noted
    dispute.ts    parses umaResolutionStatuses into rounds, phase, clock
    capture.ts    which side is measurable, concentration, repeat tallies
    assess.ts     assembles one answer from every source (does I/O)
  ui/
    format.ts     numbers, widths, colour, NO_COLOR and non-TTY detection
    plain.ts      the plain renderer, and the fallback for pipes
    App.tsx       the ink radar
  cli.ts      arg parsing, command dispatch, --json on every path
```

`core/dispute.ts` and `core/capture.ts` are pure. Keep them that way. They hold every judgement the tool makes, which is why they carry most of the tests.

## Commands

```sh
npm test          # 55 tests, no network, sub-second
npm run build     # tsc, output to dist/
npm run dev       # tsc --watch
```

## Testing policy

Test the arithmetic, not the rendering. A column width is not worth a test and a share calculation is.

Fixtures come from real markets. The dispute parser is pinned to lifecycles pulled from live Gamma, including the Zelenskyy market at five rounds and the MicroStrategy market at two. If a refactor breaks one of those, the parser is wrong, not the test.

Before trusting a change to anything that touches an API, run it against live data. Three separate bugs in this codebase were invisible to unit tests and obvious the moment real data went through:

1. Gamma returned the wrong market and the code believed it.
2. Concentration was measured on the winning side, which redemption empties.
3. An oracle scan reported zero after every one of its windows errored.

## Things that will bite you

**Gamma caps `limit` at 100** no matter what you pass, and defaults to open markets, so a settled market is invisible without `closed=true`. It also ignores query parameters it does not recognise and returns its default page rather than an error. Always verify the record matches what you asked for, with `matchesRequest`.

**Several Gamma fields arrive as JSON inside a string.** `outcomes` comes back as the literal text `["Yes", "No"]`. Use `parseEmbeddedJson`, which returns a fallback rather than throwing, so one malformed field costs a column instead of the run.

**Winners are invisible in holder data.** They redeem and their balances go to zero. Anything that reasons about "who won" from current holders is wrong. See the long comment in `core/capture.ts`.

**Free public Polygon RPCs cannot scan logs.** They cap `eth_getLogs` between 10 and 50 blocks and throttle further under load. This is why the chain layer is opt in. Do not try to work around it by scanning harder.

**Contested markets are almost never still open.** Zero of 30 in a 400 market scan. Code that assumes a live dispute will mostly be running against settled ones.

## Adding a source

Put it in `src/sources/`, return typed records from `src/types.ts`, and let errors escape. `core/assess.ts` decides what a failure means and turns it into a caveat, because a partial answer that says so beats a crash.

If the source can fail partway, return what failed alongside what succeeded. See `ScanResult` in `chain.ts`.

## Commits

Lowercase, imperative, no emoji, no conventional-commit prefixes. Explain why in the body when the reason is not obvious from the diff, especially when live data changed your mind about something.
