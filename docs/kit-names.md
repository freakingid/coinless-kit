# kit-names — Spec & Client API

**Module:** `kit-names`
**Part of:** coinless-kit
**Version:** v0.1.0
**Depends on:** nothing
**Talks to:** nothing — pure functions and constants, no storage, no network
**Scope:** display-name rules shared between kit-profile and kit-leaderboard.

> Spec and client API are one doc here because the module is one function and
> three constants. Splitting it would produce two documents that repeat each
> other. If it ever grows a second concern, split it then.

---

## 1. Why this module exists

Display-name rules were implemented twice and drifted.

- kit-leaderboard's `validateName` enforces 1–12 characters, `A-Z 0-9 space
  - _`, uppercased, internal whitespace collapsed, no Unicode.
- Orbital Overhaul's `Profiles.cleanName` trims and slices to 12 characters and
  enforces nothing else.

So `Gh0st!` is a legal local profile name today and a permanent board
rejection at submit time. `NAME_REJECTED` is **not** queued by kit-leaderboard —
retrying produces the same rejection forever — so that run's score is simply
lost.

Two copies of a rule set drift. That's not a hypothetical here; it already
happened. kit-names is the single source both modules import.

### 1.1 This changes kit-leaderboard's contract

kit-leaderboard v0.1.0 documents **"Depends on: nothing."** Importing kit-names
makes that false. Therefore:

- kit-leaderboard is re-tagged **v0.2.0**, with `Depends on: kit-names` in its
  doc header and the rules section replaced by a pointer here.
- v0.2.0 **re-exports** `validateName` and `NAME_CHANGE_NOTICE` from kit-names,
  so every call site documented in `kit-leaderboard-client-api.md` —
  `KitLeaderboard.validateName(...)`, `KitLeaderboard.NAME_CHANGE_NOTICE` —
  keeps working unmodified.
- Games pin tags, so Orbital Overhaul stays on kit-leaderboard v0.1.0 until it
  deliberately upgrades. Nothing breaks on its own schedule.

Record this in `DECISIONS.md` when implementing.

### 1.2 The Worker imports kit-names too

`services/leaderboard/src/validate.js` implements these rules server-side and
is authoritative. It imports `validateName` from kit-names rather than keeping
an independent copy — `wrangler deploy` already bundles the Worker's source
with esbuild, so this is an ordinary sibling import, not new infrastructure.

Decided 2026-08-18: with the site not yet publicized and no production
traffic, the cost of a redeploy plus a smoke-test re-run is low, so the
duplicate was closed immediately rather than left as a known gap. See
`DECISIONS.md`.

**The Worker's copy of the rules is deleted, not kept as a fallback.** A
fallback that only runs if the import fails is untested code that becomes a
liability the day it's needed. If the import breaks, the deploy should fail
loudly, not degrade to stale rules silently.

---

## 2. The rules

A name is normalized, then validated. Both halves are specified exactly,
because "same rules" is the entire point of the module.

```
1. Not a string            -> empty
2. Trim leading/trailing whitespace
3. Collapse internal whitespace runs to a single space (U+0020)
4. Reject if any character is outside [A-Za-z0-9 _-]     <- BEFORE uppercasing
5. Uppercase
6. Reject if length is 0 or > 12
```

### 2.1 ⛔ Step 4 runs before step 5, deliberately

Uppercasing can *introduce* characters that pass an ASCII charset check.
`'ß'.toUpperCase()` is `'SS'`; `'ﬁ'.toUpperCase()` is `'FI'`. Validating the
charset after uppercasing would let both through, silently changing the name's
length and admitting the Unicode the rules exclude. Checking the pre-uppercase
string closes it.

A future session "simplifying" this by reordering the two steps reintroduces
the bug. Don't.

### 2.2 No accent folding

`ÉCLAIR` is rejected as `illegal_character`, not folded to `ECLAIR`. The rules
say no Unicode and that is what they mean. Folding is a judgment call about
what a player meant, and the server would have to make the identical call or
the client check stops matching.

### 2.3 No profanity list

Deliberately absent. The server owns profanity and may return `NAME_REJECTED`
for a name that passes here. Keeping the wordlist out of shipped game source is
the point — a client-side wordlist is a public wordlist.

---

## 3. API

```js
import * as KitNames from './kit-names.js';
```

### `KitNames.validateName(name) -> { ok, reason, normalized }`

```js
KitNames.validateName('Gh0st!')
// -> { ok: false, reason: 'illegal_character', normalized: null }

KitNames.validateName('  ghost ')
// -> { ok: true, reason: null, normalized: 'GHOST' }

KitNames.validateName('a  b')
// -> { ok: true, reason: null, normalized: 'A B' }
```

`reason` is one of `'empty'`, `'illegal_character'`, `'too_long'`, or `null`.

`normalized` is `null` on failure — never a partially-cleaned string. A caller
must not be able to accidentally store a value that failed validation.

**Precedence when more than one rule fails:** `empty` → `illegal_character` →
`too_long`. A 20-character string containing `!` reports `illegal_character`.
Fixed order so two implementations can't disagree about which message a player
sees.

Pure and total: never throws, no storage, no DOM, no network.

### `KitNames.NAME_CHANGE_NOTICE`

```
Scores you've already posted will keep the name you used at the time.
Only new scores will show your new name.
```

Shown in a rename flow, before confirmation, with the option to cancel.

This is a *leaderboard* fact surfaced by a *profile* UI, which is why it lives
in neither module. kit-leaderboard v0.1.0's doc anticipated exactly this:
whichever module ends up owning profile management should import the constant
rather than re-type the sentence. Having kit-profile import it *from*
kit-leaderboard would point a local identity module at a network module, so
both import it from here.

### `KitNames.MAX_NAME_LENGTH`

`12`. Exported so kit-profile can set an input's `maxlength` and a game can
size a text field without hardcoding the number in three places.

Note this matches Orbital Overhaul's existing `PROFILE_NAME_MAX = 12` — the
one name rule that never drifted.

---

## 4. What this module deliberately does not do

- **Store anything.** No kit-storage dependency, no `localStorage`.
- **Own profanity filtering.** §2.3.
- **Fold, transliterate, or guess.** §2.2.
- **Support a 3-character initials mode.** Series-wide decision: 12-character
  names across every coinless game, because the board is cross-game and mixed
  name lengths on one board are permanently visible. A game wanting arcade
  initials constrains its own input field; it does not get different rules.

---

## 5. Test checklist

- `'  ghost '` → `GHOST`. `'a  b'` → `A B`. `'a\t\nb'` → `A B`.
- `'Gh0st!'` → `illegal_character`, `normalized: null`.
- `''`, `'   '`, `null`, `undefined`, `42`, `{}` → `empty`.
- 12 chars → ok. 13 chars → `too_long`.
- **`'ß'` → `illegal_character`**, not `SS`. **`'ﬁ'` → `illegal_character`**,
  not `FI`. These two are the regression tests for §2.1 — assert them by name.
- `'ÉCLAIR'` → `illegal_character`.
- `'A_B-C 1'` → ok, unchanged.
- 20 chars containing `!` → `illegal_character`, not `too_long`.
- `validateName` never throws for any input, including a Proxy or an object
  with a throwing `toString`.
- kit-leaderboard v0.2.0's re-export is reference-identical to
  `KitNames.validateName`.
- Worker: full deploy-notes smoke-test sequence re-run against production
  after the import lands, with particular attention to the name-rejection
  case (§ below) since that's the behavior actually changing.
- Worker: a name that passes kit-names' client check and one that the Worker
  used to accept/reject under its old inline rules — diff the two rule sets
  before deploying and confirm they're identical, or document the delta if
  they aren't. (They should be identical; this is the check that catches it
  if they somehow weren't.)