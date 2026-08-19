# kit-profile — Design & Implementation Spec

**Module:** `kit-profile`
**Part of:** coinless-kit
**Version:** v0.1.1
**Depends on:** `kit-storage` (instance injected), `kit-names`
**Talks to:** nothing — local only, no server component, no deploy notes doc
**Scope:** local player identity. `player_id`, display name, the profile roster.

> This is the implementation contract. A game reads
> `kit-profile-client-api.md` instead. This doc is what a Claude Code session
> implements against.

---

## 1. What this is an extraction of

This module is **not a from-scratch design.** Orbital Overhaul's `Profiles`
object is in production, it is correct, and it is the source. Its
`player_id` minting and backfill were built during the leaderboard
integration (CS033) and its profile-switch reset list is the result of real
bugs found and fixed (`FLAG-CS031-d`), not defensive boilerplate.

The job here is to generalize it, close two structural gaps, and reshape one
seam — while carrying the parts that already work forward **unchanged**.
Section 12 lists everything that must not be re-derived.

---

## 2. Governing principles

### 2.1 `player_id` is minted once and never regenerated.

This is the constraint everything else bends around. A regenerated
`player_id` silently fragments a player's leaderboard history into two
identities that can never be merged — and it fails *quietly*, showing up
weeks later as a board that inexplicably lists the same person twice. See §3.

### 2.2 `player_id` and `display_name` are different things.

`player_id` is a stable UUID the board deduplicates on. `display_name` is a
mutable label copied onto each submitted run; old rows keep the name they were
submitted with. A player can rename freely without fragmenting history, and two
profiles can share a display name without being confused for one player.

**Consequence:** a board may legitimately show several rows reading
`ANONYMOUS`, because they are genuinely different players. Correct behavior.
⛔ Not a bug to fix by deduplicating on name.

### 2.3 kit-profile owns identity, not the consequences of switching identity.

Settings, audio volumes, key bindings, debug state, achievement counters and
live game state all need resetting on a profile switch. kit-profile cannot know
any of them exist and must never import them. What it owes the game is a
**lifecycle with the right seams** so the game's own reset can be correct. §7.

### 2.4 Never destroy data you don't understand.

Inherited from kit-storage. Applied here to two specific cases: a roster
holding more profiles than the configured maximum (§6.3), and a name that is
legal locally but illegal on the board (§8.2). Both are preserved, not
truncated or rewritten.

---

## 3. `player_id` — the mechanism, verified

The production implementation is three lines and all three properties matter:

```js
ensurePlayerId(id) {
  const p = this.byId(id);
  if (p && !p.playerId) { p.playerId = crypto.randomUUID(); this.save(); }
  return p ? p.playerId : null;
}
```

1. **Check-then-mint.** Mints only when absent. Cannot re-mint.
2. **Persists immediately**, not at the next natural save, so the mint
   survives a crash between minting and whatever save would otherwise have
   come next.
3. **Called from every path that reaches a profile** — in production, `init()`
   (cold boot) and `activate()` (switch), so a pre-CS033 profile is backfilled
   the first time it is touched by *either*.

The backfill works because `load()` defaults a missing `playerId` key to
`null`: a pre-CS033 blob simply has no such key, which parses to `undefined`
and falls through to `null` — the exact state the check treats as unset.

⛔ **Carry this forward verbatim.** Do not "improve" it into a lazy getter, a
constructor-time mint, or a migration pass.

### 3.1 The one structural change: more call sites, same logic

In production the backfill fires only for the profile being *activated*. A
roster entry never selected never gets an id, and `add()` deliberately doesn't
mint. That is safe today only because `getPlayer()` calls `ensurePlayerId`
belt-and-suspenders before reading.

kit-profile makes that structural. `ensurePlayerId` is invoked at **every point
identity is read or established**:

- boot, for the profile that ends up active (§5)
- `select(id)`, before the switch completes (§7)
- `current()`
- `player()`

Because check-then-mint is idempotent, adding call sites can only shrink the
window in which a profile lacks an id. The logic is unchanged; only the number
of moments it runs increases. This is the sense in which the existing solution
is carried forward rather than reinvented.

⛔ `list()` does **not** mint, and does not expose `playerId` at all. Roster
display has no need for it, and minting eight UUIDs because a player opened a
picker would tie identity creation to a UI event.

⛔ `create(name)` does **not** mint either — matching production's `add()`.
The id appears when the profile is first activated, which under required boot
selection (§5.4) is immediately after creation anyway.

---

## 4. Storage layout

kit-profile is handed a kit-storage instance; it never creates its own.

### 4.1 The roster key

Root scope, key `profiles`, declared at **version 1**:

```js
storage.declare('profiles', { version: 1 });
```

Stored value:

```json
{ "lastUsed": "p1", "seq": 3,
  "profiles": [ { "id": "p0", "name": "GHOST", "created": 1723..., "playerId": "3f2a..." } ] }
```

The old blob's internal `"v": 1` field is **dropped** — kit-storage's envelope
carries the version now. The legacy import (§5.2) reads it and discards it.

### 4.2 Per-profile scopes and legacy transparency

```js
const scopeFor = id => (id === legacyProfileId ? storage : storage.scope(id));
```

Three lines reproducing production's `keyFor()`: the legacy profile addresses
the **root scope directly**, every other id gets a kit-storage child scope.
That is what lets `p0`'s stores *be* the pre-profile keys, unmoved.

⛔ This lives here, not in kit-storage. kit-storage has no concept of a
"transparent scope" and must not grow one.

Exposed to the game as `profiles.scope(id)` so achievements, settings and local
scores can namespace themselves per profile without depending on kit-profile
for anything but a store handle.

### 4.3 ⛔ Removing a profile does not clear its stores

Production's `remove()` deliberately leaves the removed profile's data in
place, which is *why* `seq` is monotonic: a recycled id would otherwise inherit
a dead profile's settings and achievements.

kit-storage v0.1.0 offers `scope.clear({ deep: true })`, which makes deleting
that data a tempting one-liner. **Don't.** The monotonic-`seq` guarantee is the
protection; clearing is the thing it protects against needing. If a "delete my
data" feature is ever wanted, it is a separate, explicit, confirmed action —
not a side effect of removing a roster row.

---

## 5. Boot

`create()` runs this sequence synchronously and never throws.

### 5.1 Load the roster

Read the `profiles` key. Parse **defensively, field by field** — kit-storage
guarantees valid JSON at the declared version, not the right shape. Carry
production's `load()` rules exactly:

- Skip entries that aren't objects, lack a string `id`, or duplicate an id
  already seen.
- `name` through the lenient path (§8.2); skip the entry if it comes back empty.
- `created` must be a number, else `0`.
- `playerId` must be a non-empty string, else `null` — this is what makes §3's
  backfill fire.
- **`seq` never drops below what the roster already uses**, however the stored
  value was edited: take `max(storedSeq, max(numeric suffix) + 1)`.
- Anything unreadable or corrupt → empty roster, no throw.

A usable, non-empty roster is the single signal the rest of boot branches on.

### 5.2 If there's no roster key: one-time legacy import

Read `legacyRosterKey` (default `afd_profiles_v1`) via `storage.raw.get()`,
parse with the identical defensive rules, and if usable, write it to the new
`profiles` key.

⛔ **The legacy key is read, never deleted and never rewritten.** A player who
rolls back to an older build still has their roster. kit-storage §2.4.

### 5.3 If there's still no roster: probe for a pre-profile install

Check `legacyProbeKeys` (default `['afd_settings_v1', 'afd_achievements_v2']`)
via `storage.raw.has()`. If any exists, this is a returning player from before
profiles existed:

- Mint **one** profile: id = `legacyProfileId`, name = `legacyProfileName`
  (default `PLAYER 1`), `playerId` minted, `created = Date.now()`.
- `seq = 1`, `lastUsed` = that id, active = that id, save.
- `firstBoot` stays `false`.

⛔ The pre-profile blobs themselves are **not copied, moved, or rewritten.**
`p0`'s stores *are* those keys, via §4.2.

### 5.4 Otherwise: genuinely empty install

- Mint nothing. Write nothing. Ask nobody.
- Roster empty, `current()` returns `null`, `firstBoot = true`.
- `activeId` is set to `legacyProfileId` so that any store touched before
  selection lands exactly where a pre-profile build would have put it, and an
  untouched machine cannot tell the difference.

**Boot selection is required.** The game must route off `firstBoot` to a
picker and must not start a run while `current()` is `null`. kit-profile does
not auto-create a profile.

The picker offers creating a named profile, or an **Anonymous** shortcut
(§8.3). Either path produces a profile with a `player_id`, so a first run is
always submittable.

### 5.5 Why the first profile gets id `p0`

`seq` starts at `0`, so the first `create()` on an empty install produces
`p0` — the legacy id — whose stores are the root scope. That is precisely
where an untouched machine would have written anyway, so the empty-install and
returning-player paths converge on one code path with no special case.

---

## 6. Roster operations

### 6.1 `create(name)`

Validate through `KitNames.validateName`. Refuse when: name invalid, name taken
(trimmed, case-insensitive), or `roster.length >= maxProfiles`.

Returns `{ ok, profile, reason }` with `reason` one of `'invalid_name'`,
`'name_taken'`, `'roster_full'`. Production returned bare `null` for all three;
a UI needs to say three different things.

Id is `'p' + seq`, then `seq++`. **Monotonic — never reused.** §4.3.

### 6.2 `remove(id)`

⛔ **Refuses the last profile.** An empty roster after first boot is the state
that produces a dead title screen.

Removing the **current** profile is allowed and — unlike production, which left
`activeId` naming a gone id for the caller to fix in the same act —
kit-profile immediately selects a replacement (`roster[0]` after removal) and
runs the full switch lifecycle (§7). Leaving the module in an invalid state
that only a disciplined caller repairs is not a contract worth exporting.

Stores are not cleared. §4.3.

### 6.3 `maxProfiles` — configurable, default 8

The component plan proposed `4`; Orbital Overhaul ships `PROFILE_MAX = 8`.
Resolved as configurable with a default of **8**, so OO passes nothing.

⛔ **Lowering `maxProfiles` must never delete profiles.** Production's `load()`
breaks out of its parse loop at `PROFILE_MAX`, so a roster of 6 read by a build
configured for 4 would silently lose two. Changed here:

- `load()` does **not** truncate to `maxProfiles`. It truncates only at a hard
  ceiling of **32** entries, purely to bound corrupt input.
- `create()` enforces `maxProfiles`.
- An over-capacity roster is loaded intact, saved back intact, and simply
  refuses new profiles until it drops below the limit.

---

## 7. The profile switch lifecycle

The most delicate part of the extraction. Production's `activate()` is correct
because of its **ordering**, and a single `change` event — as the component
plan sketched — destroys that, because a handler can't tell which side of the
switch it's on.

`select(id)` therefore fires two phases:

| Step | Who | State when it runs |
|---|---|---|
| 1 | `beforeChange` event | `activeId` is still the **outgoing** profile |
| 2 | kit-profile | `activeId` moves; `lastUsed` set; roster saved; `ensurePlayerId(id)` |
| 3 | `change` event | `activeId` is the **incoming** profile |

**`beforeChange`** is where the game flushes the outgoing profile at the key it
still owns — production's `saveSettings(); Achievements.save();`.

**`change`** is where the game resets its runtime to shipped defaults and
*then* loads the incoming profile over them.

`select()` returns `false` for an id not in the roster, firing nothing.
Selecting the already-current id is a no-op that fires nothing.

### 7.1 ⛔ What the game must do in `change`, preserved verbatim

kit-profile cannot enforce this, so it is documented in both this doc and the
client API doc. From production, and each item traceable to a real bug:

> Reset to shipped defaults **before** loading the incoming profile. Both
> loaders are written for a cold boot and are correct as they stand — the fix
> belongs on the caller's side, not in them. `loadSettings()` applies a saved
> blob over live state with no else-branch on most fields (that is what makes
> known-value-else-default work); `Achievements.init()` never clears
> `lifetime`, and `loadCounters()` copies only the keys a blob has.
>
> Without the reset, a switch hands the incoming profile the outgoing one's
> volumes, bindings, music track, voice, captions, auto-shield and debug knobs,
> plus its entire lifetime progress — and `deriveLifetime()` then re-derives
> that player's tier badges onto a stranger.
>
> **`game.stats` is a third bleed vector.** Reset only in `startGame()`, so at
> the title after a game it still holds that game's values. Two non-tiered
> lifetime achievements (`untouchable`, `max_haul`) read it directly rather
> than a lifetime counter, so an ungated switch awards the incoming profile
> those badges for a game it never played.
>
> **`game.wave` rides along** for the same reason: `untouchable`'s predicate is
> `game.wave >= 10 && !s.everBelowHalf`, and `game.wave` is a separate field
> also reset only in `startGame()`.
>
> **Nothing in the reset may write.** `returnToDefaults()` ends with
> `saveSettings()`, and the Reset-All-Debug menu row saves right after
> `resetAllDebug()`. Calling either here writes a defaults blob into a store —
> and *which* store depends on whether the switch has already happened, so it
> corrupts either the profile being left or the one being entered. Use the
> save-free `restoreDefaultBindings()`.

### 7.2 Title-only by construction

Production notes `activate()` is title-only (FORK-CS031-I), enforced by the
screen that calls it, not the function. kit-profile keeps that: `select()` does
not police when it is called, and the client API doc states the constraint.
It's why zeroing `game.wave` is safe — no live gameplay ever reads it there.

---

## 8. Names

### 8.1 Rules come from kit-names

`create()` and `rename()` validate through `KitNames.validateName`. kit-profile
holds no charset, no length, and no normalization of its own. See `kit-names.md`
for why, and for the kit-leaderboard v0.2.0 version bump this implies.

`nameTaken(name, exceptId)` compares **normalized** names case-insensitively,
with `exceptId` so `rename()` can ignore the profile it's renaming — carried
from production unchanged.

### 8.2 Existing names are preserved as-is, unflagged

Production's `cleanName` permits names the board will reject. On load, names go
through the **lenient** path only — trim, slice to `MAX_NAME_LENGTH`, skip if
empty — exactly as today. Strict validation applies to `create()` and
`rename()` only.

So a profile named `Gh0st!` loads intact and keeps working locally. kit-profile
does **not** flag it and does not surface a "needs fixing" bit.

⛔ It is **not** auto-normalized on load. Rewriting a player's chosen name
without asking is the destructive option, and §2.4 forbids it.

**Known consequence, accepted:** that profile's runs will be rejected by the
board with `NAME_REJECTED`, which kit-leaderboard does not queue — the score is
lost. A game that cares should check `KitNames.validateName(current().name).ok`
before offering to submit and prompt for a rename. That check is the game's to
make; the capability is exported, the policy is not kit-profile's.

### 8.3 Anonymous

`createAnonymous()` creates an **ordinary profile** named `anonymousName`
(default `ANONYMOUS`). Not a distinct type, no flag, fully renameable later.

Because `nameTaken` is case-insensitive, a device holds at most one profile by
that name — which is the right outcome, since two identically-named rows in a
picker are unusable. No special-casing needed to achieve it; if the name is
taken, `createAnonymous()` returns `{ ok: false, reason: 'name_taken' }` and
the UI should select the existing one.

It still gets a `player_id` on activation like any other profile, which is what
makes a first run submittable without demanding a name. §5.4.

### 8.4 `NAME_CHANGE_NOTICE`

`rename()` does not display anything — kit-profile renders nothing, ever. The
game must show `KitNames.NAME_CHANGE_NOTICE` before confirming a rename, with
the option to cancel. Re-exported as `KitProfile.NAME_CHANGE_NOTICE` for
convenience so the rename UI needs one import.

---

## 9. Satisfying kit-leaderboard's `getPlayer()`

The whole integration, with no change on the leaderboard side:

```js
const board = KitLeaderboard.create({
  /* ... */
  getPlayer: () => profiles.player()
});
```

`player()` returns `{ playerId, displayName }`, calling `ensurePlayerId` first
(§3.1). With no current profile it returns `{ playerId: null, displayName: '' }`
— mirroring production's `p ? p.playerId : null` and `nameOf()` returning `""`.

`getPlayer` is a function in kit-leaderboard's contract specifically so a
mid-session switch or rename is picked up without recreating the instance;
passing `profiles.player` this way is exactly what that was designed for.

⛔ The game must not start a submittable run while `current()` is `null` (§5.4).
A `null` `playerId` reaching the Worker is a payload rejection.

---

## 10. Events

`onEvent(name, detail)` — same shape as kit-storage and kit-leaderboard.

| Event | Fires when | `detail` |
|---|---|---|
| `ready` | end of `create()` | `{ firstBoot, count }` |
| `beforeChange` | §7 step 1 | `{ from, to }` |
| `change` | §7 step 3 | `{ from, to }` |
| `created` | a profile was added | `{ id, name }` |
| `renamed` | a rename succeeded | `{ id, from, to }` |
| `removed` | a profile was removed | `{ id }` |
| `minted` | a `player_id` was minted or backfilled | `{ id, backfill }` |
| `error` | a roster write failed to persist | `{ op, id }` |

⛔ `beforeChange` and `change` are **not** optional telemetry, unlike every
other event in the kit. A game that ignores them gets cross-profile bleed. The
client API doc says so in bold.

`minted` with `backfill: true` is worth logging in a debug build — it means a
profile predating `player_id` was just given one.

---

## 11. Configuration

```js
KitProfile.create({
  storage,                                  // required, kit-storage instance
  maxProfiles:       8,
  legacyProfileId:   'p0',
  legacyProfileName: 'PLAYER 1',
  legacyRosterKey:   'afd_profiles_v1',
  legacyProbeKeys:   ['afd_settings_v1', 'afd_achievements_v2'],
  anonymousName:     'ANONYMOUS',
  onEvent:           (name, detail) => {}
});
```

Every legacy field is Orbital-Overhaul-specific and defaulted to OO's real
values, so OO passes only `storage`. A new game passes `legacyProbeKeys: []`
and `legacyRosterKey: null` to skip §5.2–5.3 entirely.

Missing or non-object `storage` throws (programmer error, per kit-storage
§2.1). Everything else degrades.

---

## 12. Things a future session must not "fix"

- ⛔ **Don't restructure `ensurePlayerId`.** §3. Check-then-mint, immediate
  persist, called from every identity path.
- ⛔ **Don't mint in `create()` or `list()`.** §3.1.
- ⛔ **Don't clear a removed profile's stores.** §4.3. Monotonic `seq` is the
  guarantee that makes not-clearing safe.
- ⛔ **Don't reuse profile ids.** Same reason.
- ⛔ **Don't collapse `beforeChange`/`change` into one event.** §7.
- ⛔ **Don't move the switch reset list into kit-profile.** §2.3. It must stay
  in the game; only the seam is kit-profile's.
- ⛔ **Don't truncate the roster to `maxProfiles` on load.** §6.3.
- ⛔ **Don't auto-normalize existing names.** §8.2.
- ⛔ **Don't deduplicate board identity by display name.** §2.2. Multiple
  `ANONYMOUS` rows are correct.
- ⛔ **Don't delete or rewrite the legacy roster key or the pre-profile
  blobs.** §5.2, §5.3.
- ⛔ **Don't give kit-storage a "transparent scope" feature.** §4.2.
- ⛔ **Don't add achievements, scores, or settings here.** Separate modules.

---

## 13. Implementation checklist

1. `create(config)` — validate `storage`, declare the `profiles` key, run the
   §5 boot sequence, emit `ready`.
2. Defensive roster parse (§5.1) including the `seq` floor rule.
3. Legacy roster import via `storage.raw` (§5.2); legacy probe (§5.3).
4. `ensurePlayerId` verbatim from production, wired to all four call sites (§3.1).
5. `scopeFor(id)` legacy transparency (§4.2), exposed as `scope(id)`.
6. Roster ops with `{ ok, reason }` returns (§6); `remove()` auto-selecting a
   replacement.
7. Two-phase `select()` (§7).
8. Name ops delegating entirely to kit-names (§8); lenient load path preserved.
9. `player()` returning kit-leaderboard's `getPlayer()` shape (§9).
10. Events (§10); handler exceptions caught so they can't break a switch
    mid-sequence.

---

## 14. Test checklist

Run against a real browser with a real kit-storage instance, not a mock —
several of these are about persistence timing.

**`player_id` — the ones that matter most**

- Fresh profile: `player()` twice returns the **same** `playerId`.
- `playerId` survives a reload (create a new instance over the same storage).
- **Backfill:** hand-write a roster whose entry has no `playerId` key at all;
  boot; the id is minted, `minted` fires with `backfill: true`, and it is
  **persisted before any other save would have run** — assert by reading
  storage directly immediately after boot.
- Backfill fires via `select()` too, not just boot: two profiles, only the
  first with an id; switch to the second; it gets one.
- `playerId` is stable across rename, across a switch away and back, and
  across a *different* profile being removed.
- `list()` never mints — boot a roster of 3 idless profiles. Boot itself
  mints one, per §3.1's first call site ("boot, for the profile that ends up
  active"), so assert storage holds exactly the one `playerId` boot minted
  immediately afterward; then call `list()` and assert that count is
  unchanged — `list()` itself must add none.
- Two profiles have distinct `playerId`s.

**Boot paths**

- Empty install → `firstBoot: true`, empty roster, `current()` null, and
  **nothing written to storage** (assert `storage.keys()` is empty).
- First `create()` on an empty install produces id `p0` and its scope is the
  root store (§5.5) — write via `scope('p0')`, read via the root store, same key.
- Pre-profile install (`afd_settings_v1` present, no roster) → one profile,
  named `PLAYER 1`, id `p0`, `firstBoot: false`, and the probed blob is
  **byte-identical afterward**.
- Legacy roster import: `afd_profiles_v1` present, new key absent → imported,
  new key written, **legacy key unchanged**.
- Corrupt roster JSON → empty roster, no throw, stored bytes untouched.
- Roster with a duplicate id, a non-object entry, and an empty name → those
  entries skipped, the rest intact.
- `seq` floor: store `seq: 0` alongside a roster containing `p5` → next
  created id is `p6`, not `p1`.

**Roster ops**

- `create()` refusals return the three distinct reasons.
- Name taken is case-insensitive and trim-insensitive (`' ghost '` vs `GHOST`).
- `rename()` to a name held by another profile fails; to its own current name
  succeeds.
- `remove()` on the last profile fails.
- `remove()` on the current profile selects a replacement and fires the full
  two-phase lifecycle.
- Removed id is never reissued: create p0/p1, remove p1, create → `p2`.
- Removed profile's scoped data still readable via `scope('p1')` afterward.
- `maxProfiles: 4` over a stored roster of 6 → all 6 load, all 6 persist on the
  next save, `create()` refuses with `roster_full`.

**Switch lifecycle**

- `beforeChange` sees the outgoing id as `current()`; `change` sees the
  incoming. Assert inside the handlers.
- A write performed in `beforeChange` lands in the **outgoing** profile's scope.
- A write performed in `change` lands in the **incoming** profile's scope.
- `select()` on an unknown id returns `false` and fires nothing.
- `select()` on the current id is a no-op and fires nothing.
- A handler that throws does not leave `activeId` half-moved.

**Names**

- `create('Gh0st!')` fails `invalid_name`; a stored profile named `Gh0st!`
  loads intact and is **not** renamed.
- `createAnonymous()` twice → second returns `name_taken`.
- An anonymous profile can be renamed like any other.

**Degradation**

- Blocked storage: `create()` doesn't throw, profile creation works in-session,
  `player()` returns a usable id, nothing survives reload.
- Blocked storage: `ensurePlayerId`'s immediate save returning `false` does not
  prevent the id being used for the rest of the session.

**Integration**

- `KitLeaderboard.create({ getPlayer: () => profiles.player() })` submits
  successfully with **no modification to kit-leaderboard**.
- A rename mid-session is picked up by the next `submit()` without recreating
  the leaderboard instance.
- With no profile selected, `player()` returns `{ playerId: null, displayName: '' }`.