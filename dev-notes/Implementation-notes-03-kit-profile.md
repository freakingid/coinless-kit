# Implementation Notes — kit-profile

## Operator notes — for you, not for Claude Code

Paste each phase block below into Claude Code on its own. Everything Claude
needs is inside the block; nothing above this line goes to it.

**Prerequisites:** kit-storage v0.1.0 and kit-names v0.1.0 both built, tested
and tagged. kit-profile is written against the SHIPPED kit-storage API — if
kit-storage's implementation diverged from its spec, that divergence is in
DECISIONS.md and Phase 1's block should be amended before pasting.

| Phase | Session | Launch |
|---|---|---|
| 1 | **New session** | `claude --model opus --effort xhigh` |
| 2 | Same session as 1 | — |
| 3 | **New session** | `claude --model sonnet` |
| 4 | Same session as 3 | — |
| 5 | **New session** | `claude --model sonnet --effort xhigh` |

**Why Opus at xhigh for 1–2:** the risk here is inverted from a normal build.
The code is small, and the danger is a session deciding it can improve on
production code that is already correct. Spec section 12 lists twelve things
that must not be "fixed," and several look like obvious cleanups. That is a
"does it understand" risk. Both phases run together because Phase 2's boot
paths only make sense with Phase 1's reasoning still in the session.

**Why 5 is its own session:** build vs. test split, same as kit-storage.

**Escalate and stop** if any phase proposes changing something on section 12's
list. That list is the output of a design conversation and real production
bugs.

---

## Phase 1 — Roster model, defensive load, ensurePlayerId

````
Repo: coinless-kit. kit-storage v0.1.0 and kit-names v0.1.0 are built, tested
and tagged (see STATUS.md). kit-profile does not exist yet.

Read first, in order:
- CLAUDE.md
- docs/kit-profile-spec.md
- docs/kit-profile-client-api.md
- docs/kit-storage-client-api.md
- docs/orbital-overhaul-player-id-source.md  (the extraction source)

THIS IS AN EXTRACTION, NOT A FRESH DESIGN. Orbital Overhaul's Profiles object
is in production and correct. Spec section 12 lists what carries forward
unchanged. Where the spec says "verbatim," it means verbatim.

Build the start of modules/kit-profile/kit-profile.js:

1. Roster shape, save(), and the defensive load() parse per spec section 5.1 —
   field by field, known-value-else-default. Include the seq floor rule: seq
   never drops below max(numeric suffix) + 1, however the stored value was
   edited.

2. ensurePlayerId, VERBATIM from spec section 3:

     if (p && !p.playerId) { p.playerId = crypto.randomUUID(); this.save(); }

   Three properties, all load-bearing: check-then-mint, persists IMMEDIATELY
   rather than at the next natural save, and called from every path that
   reaches a profile. Do not restructure it into a lazy getter, a
   constructor-time mint, or a migration pass.

3. Wire its four call sites per section 3.1: boot, select(), current(),
   player(). NOT list() and NOT create() — minting eight UUIDs because a player
   opened a picker would tie identity creation to a UI event.

This is the non-negotiable carried over from the leaderboard work: player_id is
minted once per profile and never regenerated. If the backfill check is wrong
it silently fragments a player's leaderboard history into two identities that
can never be merged, and nothing surfaces at runtime — it shows up weeks later
as a board listing the same person twice.

Write these tests specifically:
- Hand-write a roster whose entry has NO playerId key at all (a pre-CS033
  blob). Boot. Assert the id is minted, 'minted' fires with backfill: true, and
  it is ALREADY IN STORAGE — read storage directly, immediately after boot,
  before any other save could have run.
- Backfill fires via select() too, not only boot.
- list() mints nothing: boot a roster of three idless profiles, call list(),
  assert storage still holds zero playerIds.
- playerId is stable across rename, across switch-away-and-back, and across a
  DIFFERENT profile being removed.

Report those test results, then continue to the next phase in this same session
when I paste it.
````

## Phase 2 — Boot paths

````
Continuing in the same session. Phase 1 built the roster model, the defensive
load, and ensurePlayerId with its four call sites.

Implement spec sections 5.2 through 5.5, in order:

LEGACY ROSTER IMPORT — read afd_profiles_v1 via storage.raw, parse with the
identical defensive rules from 5.1, and if usable write it to the new
kit-storage 'profiles' key. The legacy key is READ, NEVER DELETED AND NEVER
REWRITTEN. A player who rolls back to an older build still has their roster.

LEGACY PROBE — check afd_settings_v1 and afd_achievements_v2 via
storage.raw.has(). If either exists this is a returning player from before
profiles existed: mint ONE profile at legacyProfileId, named PLAYER 1, with a
playerId, seq = 1, firstBoot stays false. The pre-profile blobs themselves are
NOT copied, moved or rewritten — p0's stores ARE those keys, via the section
4.2 transparency rule.

GENUINELY EMPTY INSTALL — mint nothing, WRITE NOTHING, set firstBoot. activeId
is set to legacyProfileId so anything touched before selection lands exactly
where a pre-profile build would have put it, and an untouched machine cannot
tell the difference.

The scopeFor(id) legacy transparency helper (section 4.2) lives here, in
kit-profile — three lines. Never push it down into kit-storage; kit-storage has
no concept of a transparent scope and must not grow one.

These are the paths that touch data belonging to real Orbital Overhaul
installs. A bug here does not lose a profile — it silently relocates or shadows
a returning player's entire save.

Write these tests:
- Pre-profile install: assert the probed blob is BYTE-IDENTICAL afterward.
- Empty install: assert storage.keys() is empty after boot.
- Legacy roster import: assert the legacy key is unchanged afterward.

Then stop and report. Do not continue to roster operations — that is a separate
session.
````

## Phase 3 — Roster operations and names

````
Repo: coinless-kit. Already done in modules/kit-profile/kit-profile.js: roster
model, defensive load, ensurePlayerId with all four call sites, and all four
boot paths including legacy import and probe. All tested. See STATUS.md.

Read first, in order:
- CLAUDE.md
- docs/kit-profile-spec.md, sections 6, 8, and 12
- docs/kit-names.md
- modules/kit-profile/kit-profile.js

Implement create / createAnonymous / rename / remove per sections 6 and 8,
returning { ok, reason } with the distinct reasons: invalid_name, name_taken,
roster_full, last_profile. Production returned a bare null for the first three;
a UI needs to say three different things.

Each of these is deliberate and traces to a real decision. Do not "fix" any of
them:

- load() does NOT truncate to maxProfiles. Hard ceiling of 32 only, to bound
  corrupt input. create() enforces the real limit. Lowering maxProfiles must
  never delete profiles.
- remove() refuses the last profile. Removing the CURRENT profile auto-selects
  a replacement and runs the full section 7 lifecycle.
- Removed profiles' stores are NOT cleared, even though
  scope.clear({deep:true}) exists and makes it a one-liner. Monotonic seq is
  the guarantee this protects: a recycled id must never inherit a dead
  profile's data.
- Profile ids are never reused.
- Existing board-illegal names load intact, are NOT normalized, and carry NO
  flag. A profile stored as 'Gh0st!' keeps working locally. This was an
  explicit decision by the repo owner, not an oversight.

All name validation delegates to kit-names. kit-profile holds no charset, no
length, and no normalization of its own. nameTaken(name, exceptId) compares
normalized names case-insensitively.

Continue to the next phase in this same session when I paste it.
````

## Phase 4 — The two-phase switch lifecycle

````
Continuing in the same session. Phase 3 added the roster operations and name
handling.

Implement select(id) per spec section 7 — the three-step table.

  Step 1: fire 'beforeChange' while activeId is still the OUTGOING profile.
  Step 2: activeId moves, lastUsed is set, roster saved, ensurePlayerId(id).
  Step 3: fire 'change' with activeId now the INCOMING profile.

Do not collapse these into one event. A single change handler cannot tell which
side of the switch it is on, and production's activate() is correct precisely
because of that ordering.

The reset list stays in the GAME. kit-profile provides the seams and nothing
else — it must never import or reference settings, bindings, achievements,
game.stats or game.wave. Spec section 7.1 documents what a game does in the
handler; that text is for the game's integration, not for this module.

select() returns false for an id not in the roster, firing nothing. Selecting
the already-current id is a no-op that fires nothing.

Implement events per section 10. A handler that throws must not leave activeId
half-moved — test that explicitly.

Write these tests:
- beforeChange sees the outgoing id as current(); change sees the incoming.
  Assert inside the handlers.
- A write performed in beforeChange lands in the OUTGOING profile's scope.
- A write performed in change lands in the INCOMING profile's scope.
- A throwing handler does not leave activeId half-moved.

Then stop and report. Do not start the integration and browser test pass —
that is a separate session.
````

## Phase 5 — Integration surface and browser test pass

````
Repo: coinless-kit. modules/kit-profile/kit-profile.js is complete: roster
model, boot paths, ensurePlayerId, roster operations, names, and the two-phase
switch lifecycle. See STATUS.md. It has not yet been tested in a real browser.

Read first, in order:
- docs/kit-profile-spec.md, sections 9, 12, and 14 (the test checklist)
- docs/kit-profile-client-api.md
- docs/kit-leaderboard-client-api.md  (the getPlayer() contract)
- modules/kit-profile/kit-profile.js

Implement player(), returning kit-leaderboard's getPlayer() shape per section
9: { playerId, displayName }, and { playerId: null, displayName: '' } when
there is no current profile.

Build a static demo.html harness in the module directory, same pattern as the
other modules — exercises profile creation, switching, and a getPlayer()-shaped
read. No game code.

Run the FULL section 14 checklist in a real browser, including the
blocked-storage block: profile creation works in-session, player() returns a
usable id, and ensurePlayerId's immediate save returning false does not prevent
the id being used for the rest of the session.

Integration check — this is the contract the whole module exists to satisfy:
stand up a local `npx wrangler dev --local --var ENVIRONMENT:dev` in
services/leaderboard, construct

  KitLeaderboard.create({ ..., getPlayer: () => profiles.player() })

and confirm a submit succeeds with NO modification to kit-leaderboard. Also
confirm a rename mid-session is picked up by the next submit() without
recreating the leaderboard instance.

Then: confirm kit-profile's VERSION is 0.1.0 in both places it lives (the module and its docs' **Version:** header) — ⛔ not a git tag, see CLAUDE.md "Module versioning". Update STATUS.md with a kit-profile section in
the established format. Add DECISIONS.md entries for judgment calls the spec
did not resolve. If anything on section 12's list looked wrong during
implementation, raise it rather than working around it.

DO NOT touch the Orbital Overhaul repo. Integration is a separate session in a
separate repo with its own notes file.

Report back.
````