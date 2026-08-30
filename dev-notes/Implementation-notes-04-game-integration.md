# Implementation Notes — First game integration

## Operator notes — for you, not for Claude Code

**Decide Phase 0 before pasting anything.** It determines which repo these
sessions run in and how many there are.

### Phase 0 — which game is the first consumer?

Orbital Overhaul is the WORST first consumer by every measure except
convenience:

- Its Profiles object works today, in production, with real players. Swapping a
  working identity system for a freshly-written one risks existing saves to fix
  nothing a player can see.
- The legacy import and pre-profile probe are the only parts of kit-profile
  that touch live player data, and the only parts that CANNOT be fully
  validated without real installs. A synthetic fixture proves the code matches
  the spec; it cannot prove the spec matched five years of real localStorage
  states.
- It is the only game with a live leaderboard, so a player_id mistake there
  does permanent damage.

A to Z Warehouse or Repossessed skips that path entirely (legacyRosterKey:
null, legacyProbeKeys: []), gets the modules into production on their normal
path, and answers a question OO structurally cannot: are these APIs decent to
build against from scratch?

**Recommendation: a new game first, OO later.**

### Sessions

**New game** (no legacy data) — Phase 1 disappears, and Phases 3–4 lose their
fixture work:

| Phase | Session | Launch |
|---|---|---|
| 2 | **New session** | `claude --model sonnet` |
| 3, 4 | Same session as 2 | — |
| 5, 6, 7 | **New session** | `claude --model sonnet` |

**Orbital Overhaul:**

| Phase | Session | Launch |
|---|---|---|
| 1 | **New session** | `claude --model sonnet` |
| 2 | Same session as 1 | — |
| 3 | **New session** | `claude --model opus --effort xhigh` |
| 4 | Same session as 3 | — |
| 5 | **New session** | `claude --model sonnet --effort xhigh` |
| 6, 7 | Same session as 5 | — |

Phases 3 and 4 run together on Opus because they touch the same live save data,
and Phase 4's p0-addresses-the-root-scope rule only makes sense with Phase 3's
context still in the session.

**Escalate and stop** if a fixture comes back with a changed player_id, or if a
legacy key moves. Neither is a bug to debug in-session — both mean the spec's
model of real localStorage states was wrong, which is a design conversation.

The OO-only phases are marked in the block text itself.

---

## Phase 1 — Save-data fixtures (OO only)

````
Repo: the Orbital Overhaul game repo (NOT coinless-kit).

coinless-kit now ships kit-storage v0.1.0, kit-profile v0.1.0, kit-names
v0.1.0, and kit-leaderboard v0.2.0, all tested. This game currently pins
kit-leaderboard v0.1.0 and uses its own Profiles object for identity.

Before touching any code, build the test fixtures this whole integration is
verified against.

Export complete snapshots of real Orbital Overhaul localStorage states — ideally
three:
  1. A pre-profile install: only afd_settings_v1 / afd_achievements_v2, no
     roster.
  2. A roster from before player_id existed (entries with no playerId key).
  3. A current install.

Save them as JSON files in a gitignored directory in this repo so they can be
restored between test runs. Test against restored copies only, never against a
browser profile whose data matters.

Verify each fixture round-trips: restore it, boot the CURRENT SHIPPED build,
confirm the game loads normally. That establishes the baseline before
kit-profile is anywhere near it.

Record, in your report, the player_id value present in each fixture. Those
recorded values are the assertion for the rest of this integration.

Continue to the next phase in this same session when I paste it.
````

## Phase 2 — Vendor the modules and upgrade kit-leaderboard

````
Continuing in the same session.

(If this is a new game with no legacy data, this is the first phase — read
CLAUDE.md in coinless-kit, docs/kit-storage-client-api.md,
docs/kit-profile-client-api.md, and docs/kit-names.md first, and skip the
fixture references below.)

Bring in kit-storage v0.1.0, kit-names v0.1.0, and kit-profile v0.1.0 at their
tags, using the same vendoring approach this repo already uses for
kit-leaderboard.js.

Upgrade kit-leaderboard from v0.1.0 to v0.2.0. That is the version that
re-exports name rules from kit-names. Documented call sites are unchanged, so
this should be a version bump and nothing else — but confirm
KitLeaderboard.validateName and KitLeaderboard.NAME_CHANGE_NOTICE still
resolve.

Dev-time note: these are real ES modules, so the game must be served over http
during development, not opened from file://. Inlining happens at release via
esbuild.

Then stop and report. Do not replace the identity layer — that is a separate
session.
````

## Phase 3 — Replace the identity layer

````
Repo: the Orbital Overhaul game repo. kit-storage, kit-names, kit-profile and
kit-leaderboard v0.2.0 are vendored in at their tags. The game still uses its
own Profiles object for identity. Save-data fixtures exist in the gitignored
fixtures directory, and each one's original player_id value is recorded in
STATUS.md.

Read first, in order:
- coinless-kit's docs/kit-profile-client-api.md
- coinless-kit's docs/kit-storage-client-api.md
- this repo's current Profiles object and its getPlayer wiring

Wire up:
- KitStorage.create({ gameId: 'orbital-overhaul' }) at boot, before anything
  reads persisted state. One instance, passed to kit-profile.
- Replace the Profiles object with KitProfile.create({ storage }). The legacy
  config defaults are already this game's real values, so pass only storage.
  (A new game with no legacy data passes legacyRosterKey: null and
  legacyProbeKeys: [] instead.)
- Replace getPlayer with () => profiles.player(). Nothing on the leaderboard
  side changes.

Then verify, before doing anything else: restore each fixture in turn and
confirm, for each one, that the profile roster appears intact, names are
unchanged, and the player_id values are BYTE-IDENTICAL to what the fixture
held. Compare against the recorded values, do not eyeball it.

A changed player_id on a profile that already posted scores is the silent
fragmentation this entire design exists to prevent. If any fixture's player_id
changes, STOP and report — do not debug it in-session.

Report those results, then continue to the next phase in this same session when
I paste it.
````

## Phase 4 — Route per-profile storage through scopes

````
Continuing in the same session. Phase 3 replaced the identity layer and every
fixture verified with unchanged player_id values.

Move every per-profile store from the old keyFor() router to profiles.scope():
settings, achievements, local scores, and anything else keyed per profile.

The legacy transparency rule means profile p0 addresses the ROOT SCOPE, so its
keys must remain exactly where they are. Verify with a fixture: boot as p0,
write settings, and confirm the key written is the unprefixed legacy key — NOT
a p0-suffixed one. A key that gains a p0 segment is a returning player's save
silently relocating.

If any p0 store lands at a new key, STOP and report.

Then stop and report. Do not start the switch lifecycle — that is a separate
session.
````

## Phase 5 — The switch lifecycle

````
Repo: the Orbital Overhaul game repo. The identity layer now runs on
kit-profile, and per-profile stores are routed through profiles.scope(). Every
fixture verified: player_ids unchanged, p0 stores still at their legacy keys.
See STATUS.md.

Read first:
- coinless-kit's docs/kit-profile-client-api.md, the "Switching profiles"
  section IN FULL
- this repo's existing activate() and its inline comments

Move the existing activate() reset list into the 'change' event handler, and
its flush into 'beforeChange'.

  beforeChange: saveSettings(); Achievements.save();
  change:       reset to SHIPPED defaults, THEN load the incoming profile.

Every item in that reset list traces to a real bug (see the FLAG-CS031-d
references in-repo), not defensive boilerplate. Carry ALL of it: settings,
audio volumes, bindings, debug state, lifetime achievement counters,
game.stats, and game.wave.

NOTHING IN THE RESET MAY WRITE. returnToDefaults() ends with saveSettings(),
and the Reset-All-Debug menu row saves right after resetAllDebug(). Calling
either here writes a defaults blob into a store — and WHICH store depends on
whether the switch already happened, so it corrupts either the profile being
left or the one being entered. Use the save-free restoreDefaultBindings().

Test the bleed cases directly, since they are what the list exists for: switch
from a profile with non-default volumes and a completed wave-10-or-higher run
to a fresh profile, and confirm the fresh profile has default volumes and has
NOT been awarded untouchable or max_haul.

Continue to the next phase in this same session when I paste it.
````

## Phase 6 — Boot flow and first-run

````
Continuing in the same session. Phase 5 moved the switch lifecycle onto
beforeChange / change.

Wire the boot flow:
- Route the title screen off profiles.firstBoot to a picker offering a named
  profile or the Anonymous shortcut.
- Do NOT allow a submittable run to start while current() is null. A null
  playerId reaching the leaderboard Worker is a payload rejection.
- Show KitProfile.NAME_CHANGE_NOTICE in the rename flow, before confirmation,
  with a cancel option.

Optionally: check KitNames.validateName(current().name).ok before offering to
submit a score, and prompt for a rename if it fails. A profile stored under
older rules (for example 'Gh0st!') is legal locally but will be rejected by the
board, and NAME_REJECTED is not queued by kit-leaderboard — that run's score is
simply lost. kit-profile deliberately does not flag this; the policy is the
game's.

Continue to the next phase in this same session when I paste it.
````

## Phase 7 — Full manual pass

````
Continuing in the same session. Phases 5 and 6 completed the switch lifecycle
and the boot flow.

Run the full manual pass:

- (OO only) Every fixture: restore, boot, play, submit a score, and verify on
  the production board that it posted under the SAME player_id the fixture
  originally held.
- Fresh install: first-boot picker, create profile, play, submit, board.
- Anonymous path: first-boot picker, Anonymous, play, submit, board.
- Profile switch mid-session, with the bleed checks from Phase 5.
- Rename, then submit, then confirm old board rows keep the old name and new
  rows carry the new one.
- Blocked-storage run: play in a sandboxed iframe, confirm the game is playable
  and does not crash, and that nothing is claimed to be saved that is not.

Then:
- Remove the old Profiles object entirely. Do not leave it dormant.
- Update this repo's STATUS.md and DECISIONS.md.
- Any kit-module bug found here gets filed back against coinless-kit rather
  than patched locally in the game. Per coinless-kit's CLAUDE.md: no game code
  in the kit, and no kit forks in the game.

Report back.
````