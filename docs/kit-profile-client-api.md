# kit-profile — Client Module API

**Module:** `kit-profile`
**Part of:** coinless-kit
**Tag:** v0.1.0
**Depends on:** `kit-storage` (instance injected), `kit-names`
**Talks to:** nothing — local only, no server, no network
**Scope:** local player identity. `player_id`, display name, the profile roster.

> The contract below is what a game reads. A game should never need to read
> this module's source. Design rationale and the implementation contract live
> in `kit-profile-spec.md`.

---

## Contract summary

kit-profile owns who the player is on this device: a stable `player_id` per
profile, a display name, and the roster. It persists through a kit-storage
instance you hand it and validates names through kit-names.

It renders nothing, knows nothing about settings or achievements or scores, and
never touches the network.

Two facts shape the whole API:

- **`player_id` is minted once per profile and never regenerated.** It's what
  the leaderboard deduplicates on. Regenerating it splits one player's history
  into two identities that can never be merged, and it fails silently.
- **`player_id` and display name are different things.** Names are mutable and
  copied onto each submitted run; old board rows keep the name they were
  submitted with. Renaming never fragments history, and two players may share a
  display name.

---

## Creating an instance

```js
import * as KitStorage from './kit-storage.js';
import * as KitProfile from './kit-profile.js';

const storage  = KitStorage.create({ gameId: 'orbital-overhaul' });
const profiles = KitProfile.create({ storage });
```

Full configuration, all optional except `storage`:

```js
KitProfile.create({
  storage,                                  // required

  maxProfiles:       8,
  anonymousName:     'ANONYMOUS',

  // Legacy migration — defaults are Orbital Overhaul's real values.
  // A new game passes legacyRosterKey: null and legacyProbeKeys: []
  legacyProfileId:   'p0',
  legacyProfileName: 'PLAYER 1',
  legacyRosterKey:   'afd_profiles_v1',
  legacyProbeKeys:   ['afd_settings_v1', 'afd_achievements_v2'],

  onEvent: (name, detail) => {}
});
```

```js
profiles.firstBoot   // true only on a genuinely empty install
```

---

## Boot: selection is required

kit-profile **never auto-creates a profile.** On a genuinely empty install it
mints nothing, writes nothing, and leaves `current()` as `null` with
`firstBoot === true`.

Your title screen routes off `firstBoot` to a picker offering two paths:

```js
profiles.create('GHOST');     // named
profiles.createAnonymous();   // "just let me play"
```

Both produce a real profile with a real `player_id`, so a first run is always
submittable.

**Don't start a submittable run while `current()` is `null`.** A null
`playerId` reaching the leaderboard Worker is a payload rejection.

Returning players never see this: an existing roster loads, and a machine
holding pre-profile save data gets one profile minted over it automatically,
with its existing settings and achievements intact and unmoved.

---

## Identity

### `profiles.current() -> { id, name, playerId } | null`

The active profile, or `null` before selection on first boot.

### `profiles.player() -> { playerId, displayName }`

Exactly kit-leaderboard's `getPlayer()` shape. Returns
`{ playerId: null, displayName: '' }` when there's no current profile.

```js
const board = KitLeaderboard.create({
  endpoint:    'https://scores.coinlessgames.com',
  gameId:      'orbital-overhaul',
  gameVersion: '1.0.0.30',
  getPlayer:   () => profiles.player()
});
```

That's the entire integration — **no changes on the leaderboard side.**
`getPlayer` is a function in that contract precisely so a mid-session switch or
rename is picked up without recreating the instance, which is what passing
`profiles.player` gets you.

Both methods mint the `player_id` if it's somehow absent, so you can't read
identity and get nothing back.

---

## The roster

### `profiles.list() -> [{ id, name, created }]`

Every profile, in roster order. **Deliberately omits `playerId`** — a picker
doesn't need it, and exposing it here would tie identity creation to a UI event.

### `profiles.create(name) -> { ok, profile, reason }`
### `profiles.createAnonymous() -> { ok, profile, reason }`

`reason` is `'invalid_name'`, `'name_taken'`, or `'roster_full'` — three
different things a UI should say differently.

Anonymous profiles are ordinary profiles with a default name. No flag, no
special type, renameable like any other. Because names are compared
case-insensitively, a device holds at most one — if `createAnonymous()` returns
`name_taken`, select the existing one.

### `profiles.rename(id, name) -> { ok, reason }`

**Show `KitProfile.NAME_CHANGE_NOTICE` before confirming, with the option to
cancel.** Old board entries keep the name they were submitted with, and a
player who renames themselves will see both names on the board.

### `profiles.remove(id) -> { ok, reason }`

Refuses the **last** profile (`reason: 'last_profile'`) — an empty roster after
first boot is a dead title screen.

Removing the current profile is fine: kit-profile selects a replacement and
runs the full switch lifecycle for you.

**The removed profile's stored data is not deleted.** Profile ids are never
reused, so nothing can inherit it. If you ever want a real "delete my data"
feature, make it a separate confirmed action — not a side effect of removing a
roster row.

### `profiles.scope(id?) -> store`

A kit-storage scope for that profile, defaulting to the current one. Use it for
anything per-profile — settings, achievements, local scores:

```js
const s = profiles.scope();
s.set('settings', settings);
```

---

## Switching profiles: the part you must not skip

`profiles.select(id) -> boolean`

Returns `false` for an unknown id. Selecting the already-current profile is a
no-op.

**`select()` fires two events, and handling both is mandatory.** Unlike every
other event in the kit, these aren't optional telemetry — a game that ignores
them gets cross-profile data bleed.

| Event | State when it fires | What you do |
|---|---|---|
| `beforeChange` | `current()` is still the **outgoing** profile | Flush the outgoing profile |
| `change` | `current()` is the **incoming** profile | Reset to defaults, **then** load |

```js
onEvent: (name) => {
  if (name === 'beforeChange') {
    saveSettings();
    Achievements.save();
  }
  if (name === 'change') {
    // 1. reset to SHIPPED defaults
    Object.assign(settings, SETTINGS_DEFAULTS);
    Object.assign(AudioSys.vol, AUDIO_VOL_DEFAULTS);
    restoreDefaultBindings();      // save-free variant, see below
    resetAllDebug();
    game.stats = resetGameStats();
    game.wave  = 0;
    for (const k in Achievements.lifetime) Achievements.lifetime[k] = 0;

    // 2. NOW load the incoming profile over those defaults
    loadSettings();
    Achievements.load();
  }
}
```

Two phases exist because a single `change` event can't tell a handler which
side of the switch it's on, and both sides need work done at the right moment.

### Why the reset list is that long

Every item on it is a real bug that was found and fixed, not defensive
boilerplate:

- **Settings, volumes, bindings, debug state.** Your loaders are written for a
  cold boot and apply a saved blob *over* live state with no else-branch on
  most fields — which is exactly what makes known-value-else-default work.
  Don't add else-branches to them; reset before loading instead.
- **Lifetime achievement counters.** `Achievements.init()` doesn't clear
  `lifetime`, and `loadCounters()` copies only the keys a blob has — so without
  a reset, `deriveLifetime()` re-derives one player's tier badges onto another.
- **`game.stats` and `game.wave`.** Both are reset only in `startGame()`, so at
  the title after a game they still hold that game's values. Two non-tiered
  achievements read them directly rather than from a lifetime counter, which
  awards the incoming profile badges for a game it never played.

⛔ **Nothing in the reset may write to storage.** `returnToDefaults()` ends with
`saveSettings()`, and the Reset-All-Debug menu row saves right after
`resetAllDebug()`. Calling either here writes a defaults blob into a store —
and *which* store depends on whether the switch already happened, so it
corrupts either the profile you're leaving or the one you're entering. Use the
save-free `restoreDefaultBindings()`.

### Call `select()` from the title screen only

kit-profile doesn't police this; the screen that offers the switch does.
Zeroing `game.wave` in the handler is only safe because no live gameplay ever
reads it there.

---

## Names

Rules come from kit-names and are shared with the leaderboard: 1–12 characters,
`A-Z 0-9 space - _`, uppercased, internal whitespace collapsed, no Unicode.
kit-profile holds no rules of its own, which is what keeps local names and
board names from drifting apart.

```js
KitProfile.NAME_CHANGE_NOTICE   // re-exported from kit-names
```

### Existing names are left exactly as they are

A profile stored under older rules — `Gh0st!` — loads intact and keeps working.
kit-profile does not rename it, normalize it, or flag it.

**That name will be rejected by the board**, and `NAME_REJECTED` is not queued
by kit-leaderboard, so the run's score is lost. If you care, check before
offering to submit:

```js
import * as KitNames from './kit-names.js';

if (!KitNames.validateName(profiles.current().name).ok) {
  // prompt for a rename before the run, or before the submit
}
```

That check is yours to make. kit-profile exports the capability and takes no
position on the policy — silently rewriting a player's chosen name is worse
than letting you decide when to ask.

---

## Events

```js
onEvent: (name, detail) => {}
```

| Event | `detail` |
|---|---|
| `ready` | `{ firstBoot, count }` |
| **`beforeChange`** | `{ from, to }` — **must be handled** |
| **`change`** | `{ from, to }` — **must be handled** |
| `created` | `{ id, name }` |
| `renamed` | `{ id, from, to }` |
| `removed` | `{ id }` |
| `minted` | `{ id, backfill }` |
| `error` | `{ op, id }` |

Everything except `beforeChange` and `change` is optional telemetry. A handler
that throws won't break a switch mid-sequence.

`minted` with `backfill: true` means a profile that predated `player_id` just
got one — worth logging in a debug build.

---

## What this module deliberately does not do

- **Regenerate `player_id`.** Ever, under any circumstance.
- **Reset your game state on a switch.** It gives you the two seams; the reset
  list stays in your code, because kit-profile can't know your state exists.
- **Delete a removed profile's stored data.** Ids are never reused, so it's
  inert — and deleting it should be an explicit choice, not a side effect.
- **Auto-create a profile at boot.** Selection is required.
- **Own name rules.** Those live in kit-names, shared with the leaderboard.
- **Render anything, or touch the DOM.**
- **Anything with achievements, settings, or local scores.** Separate modules;
  `scope()` is what they persist through.

---

## Integration checklist for a game

1. `KitStorage.create()` first, then `KitProfile.create({ storage })`, before
   anything reads persisted state.
2. Route the title screen off `firstBoot` to a picker; offer both a named
   profile and Anonymous.
3. Don't start a submittable run while `current()` is `null`.
4. Pass `getPlayer: () => profiles.player()` to kit-leaderboard. Nothing else.
5. Handle `beforeChange` (flush outgoing) and `change` (reset, **then** load).
   Both. Nothing in the reset may write.
6. Offer profile switching from the title screen only.
7. Show `KitProfile.NAME_CHANGE_NOTICE` in the rename flow, before
   confirmation, with a cancel option.
8. Persist everything per-profile through `profiles.scope()`.
9. Optionally check `KitNames.validateName(current().name).ok` before offering
   to submit a score.