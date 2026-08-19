# Orbital Overhaul — the `player_id` / `Profiles` extraction source

**What this is:** a frozen, verbatim snapshot of the production code
`kit-profile` was extracted from. **Not a contract, not a spec, and not code
that runs, builds or ships from this repo.** Nothing here is imported by
anything; it exists so a session implementing `kit-profile` can read the
original without needing the game repo checked out.

**Source:** `ADD-Orbital-Overhaul/orbital-overhaul.html` — a separate repo,
one self-contained HTML file.
**Snapshot taken:** 2026-08-19, at commit `70518af`, `GAME_VERSION` `1.0.0.36`.
**Line ranges quoted:** 4930–5184 (§2), 5553–5555 (§3), 8836–8850 (§4),
5453–5471 (§5).

**Read with:** `docs/kit-profile-spec.md` (the implementation contract) and
`docs/kit-profile-client-api.md` (what a game reads). Where those two and this
file disagree, **the spec wins** — it is the deliberate output of a design
conversation, and §6 below lists every place it departs from this source on
purpose.

---

## 0. Why a snapshot rather than a summary

The repo rule is that no game code lives here. This file is the narrow,
deliberate exception the phase plan called for
(`dev-notes/Implementation-notes-03-kit-profile.md`, Phase 1's read list), and
it stays inside that rule by being **documentation of an origin, not a
component**: no module imports it, no build step sees it, and nothing in
`modules/` or `services/` depends on a line of it.

It is quoted verbatim rather than described because the whole risk in this
extraction runs one direction. `kit-profile` is small code whose danger is a
session deciding it can improve on production code that is already correct —
`kit-profile-spec.md` §12 lists twelve things that must not be "fixed," and
several of them read like obvious cleanups. A paraphrase would quietly drop
the comments that explain *why* each one is the way it is, which is precisely
the load-bearing part. The production comments below name the real bugs
(`FLAG-CS031-d`, `FLAG-CS031-e`, `FORK-CS031-I`) that each decision came from.

⛔ **This file is frozen.** It records what production looked like at the
snapshot above. If Orbital Overhaul's `Profiles` changes later, that does not
retroactively make this file wrong — it makes it a record of an older
baseline, and the fix is a new snapshot with a new date, not an edit in place.
`kit-profile`'s behaviour is governed by its spec, never by this file.

---

## 1. Where each piece sits in production

| Piece | What it is |
|---|---|
| `PROFILES_KEY = "afd_profiles_v1"` | the roster's own `localStorage` key, added by CS031 — not one of the three frozen pre-profile keys |
| `PROFILE_LEGACY = "p0"` | the id whose stores **are** the pre-profile keys |
| `PROFILE_LEGACY_PROBE` | the two pre-profile keys `init()` probes to tell a returning player from an empty install |
| `PROFILE_MAX = 8` | roster cap — the source of `kit-profile`'s `maxProfiles` default |
| `PROFILE_NAME_MAX = 12` | characters, after trimming — now `kit-names`' `MAX_NAME_LENGTH` |
| `Profiles` | the object being extracted (§2) |
| `storageOK()` | the guard every method routes through; `kit-storage` replaces it (§3) |
| `Leaderboard.instance()` | the `getPlayer()` wiring `kit-profile.player()` must satisfy (§4) |
| `profileDelete()` | caller-side repair after `remove()`, which `kit-profile` absorbs (§5) |

`Profiles.init()` is called once at boot, immediately above `loadSettings()` —
the first thing in the build that asks `keyFor()` for a key.

---

## 2. `Profiles`, verbatim

Including the two shipped-default snapshots (`SETTINGS_DEFAULTS`,
`AUDIO_VOL_DEFAULTS`) that `activate()`'s step 3 reads, because the reset list
in `kit-profile-spec.md` §7.1 is about exactly those and makes little sense
without them. ⛔ Those two, and everything they touch, stay in the **game** —
`kit-profile` provides the seams and never the reset (spec §2.3, §12).

```js
// ---------- Player Profiles (CS031 P1) ----------
// A roster of named players layered OVER the existing stores rather than beside them. The active
// profile picks the key every per-profile store reads and writes, through the one keyFor() below.
//
// ⛔ THE LEGACY PROFILE'S STORES *ARE* THE FROZEN KEYS. "p0" gets `afd_settings_v1` verbatim; every
//    other profile gets `afd_settings_v1:pN`. Nothing is copied, moved or rewritten when a returning
//    player is migrated — their data simply stays exactly where it has always been, which is what
//    keeps the frozen-key invariant true rather than merely honoured.
// ⛔ THE ROSTER IS AN EXPLICIT KEY. localStorage is NEVER enumerated — no key(i), no .length, no
//    Object.keys. The origin is shared with anything else served from the same path, and the
//    headless harness's stub has no enumeration at all.
// ⛔ init() RUNS AT BOOT, ABOVE loadSettings(), AND MUST NOT TOUCH `Achievements` — that module is
//    defined ~2500 lines below and reading it from here is a TDZ throw. It needs only storageOK(),
//    which is a hoisted function declaration and so is callable from above its own definition.
// Roster ops (add / remove / rename) are roster-only: no settings write, no achievement touch, no
// switch. The runtime switch — flush, reset to shipped defaults, reload — is activate(), CS031 P2.
const PROFILES_KEY     = "afd_profiles_v1";   // NEW key, owned by CS031 — not one of the three frozen ones
const PROFILE_LEGACY   = "p0";                // the id whose stores ARE the frozen keys
const PROFILE_MAX      = 8;                   // roster cap
const PROFILE_NAME_MAX = 12;                  // characters, measured after trimming
// The pre-profile stores init() probes to tell a returning player from an empty install. LITERALS on
// purpose: Achievements.STORAGE_KEY is unreachable from here (TDZ, above), and both strings are
// frozen by rule, so a literal cannot drift out of step with the symbol it duplicates.
const PROFILE_LEGACY_PROBE = ["afd_settings_v1", "afd_achievements_v2"];

// CS031 P2 — PRISTINE SNAPSHOTS of the two shipped-default tables activate() restores. Same idiom, and
// the same reason, as DEFAULT_BINDINGS (L2828): capture the literal's own values ONCE, before anything
// has applied a player's save over them, so the reset has a source of truth to read rather than a
// retyped constant that drifts. ⛔ THEIR PLACEMENT IS THE INVARIANT: below every literal they copy
// (AudioSys L1176, settings L3275) and ABOVE loadSettings()'s boot call below — the first thing in the
// build that writes either. Nothing between those points mutates them. test-cs031-p2.js §B pins that
// non-vacuously, by seeding a store and checking these still hold the shipped values.
// Every field in both is a primitive, so the spread IS a deep copy.
const SETTINGS_DEFAULTS  = { ...settings };
const AUDIO_VOL_DEFAULTS = { ...AudioSys.vol };

const Profiles = {
  activeId: PROFILE_LEGACY,   // ⛔ defaults to the legacy id, so a build that never loads a roster keys
                              // every store exactly where every pre-profile build did
  roster: [],                 // [{ id, name, created, playerId }] — an OBJECT per entry, so a later
                              // changeset can add fields (CS033 added playerId this way)
  lastUsed: "",               // the id to re-activate at the next boot ("" = none recorded)
  seq: 0,                     // next numeric suffix to mint. Monotonic on purpose: a removed profile's
                              // id is never handed out again, because its stores are not cleared with it
  firstBoot: false,           // set ONLY on a genuinely empty install — the title screen routes off it

  // The one key router. Every per-profile store asks through this and nothing else.
  keyFor(base) { return this.activeId === PROFILE_LEGACY ? base : base + ":" + this.activeId; },

  byId(id) { return this.roster.find(p => p.id === id) || null; },
  nameOf(id) { const p = this.byId(id); return p ? p.name : ""; },
  // player_id (CS033): minted once, the first time a profile is actually ACTIVATED — never at add()
  // time, and never re-minted once set. A profile loaded from a pre-CS033 save has no playerId either,
  // so this is also the backfill path: the same lazy mint fires the first time that old profile is
  // next touched, here, at init() or activate(). Persists immediately so the mint can't be lost to a
  // crash before the next save() would otherwise have happened.
  ensurePlayerId(id) {
    const p = this.byId(id);
    if (p && !p.playerId) { p.playerId = crypto.randomUUID(); this.save(); }
    return p ? p.playerId : null;
  },

  // Trim + cap. Returns "" for anything unusable, which is what every caller tests.
  cleanName(name) { return typeof name === "string" ? name.trim().slice(0, PROFILE_NAME_MAX) : ""; },
  // Trimmed and case-insensitive (spec §4.5). `exceptId` lets rename() ignore the profile it is renaming.
  nameTaken(name, exceptId) {
    const n = this.cleanName(name).toLowerCase();
    if (!n) return false;
    return this.roster.some(p => p.id !== exceptId && p.name.toLowerCase() === n);
  },

  // --- Roster ops. They persist the roster and NOTHING else. ---
  // Returns the new entry, or null if the name is empty/duplicate or the roster is full.
  add(name) {
    const n = this.cleanName(name);
    if (!n || this.roster.length >= PROFILE_MAX || this.nameTaken(n)) return null;
    const p = { id: "p" + this.seq, name: n, created: Date.now() };
    this.seq++;
    this.roster.push(p);
    this.save();
    return p;
  },
  // ⛔ Refuses the LAST profile: an empty roster after first boot is the state that produces a dead
  // title screen. Removing the ACTIVE profile is allowed and leaves activeId naming a gone id — the
  // caller must activate() another in the same act (spec §4.5).
  remove(id) {
    if (this.roster.length <= 1) return false;
    const i = this.roster.findIndex(p => p.id === id);
    if (i < 0) return false;
    this.roster.splice(i, 1);
    if (this.lastUsed === id) this.lastUsed = "";
    this.save();
    return true;
  },
  rename(id, name) {
    const p = this.byId(id);
    const n = this.cleanName(name);
    if (!p || !n || this.nameTaken(n, id)) return false;
    p.name = n;
    this.save();
    return true;
  },

  // --- Persistence (own key; the same guarded idiom as saveSettings — never crash on storage failure). ---
  save() {
    const ls = storageOK(); if (!ls) return;
    try {
      ls.setItem(PROFILES_KEY, JSON.stringify({ v: 1, lastUsed: this.lastUsed, seq: this.seq,
        profiles: this.roster.map(p => ({ id: p.id, name: p.name, created: p.created,
          playerId: p.playerId || null })) }));
    } catch (e) { /* quota / privacy mode / disabled — ignore */ }
  },
  // known-value-else-default on every field. Returns TRUE only when a usable, non-empty roster came
  // back; absent, unreadable, corrupt and empty all answer false and leave the roster empty, which is
  // the single signal init() branches on.
  load() {
    this.roster = []; this.lastUsed = ""; this.seq = 0;
    const ls = storageOK(); if (!ls) return false;
    try {
      const raw = ls.getItem(PROFILES_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.profiles)) return false;
      const list = [], seen = new Set();
      for (const p of data.profiles) {
        if (list.length >= PROFILE_MAX) break;
        if (!p || typeof p.id !== "string" || !p.id || seen.has(p.id)) continue;
        const name = this.cleanName(p.name);
        if (!name) continue;
        seen.add(p.id);
        // known-value-else-default: a pre-CS033 blob simply has no playerId key, which parses to
        // undefined here and falls through to null — the exact state ensurePlayerId() treats as unset.
        list.push({ id: p.id, name, created: typeof p.created === "number" ? p.created : 0,
          playerId: typeof p.playerId === "string" && p.playerId ? p.playerId : null });
      }
      // seq never drops BELOW what the roster already uses, however the stored value was edited.
      let seq = 0;
      for (const p of list) { const m = /^p(\d+)$/.exec(p.id); if (m) seq = Math.max(seq, Number(m[1]) + 1); }
      if (Number.isFinite(data.seq) && data.seq > seq) seq = Math.floor(data.seq);
      this.roster = list;
      this.lastUsed = typeof data.lastUsed === "string" ? data.lastUsed : "";
      this.seq = seq;
      return list.length > 0;
    } catch (e) {
      this.roster = []; this.lastUsed = ""; this.seq = 0;   // corrupt / unreadable — no roster, don't crash
      return false;
    }
  },
  // Boot, called ONCE immediately above loadSettings() — the first thing that asks keyFor().
  init() {
    this.firstBoot = false;
    if (this.load()) {
      this.activeId = this.byId(this.lastUsed) ? this.lastUsed : this.roster[0].id;
      this.lastUsed = this.activeId;
      this.ensurePlayerId(this.activeId);   // backfill: this boot's profile may predate playerId
      return;
    }
    // No usable roster. A machine already holding pre-profile save data gets ONE profile minted over
    // it — ⛔ the blobs themselves are NOT copied, moved or rewritten; p0's stores ARE those keys.
    const ls = storageOK();
    let legacy = false;
    if (ls) {
      try { for (const k of PROFILE_LEGACY_PROBE) if (ls.getItem(k) !== null) legacy = true; }
      catch (e) { legacy = false; }
    }
    this.activeId = PROFILE_LEGACY;
    if (legacy) {
      this.roster = [{ id: PROFILE_LEGACY, name: "PLAYER 1", created: Date.now(), playerId: crypto.randomUUID() }];
      this.seq = 1;
      this.lastUsed = PROFILE_LEGACY;
      this.save();
      return;
    }
    // A genuinely empty install: mint NOTHING and ask nobody here. The title screen routes off this
    // flag (CS031 P5); until then activeId is the legacy id, so this build stores exactly where the
    // pre-profile build did and an untouched machine cannot tell the difference.
    this.firstBoot = true;
  },

  // --- The runtime switch (CS031 P2, spec §4.3). Returns false for an id the roster does not hold. ---
  // Title-only by design (FORK-I); the SCREEN that calls this enforces that, not this function.
  //
  // ⛔ RESET, THEN LOAD — never load alone. Both loaders are written for a COLD boot and are CORRECT AS
  // THEY STAND; the fix belongs on this side of the call, not in them:
  //   * loadSettings() applies a saved blob OVER the live state with NO else-branch on seven of its
  //     eight fields (spec §2.2) — that is exactly what makes the standing known-value-else-default rule
  //     work, so an unknown or absent key leaves the runtime default in place and a removed field needs
  //     no migration shim. ⛔ Do not add else-branches to it.
  //   * Achievements.init() clears three collections but never `lifetime`, and loadCounters() copies
  //     only the keys a blob HAS (spec §2.3) — shared by the v2 load and the v1 migration by design.
  //     ⛔ Do not restructure it.
  // Without step 3, a switch therefore hands the incoming profile the OUTGOING one's volumes, bindings,
  // music track, voice, captions, auto-shield and debug knobs, plus its entire lifetime progress — and
  // deriveLifetime() then silently re-derives that player's tier badges onto a stranger.
  //
  // ⛔ game.stats IS A THIRD BLEED VECTOR, closed here (CS031 P5, FLAG-CS031-d). It is reset only in
  // startGame(), so at the title after a game it still holds that game's values; two non-tiered lifetime
  // achievements (untouchable, max_haul) read it directly rather than a lifetime counter, so an ungated
  // switch hands the incoming profile THOSE two badges via deriveLifetime() below, earned by a game it
  // never played. Same fix shape as step 3's other resets: a fresh resetGameStats(), no write.
  // ⛔ game.wave RIDES ALONG for the same reason: untouchable's own predicate is `game.wave >= 10 &&
  // !s.everBelowHalf`, and game.wave is a SEPARATE field also reset only in startGame() — a
  // resetGameStats() alone still leaves a post-wave-10 game's wave number sitting on game.wave at the
  // title, which alone satisfies half of that predicate regardless of the stats reset. Safe to zero
  // here: activate() is title-only by construction (FORK-CS031-I), so no live gameplay ever reads it.
  //
  // ⛔ NOTHING IN STEP 3 MAY WRITE. returnToDefaults() ends with saveSettings(), and the Reset-All-Debug
  // menu row calls saveSettings() right after resetAllDebug(). Calling either of those consumers here
  // writes a defaults blob into a store — and WHICH store depends on whether step 2 has already run, so
  // it corrupts either the profile being left or the one being entered. The bindings half is therefore
  // called through restoreDefaultBindings(), the save-free function returnToDefaults() was factored
  // into; resetAllDebug() was already save-free and its menu caller keeps its own save.
  activate(id) {
    if (!this.byId(id)) return false;

    // 1. Flush the OUTGOING profile at the key it still owns — activeId does not move until step 2.
    //    (Achievements.save() is a no-op during a debug run, by its own standing gate. Correct: a debug
    //    run must not persist progress, and abandoning one by switching profiles is no exception.)
    saveSettings();
    Achievements.save();

    // 2. The switch itself, plus the roster write that makes it the next boot's profile.
    this.activeId = id;
    this.lastUsed = id;
    this.save();
    this.ensurePlayerId(id);   // backfill: a profile switched TO for the first time may predate playerId

    // 3. Reset the runtime to its SHIPPED defaults — every one derived from its single source of truth.
    Object.assign(settings, SETTINGS_DEFAULTS);
    Object.assign(AudioSys.vol, AUDIO_VOL_DEFAULTS);
    restoreDefaultBindings();
    resetAllDebug();
    game.stats = resetGameStats();   // CS031 P5 (FLAG-CS031-d): the outgoing game's per-game flags must
                                      // not survive to be re-read by the incoming profile's deriveLifetime()
    game.wave = 0;                   // ...and neither does the wave number untouchable's predicate reads
    // Every lifetime counter ships at 0, SUM and MAX alike, so the literal's own KEY SET is the source
    // of truth here and no default is retyped.
    for (const k in Achievements.lifetime) Achievements.lifetime[k] = 0;

    // 4-5. Now load the incoming profile OVER those defaults — precisely what both contracts assume.
    loadSettings();
    Achievements.init();

    // 6. Push the result to the two LIVE runtime shadows that neither loader moves, or the incoming
    //    player hears the outgoing player's mix in the outgoing player's voice. The four gain nodes hold
    //    their own value (only setVol writes them) and VOICE_PARAMS is a live binding only setStyle()
    //    re-points. loadSettings() does call setStyle — but ONLY after `if (!raw) return`, so it never
    //    runs for a profile with no saved blob, which is EVERY newly created one. At boot neither shadow
    //    exists yet (no audio graph until the first keypress), which is why the cold path has never
    //    needed this; both calls are inert without an AudioContext, so this stays headless-safe.
    for (const c of Object.keys(AudioSys.vol)) AudioSys.setVol(c, AudioSys.vol[c]);
    VoiceSys.setStyle(settings.voiceStyle);
    return true;
  }
};
```

---

## 3. `storageOK()`

Every read and write above routes through this. `kit-profile` has no
equivalent and never will: it is handed a `kit-storage` instance and persists
through that, which is what `kit-storage`'s availability probe, memory shim and
quota classification replace (`kit-storage-client-api.md`).

```js
function storageOK() {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (e) { return null; }
}
```

⛔ Note what `save()` and `load()` do with a failure: **swallow it silently.**
That is correct in a build where a background write nobody is watching must
never crash the game. `kit-profile` keeps the never-crash half and drops the
silence — a roster write that fails to persist fires the `error` event
(spec §10), because a module that owns identity should be able to tell its
caller that identity did not reach disk.

---

## 4. The `getPlayer()` contract to satisfy

This is the whole reason `kit-profile` exists in the shape it does. The
extraction succeeds when this wiring collapses to
`getPlayer: () => profiles.player()` with **no change on the leaderboard
side** (spec §9).

```js
  instance() {
    if (this.board) return this.board;
    if (!leaderboardModuleAvailable()) return null;
    this.board = window.KitLeaderboard.create({
      endpoint: LEADERBOARD_ENDPOINT,
      gameId: "orbital-overhaul",
      gameVersion: GAME_VERSION,
      getPlayer: () => {
        Profiles.ensurePlayerId(Profiles.activeId);   // belt-and-suspenders: CS033 P1 already guarantees this
        const p = Profiles.byId(Profiles.activeId);
        return { playerId: p ? p.playerId : null, displayName: Profiles.nameOf(Profiles.activeId) };
      },
    });
    return this.board;
  },
```

Two details worth keeping:

- `getPlayer` is a **function** in `kit-leaderboard`'s contract precisely so a
  mid-session switch or rename is picked up without recreating the instance.
- The `ensurePlayerId` call here is belt-and-suspenders — CS033 already
  guarantees it. `kit-profile` makes that structural instead: `player()` mints
  itself, so the game never has to remember to (spec §3.1).

---

## 5. The caller-side repair `kit-profile` absorbs

Production's `Profiles.remove()` deliberately leaves `activeId` naming a gone
id, and requires the caller to switch away **first** — `FLAG-CS031-e` is the
bug that happens when it doesn't:

```js
    ls.removeItem(SAVES_KEY + ":" + id);
  } catch (e) { /* quota / privacy mode / disabled — ignore, same as every other guarded store op */ }
}
// The roster-shrinking half of Delete (spec §4.5). Order matters: the active profile is switched away
// from BEFORE Profiles.remove() drops it from the roster, or activeId is left dangling at a profile
// the roster no longer names (FLAG-CS031-e). The last-remaining guard is re-checked here too, so the
// store-clearing work below never runs for a refusal.
function profileDelete(id) {
  if (Profiles.roster.length <= 1 || !Profiles.byId(id)) return false;
  const keepActive = Profiles.activeId === id
    ? Profiles.roster.find(p => p.id !== id).id
    : Profiles.activeId;
  if (id === PROFILE_LEGACY) blankLegacyStores(keepActive);
  else {
    if (Profiles.activeId === id) Profiles.activate(keepActive);
    removeProfileStores(id);
  }
  return Profiles.remove(id);
}
```

⛔ `kit-profile` changes this on purpose (spec §6.2): `remove()` selects a
replacement itself and runs the full switch lifecycle. Exporting a contract
that leaves the module in an invalid state only a disciplined caller repairs
is not worth the flexibility.

⛔ **But it does not absorb `removeProfileStores()`.** Production deletes a
removed profile's stores; `kit-profile` deliberately does not (spec §4.3,
§12). Monotonic `seq` is what makes not-clearing safe, and
`scope.clear({ deep: true })` existing in `kit-storage` makes deleting a
tempting one-liner. Don't. Read §4.3 before touching this.

---

## 6. Production → `kit-profile`

Carried forward **unchanged** — do not re-derive any of these:

| Carried | Where |
|---|---|
| `ensurePlayerId`'s three lines: check-then-mint, immediate persist | spec §3, §12 |
| the defensive `load()` parse, field by field, known-value-else-default | spec §5.1 |
| the `seq` floor rule — `max(storedSeq, max(suffix) + 1)` | spec §5.1 |
| monotonic ids; a removed id is never reissued | spec §4.3 |
| a removed profile's stores are **not** cleared | spec §4.3 |
| `remove()` refuses the last profile | spec §6.2 |
| `nameTaken(name, exceptId)` — trimmed, case-insensitive | spec §8.1 |
| the lenient load-time name path (trim + cap, nothing else) | spec §8.2 |
| the legacy probe, and `PROFILE_LEGACY` store transparency | spec §5.3, §4.2 |
| `activate()`'s ordering: flush → switch → reset → load | spec §7 |
| the reset list itself, quoted into the docs but living in the game | spec §7.1 |

Changed **deliberately** — the spec, not this file, is authoritative on each:

| Changed | Why | Where |
|---|---|---|
| `ensurePlayerId` gains call sites: boot, `select()`, `current()`, `player()` | check-then-mint is idempotent, so more sites can only shrink the window with no id | spec §3.1 |
| ...but **not** `list()` or `create()` | minting eight UUIDs because a player opened a picker ties identity creation to a UI event | spec §3.1 |
| `load()` no longer truncates to the roster cap; hard ceiling of 32 instead | production breaks at `PROFILE_MAX`, so a roster of 6 read by a build configured for 4 silently loses two | spec §6.3 |
| `activate()` → `select()` fires **two** events | one `change` handler cannot tell which side of the switch it is on | spec §7, §12 |
| `add()`/`rename()`/`remove()` return `{ ok, reason }` | production returned bare `null` for three different refusals; a UI needs to say three different things | spec §6 |
| `remove()` on the current profile auto-selects a replacement | see §5 above | spec §6.2 |
| name rules move to `kit-names` | `cleanName` permits names the board rejects; this is the fourth copy of the rules and the one that still diverges | `kit-names.md` |
| the roster blob's internal `"v": 1` is dropped | `kit-storage`'s envelope carries the version now | spec §4.1 |
| `PROFILE_MAX` becomes configurable `maxProfiles`, default 8 | the component plan proposed 4; OO ships 8, so OO passes nothing | spec §6.3 |
| storage failures emit `error` instead of being swallowed | see §3 above | spec §10 |

⛔ **Not extracted, on purpose.** `keyFor()` is reproduced as `scopeFor()` in
`kit-profile` and **must not** be pushed down into `kit-storage` — that module
has no concept of a transparent scope and must not grow one (spec §4.2, §12).
`SaveSlots`, `Achievements`, `settings`, `game.stats` and `game.wave` are game
state and never enter this repo in any form.

---

## 7. `PROFILE_LEGACY_PROBE` — the identifier `kit-storage-spec.md` §15 refers to

`kit-storage-spec.md` §15's "Raw" checklist ends with a bullet naming
`PROFILE_LEGACY_PROBE`, an identifier defined nowhere in that spec or that
module. It was flagged as an inconsistency during kit-storage's phase 5
(`STATUS.md` open item 7, `DECISIONS.md` 2026-08-18) and left unresolved.

**It is defined here** — §2 above, immediately under the constants:

```js
const PROFILE_LEGACY_PROBE = ["afd_settings_v1", "afd_achievements_v2"];
```

So the checklist line means: `raw.has()` on those two keys, in a blocked
context, returns `false` without throwing. kit-storage's phase 5 tested
`raw.has()` on all **three** named legacy keys instead — a superset — so the
behaviour is already covered and nothing needs re-running. What remains is
wording: §15 borrows a name from a module `kit-storage` is deliberately
ignorant of (its §2.3), and should either spell the two keys out or say
"kit-profile's `legacyProbeKeys`". Repo owner's call; nothing is blocked on it.

In `kit-profile` this constant is the `legacyProbeKeys` config default
(spec §11), which is where an OO-specific value belongs.
