# DNA

What this project is, and the rules that keep it that way. Read before changing anything user facing.

## The one idea

Polymarket settles by vote, not by fact. `recuse` reports what happened to that vote and who held what, using only public data, and refuses to draw the conclusion for you.

Everything else follows from that. If a feature does not help someone answer "who decided this, and what did they own", it does not belong here.

## Voice

Concrete, second person, no adjectives doing work that a number should do.

Say "52.1 million tokens went to zero" and not "significant losses". Say "the free public endpoints cap at 50 blocks" and not "RPC limitations exist". If a sentence would survive being pasted into a different project's README, it is too vague to keep.

No em dashes in prose. No emoji anywhere, including the TUI, where they break column alignment. Headings are sentence case. Commit messages are lowercase and imperative.

## Rules that are not negotiable

**A score never travels without its terms.** `85%` on its own is unfalsifiable. `85% 5/100` says five of the hundred holders we could see, which a reader can check and argue with. Every surface that prints a share prints its denominator. This applies to JSON as much as to tables.

**Never report a confident zero over ground you did not cover.** An early version of the oracle scan swallowed rate limit errors and printed "0 disputes found" after all thirty of its windows failed. Any function that scans, pages, or samples returns what it could not read alongside what it could, and callers pass that through to the user.

**Never hide a filter.** If rows were dropped, the count and the reason stay on screen with a way to see them. `370 markets hidden, never contested. --all to include them.`

**Say which evidence you are standing on.** Positions only, or positions plus chain. A partial picture presented as a complete one is the exact failure this tool exists to catch, and shipping it here would be embarrassing.

**Verify what an API hands back.** Gamma answers unrecognised query parameters with its default page instead of an error. A lookup that cannot be confirmed is reported as a miss, never guessed at.

**Report, do not accuse.** The word is conflict, never fraud. Someone has to lose every market. The tool supplies tallies and the reader supplies judgement.

## Interface rules

Colour carries exactly one signal: dispute rounds. Grey for none, yellow for one, red for more. When a second thing gets coloured, the eye learns to ignore colour and the one signal that mattered goes unread.

Two levels of depth, list and detail. A third would need its own navigation model and the data is not that deep.

Columns drop as the terminal narrows, in a fixed order. Market name, rounds and concentration never drop, because they carry the finding. It has to be readable at 80 columns.

Degrade instead of crashing. Not a terminal means a plain table. `NO_COLOR` means monochrome. A terminal resize redraws rather than wrapping into garbage.

The renderers are consumers of the engine, not the product. `--json` exists on every command, and anything you can read you can pipe.

## What this refuses to do

No private keys, ever. No order placement. No wallet connection. No custody of anything.

No paid data sources in the default path. If it does not work with `npx recuse` and no configuration, it is an opt in layer and the tool announces its absence.

No accusations, no scores that imply intent, no naming anyone as a wrongdoer.

## Dependencies

Two: ink and react. Chain access is `fetch` against JSON-RPC, because the whole job is `eth_getLogs` and a string slice, and importing two megabytes to call `.slice()` is not a trade worth making.

Before adding a third dependency, write down what it does that thirty lines cannot.
