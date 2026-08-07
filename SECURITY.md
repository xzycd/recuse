# Security

## What this tool can and cannot do

`recuse` holds no private keys, signs nothing, places no orders and never asks for a wallet. It makes GET and POST requests to public endpoints and prints tables. There is nothing in it worth stealing, which is the strongest control available and the reason it is built this way.

It writes to `~/.recuse` and nowhere else. That directory is created 0700 and every file in it 0600: the update cache, the watchlist, the last snapshot of each watched market, and the append only event log. A watchlist is a statement about what someone is trading, so it is not left world readable.

Nothing is ever spawned. There is no `--exec`, no shell hook and no `child_process` import anywhere in the tool. `recuse watch --json` emits one event per line, so piping into a shell loop gives anyone the same power without this program having that capability at all.

## Threat model

The interesting attacker is not someone breaking into the tool. It is someone the tool is reporting on.

Polymarket display names are chosen freely by the account holder, and `recuse` prints them in a table making claims about that same account. Left unfiltered, that is a channel from a subject of the report into the terminal of whoever is reading it.

| what a name could carry | what it does |
| --- | --- |
| `\x1b[2J\x1b[H` | clears the screen and homes the cursor, so the rows above can be redrawn |
| `\r` | returns to column zero and overwrites the row just printed |
| `\x1b]52;c;…` | writes the reader's clipboard on xterm, iTerm2 and kitty |
| `U+202E` | right to left override, so an address renders reversed |
| `U+200B` | zero width space, so two different names compare as identical |

The last two matter most, because every finding in this tool is anchored to an address.

Every string from every source is filtered on the way in, in the source module, before it reaches any renderer. Filtering at ingest rather than at render is deliberate: a render-time filter is one forgotten call site away from a hole, and it would leave `--json` output dirty while the table looked clean. The filter removes control characters by code point rather than trying to match escape-sequence grammar, because grammars are large, terminal specific and still growing, while the control character set is fixed.

## Other measures

**Credentials never reach output.** `RECUSE_RPC_URL` usually carries an API key, in a path segment or a query parameter, and Node puts request URLs into some network error messages. Every error printed by the CLI goes through a redactor first, because the natural next step after an error is pasting it into an issue.

**Responses are capped at 32MB.** `res.json()` buffers whatever arrives with no limit. The declared Content-Length is checked first, then the bytes are counted while reading, because the header is a claim and the stream is the fact.

**`RECUSE_RPC_URL` must be http or https.** Without a scheme check, `file:` would turn a config value into a local file read the day the oracle layer starts POSTing to it. This check was written once and wired to a constructor nothing ever called, so it did not run at all until it was moved to the status function that every reading calls. An unwired defence reads exactly like a working one, which is the second time that has cost time here, so the check now has tests that fail if it stops running.

**Values interpolated into URLs and queries are revalidated at the interpolation site**, not trusted from wherever they were produced. Condition ids must be 32 byte hashes, addresses must be 20 bytes, token ids must be plain decimal integers under 79 digits.

**Webhook URLs are checked before the loop starts**, not on the first event, and any credential in one is removed from error output. A Telegram webhook carries a bot token in its path, and a watcher that runs all night only to fail on delivery would otherwise print it.

**State is written to a temporary file and renamed.** A watcher runs for days and will eventually be killed mid-write. A truncated snapshot file would silently re-baseline every market in it, which is a correctness failure rather than a security one, but the fix is the same.

**Nothing is ever installed.** `recuse update` checks the registry and prints the install command. A CLI that updates itself runs whatever is at that name on the registry the next time the name changes hands or a release is compromised.

## Known limits

`clip` and `padEnd` count code points, so a full width character occupies one budgeted cell and two real ones. Market questions from Gamma are Latin, so this has not caused a problem in practice. Fixing it properly needs a character width table, and a width table is a dependency.

There is no TLS pinning. A machine with a hostile root certificate authority sees hostile data.

The upstream APIs are trusted for truth but not for safety. If Gamma reports a dispute count that is wrong, `recuse` repeats it. The verification in `matchesRequest` catches being handed the wrong record, not a wrong field inside the right one.

## Reporting something

Open an issue. If it is something that should not be public first, say so in the issue without the detail and it will be moved somewhere private.

Two runtime dependencies, ink and react, both kept current.
