# DECISIONS

Implementation choices made where the docs in `docs/` were silent, or where
a literal reading conflicted with itself. Append new entries; don't rewrite
history here.

## 2026-08-14 — Phase 1 (Worker)

**`statsFields` for `orbital-overhaul`.** The worker spec flagged this list
explicitly ("CONFIRM OR TRIM THIS LIST"). Confirmed with the repo owner:
trimmed from 7 to 5 — `wave_reached, canisters_delivered, hunter_kills,
saucer_kills, debris_destroyed`. Dropped `longest_chain` and
`max_single_haul`. Low-stakes to revisit: an unrecognized stats key only
flags the row, it never rejects.

**D1 binding name is `coinless_scores`, not `DB`.** The deploy notes'
example `wrangler.jsonc` uses `"binding": "DB"`, but the repo owner's task
instructions explicitly specified `binding: coinless_scores`. Used that
name throughout — `wrangler.jsonc` and every `env.coinless_scores` reference
in `src/scores.js` and `src/board.js`.

**Rate-limit key vs. validation-pipeline order (spec inconsistency).** The
worker spec's validation table lists "Rate limit" (step 3) as happening
*before* "Body parses as JSON" (step 4). But §6 says the submit limiter key
is `${clientIp}:${game_id}`, and `game_id` only exists once the body is
parsed — the two statements can't both be literally true in that order.

Resolved by parsing the body internally first (cheap, and needed either way
to know if it's valid), using `game_id` for the rate-limit key when parsing
succeeded and the literal string `'unknown'` when it didn't, applying the
rate limiter, and *only then* returning `INVALID_PAYLOAD` if parsing had
failed. Net effect: a request that is both malformed and over the rate limit
still gets `RATE_LIMITED` first, matching the table's stated precedence,
without requiring the key to exist before the body is readable.

**Origin allowlist for GET with a present-but-disallowed Origin.** §6
explicitly covers only the *missing*-header case ("No Origin header: reject
on POST, allow on GET"). It doesn't say what happens on GET when an Origin
header *is* present but isn't on the allowlist. Applied the same allow/deny
gate symmetrically to GET as to POST in that case (403
`ORIGIN_NOT_ALLOWED`) — one policy, one function, and it doesn't change
behavior for the common case (curl/server-to-server GETs with no Origin
header at all, which are still allowed per the explicit rule).

**Invalid/missing `window` query param.** The spec doesn't say what happens
for an invalid `window` value (only `limit` is explicitly "clamped, not
rejected"). Defaulted unrecognized/missing `window` to `all`, on the same
philosophy as `limit`.

**`public_id` generation.** Not specified beyond "server-minted; safe to
expose in share links." Used an 8-character random string drawn from a
57-character alphabet that excludes visually ambiguous characters
(`0/O/1/l/I`), generated via `crypto.getRandomValues`. On the astronomically
unlikely event of a `public_id` collision on insert (distinct from a
`run_id` collision, which is the expected idempotency path), the insert
fails and surfaces as `SERVER_ERROR` rather than retrying — not worth the
complexity at this collision probability.

**DNS blocker, resolved.** The wrangler OAuth token used this session had
`zone (read)` only, no DNS write scope, and a Cloudflare API token the repo
owner tried to grant DNS write to also failed authentication against the
`dns_records` endpoint even after the permission was added (most likely: the
dashboard's "Zone > DNS Settings > Edit" permission group is a different,
zone-settings-only permission from "Zone > DNS > Edit", which is what
`dns_records` CRUD actually requires — an easy mix-up since the two are
adjacent in the token editor). Rather than keep fighting token scopes, the
repo owner added the placeholder `AAAA scores -> 100::` record directly via
the dashboard. Resolved.

**Rate limiting does not work in production — known, accepted gap.** The
worker spec's `ratelimits` binding (`SUBMIT_LIMITER` 3/60s, `READ_LIMITER`
60/60s) is configured exactly per the deploy notes and `wrangler deploy`
confirms both bindings attach correctly. It also worked correctly under
`wrangler dev --local` (a burst of 4 submits correctly 429'd on the 4th).
But against production, 9 rapid submits from one IP for the same game all
returned 200 — never once rate limited.

The account is on the **Workers Free plan** (confirmed by the repo owner).
The most likely explanation is that the Workers Rate Limiting binding
requires a paid Workers plan and silently no-ops (rather than erroring) when
that requirement isn't met — nothing in the Worker's own code or logs
indicated a failure, and no exception surfaced.

**Practical consequence:** nothing currently enforces submission rate in
production. Combined with Origin checking being explicitly "not security"
per §6 of the worker spec, there is currently no real deterrent to a script
hammering `/v1/scores`. The bounds check still flags absurd submissions
(doesn't reject them), and idempotency on `run_id` still prevents duplicate
board entries from retries — those protections are unaffected. What's
missing is specifically the *volume* cap.

**Decision:** accepted as-is for now, per the repo owner. Revisit only if
the board is actually targeted — most likely fix is upgrading to Workers
Paid, which is a cost/plan decision for the repo owner, not something to
route around with an app-level shim in the meantime.

## 2026-08-14 — Phase 2 (client module)

**Import shape.** The client API doc shows usage as `KitLeaderboard.create(...)`,
`KitLeaderboard.validateName(...)`, `KitLeaderboard.NAME_CHANGE_NOTICE` but
doesn't specify export style. Used plain named exports (`create`,
`validateName`, `NAME_CHANGE_NOTICE`) rather than a default-exported
namespace object, so a game does `import * as KitLeaderboard from
'./kit-leaderboard.js'` — idiomatic ESM, and the doc's `KitLeaderboard.x`
call sites work unmodified either way.

**Rejected-vs-queued bucket for codes the doc doesn't classify.** The client
API doc explicitly lists `INVALID_NAME` / `NAME_REJECTED` / `INVALID_PAYLOAD`
as permanent-rejected, and `RATE_LIMITED` / `SERVER_ERROR` / network failure
as queued — but says nothing about `INVALID_GAME`, `ORIGIN_NOT_ALLOWED`, or
`TURNSTILE_FAILED`. Bucketed all three as permanent `rejected`: retrying an
identical queued payload can't fix a bad `game_id`, a disallowed origin, or a
turnstile token that was already invalid or already used. Queuing them would
just accumulate junk in `localStorage` that can never succeed.

**Backoff schedule interpretation.** The offline-queue backoff is specified
as "2s, 8s, 30s, then once per session" — literal enough for the first three
steps, ambiguous after. Implemented as: an automatic retry timer fires at
2s, then (if still failing) 8s, then 30s after that; once all three tiers
are exhausted, the module stops scheduling further automatic timers for the
rest of the page session and relies purely on the three explicit triggers
the doc already names (`online` event, a subsequent successful `submit()`,
or a manual `flushQueue()` call). Verified end-to-end in a real browser: a
queued entry's 2s auto-retry fired and emitted `flushed` with no user action.

**`rank` field mapping.** Server returns `rank: { all_time, "24h" }`; client
API doc shows `rank: { allTime, h24 }`. Mapped directly, one-to-one, in
`submit()`'s response handling — no ambiguity here, just noting the mapping
exists since it's easy to typo.

**`storageKey` default.** Doc states a default "derived from gameId" and
shows one example (`coinless.lb.orbital-overhaul.v1`) but not the exact
formula. Used `` `coinless.lb.${gameId}.v1` `` — matches the example exactly
when `gameId` is `orbital-overhaul`.

**`localStorage` unavailable.** Detected once at `create()` time via a
probe write/remove wrapped in try/catch. When unavailable, `push()` on the
queue is a no-op (nothing persisted, nothing kept in memory either) and
`queueLength()` reports 0 — matches the doc's "degrades to no queue... must
not throw," and `submit()` still truthfully resolves `{status:'queued',
reason:'offline'}` for that call even though nothing was actually queued.

## 2026-08-17 Repo Rules

'No build step' was too broad; it was meant to ban source-level tooling, and 
was blocking the intended esbuild release step. Split into two rules; 
the esbuild inline step is explicitly permitted.

## 2026-08-17 — Repo constraint: "no build step" split

**"No frameworks, no build step, no dependencies" was one bullet doing three
jobs, and the middle one was wrong.** The repo owner's actual intent is that
module *source* needs no tooling to read, run or test — not that a release
pipeline is forbidden. The intended distribution path is one scripted esbuild
command inlining modules into a game's distributable HTML, which the old
wording banned outright.

Split into three bullets: no frameworks (constraining what module source may
contain — no JSX, no TS syntax, no codegen), a release build step explicitly
permitted, and dependencies defaulting to zero as a strong preference rather
than a ban. The distinction that matters: a build step that *transforms*
source, so you can't read a module without mentally running the compiler, stays
banned; one that only *concatenates* it is the release pipeline.

Also clarified in the same edit: the "no achievements" constraint said "this
module" while sitting under a repo-wide heading — now explicitly scoped to
every module built so far. And the Layout section now describes the shape
(`modules/<name>/`) rather than listing an inventory that goes stale, with a
pointer to `STATUS.md` for what actually exists.

## 2026-08-17 — kit-storage design

**Keys are declared, not versioned per call.** The component plan sketched
`store.migrate(fromVersion, migrationFn)` as a method. That shape can't express
*which key* it applies to, and it invites migration being registered after a
read has already happened. Replaced with per-key declarations carrying
`{ version, migrate }`, supplied at `create()` or via `store.declare()` for
modules handed a store they didn't make. Version therefore travels with the
key and can't drift between call sites.

**Reading or writing an undeclared key throws.** Deliberate ergonomic cost, in
exchange for the typo guard: `store.get('profile')` (missing an `s`) becomes an
immediate error rather than a silently empty result. The recurring failure mode
across this project is silent-empty, not crashes. Codified as a general rule —
*environmental failure is a return value, programmer error is an exception* —
so blocked storage, full quota and corrupt bytes never throw, while API misuse
always does.

**Versions are per key, not per store.** Production already works this way
(`afd_profiles_v1` and `afd_achievements_v2` carry independent versions), and a
store-wide version would force no-op migrations on every other key each time
one format changed.

**A stored version newer than the running build reads nothing and writes
nothing.** Real scenario — a cached itch.io build, or a rollback. It's the only
code path capable of destroying newer data, so it's specified as its own case
rather than folded into a general "version mismatch" branch, and the spec's
test checklist asserts on the stored *bytes*, not just the return value.

**No eviction, ever.** kit-storage can't know what's valuable — kit-leaderboard
drops the *lowest-metric* queued run rather than the oldest precisely because it
knows something kit-storage doesn't. `set()` returns `false`, fires an event,
and the owning module decides what to shed.

**Memory shim on write failure — divergent from kit-leaderboard, on purpose.**
kit-leaderboard's queue keeps nothing in memory when storage is blocked
(`push()` no-ops, `queueLength()` reports 0), which is right for a queue whose
job is to outlive the failure that filled it. Wrong for settings and identity:
an itch.io embed session is often a single page load, and a player whose profile
name resets mid-session is playing a broken game, not a degraded one.
kit-storage retains failed writes in memory for the session. Crucially
`set() === true` still means "persisted" in both modules, so the boolean's
meaning is unchanged and only readback within one page load differs.

**`gameId` minimum length is 3 characters.** kit-leaderboard v0.1.0 already owns
`coinless.lb.<gameId>.v1`. A 3-char minimum makes `lb` an impossible `gameId`,
so collision with the kit-storage namespace is structurally impossible rather
than merely unlikely. Don't relax it.

**`.` is illegal in every identifier.** Makes own-level keys distinguishable
from nested scopes by segment count, which is what lets `keys()`, `scopes()`,
`clear()` and `clear({deep:true})` be exact rather than heuristic.

**`store.raw` escape hatch retained deliberately.** Orbital Overhaul has
unprefixed production keys (`afd_settings_v1`, `afd_achievements_v2`,
`afd_profiles_v1`) that cannot move — `PROFILE_LEGACY = "p0"` exists
specifically so they don't. A namespacing scheme unable to address them breaks
real saves on extraction.

**Scoping is generic; kit-storage never learns what a profile is.**
`scope(id)` is one more path segment. Considered and rejected: putting scoping
in kit-profile, which would force achievements, settings and local scores to
depend on an identity module purely to compute a key prefix, and would leave
nobody able to enumerate a prefix safely.

## 2026-08-17 — kit-names extracted; kit-leaderboard re-tagged v0.2.0

**Display-name rules had already drifted into two incompatible copies.**
kit-leaderboard's `validateName` enforces 1–12 chars, `A-Z 0-9 space - _`,
uppercased, no Unicode. Orbital Overhaul's `Profiles.cleanName` trims and slices
to 12 and enforces nothing else. So `Gh0st!` is a legal local profile name and a
permanent board rejection — and `NAME_REJECTED` is not queued by
kit-leaderboard, so that run's score is simply lost.

Per the repo owner's decision, the rules move to a shared constant both modules
import: new module `kit-names`, holding `validateName`, `NAME_CHANGE_NOTICE` and
`MAX_NAME_LENGTH`.

**Consequence: kit-leaderboard's "Depends on: nothing" becomes false.**
Re-tagged **v0.2.0** with `Depends on: kit-names`, re-exporting `validateName`
and `NAME_CHANGE_NOTICE` so every call site documented in the client API doc
works unmodified. Games pin tags, so Orbital Overhaul stays on v0.1.0 until it
deliberately upgrades.

`NAME_CHANGE_NOTICE` moves too. kit-leaderboard v0.1.0's doc anticipated this —
it said whichever module ends up owning profile management should import the
constant rather than re-type the sentence. Having kit-profile import it *from*
kit-leaderboard would point a local identity module at a network module, so both
import from kit-names instead.

**Charset is validated before uppercasing, not after.** `'ß'.toUpperCase()` is
`'SS'` and `'ﬁ'.toUpperCase()` is `'FI'` — both would pass an ASCII charset
check applied post-uppercase, silently changing the name's length and admitting
the Unicode the rules exclude. Checking the pre-uppercase string closes it.
Marked ⛔ in the doc because reordering the two steps looks like a harmless
simplification.

**Update, 2026-08-18 — Worker duplicate closed.** The above was originally left open: services/leaderboard/src/validate.js held a third inline copy of the same rules, and importing kit-names into it would touch deployed Worker behavior, requiring a redeploy and a full smoke-test re-run. Decided to do it now rather than defer: the site isn't publicized yet and carries no production traffic, which is exactly the window where that cost is cheapest. The Worker's inline copy is deleted outright rather than kept as an unused fallback — a fallback that only runs when an import fails is untested code, and a broken import should fail the deploy loudly rather than silently serve stale rules. wrangler deploy already bundles Worker source with esbuild, so the import is ordinary, not new infrastructure. Requires: redeploy, full smoke-test sequence re-run from the deploy notes, with extra attention to the name-rejection case since that's the behavior actually changing.

## 2026-08-18 — Worker imports kit-names; name rules consolidated and deployed

**The three copies were not identical, and the Worker's was the buggy one.**
The pre-change diff required before the import turned up a real difference, not
a cosmetic one: `services/leaderboard/src/validate.js` ran its charset check
*after* `.toUpperCase()`, the exact ordering `docs/kit-names.md` §2.1 marks ⛔.
`modules/kit-leaderboard/kit-leaderboard.js` had the same flaw. Only kit-names
checked pre-uppercase.

Confirmed against **production before deploying**, not reasoned about:
submitting `display_name: "ß"` returned `200` and stored the row as `SS`
(`public_id E2N7xYqm`). So the Worker was accepting names the documented rules
exclude, and silently rewriting them. Same class covers `ﬁ` → `FI`.

Per the repo owner, adopted kit-names' ordering — this **tightens** what the
board accepts. Verified post-deploy: `ß` and `ﬁ` now return `400 INVALID_NAME`.
Everything rejected by the old rules stays rejected (`Gh0st!`, over-length,
empty, `ÉCLAIR`, non-string), everything accepted stays accepted (`TESTER`,
`A_B-C 1`, 12-char, `'  ghost '` → `GHOST`), and profanity remains server-owned
(`SHIT`, leet `5H1T` → `NAME_REJECTED`).

Existing D1 rows were deliberately **not** audited or rewritten, per the repo
owner. A stored `SS` stays `SS`; the rules govern new submissions only.

**Reason-string rename is invisible externally.** kit-names returns `empty` /
`too_long` where the Worker returned `invalid_type` / `invalid_length`. Safe:
`scores.js` only ever read `.ok`, collapsing every failure into one generic
`400 INVALID_NAME`, and the worker spec's documented error enum never contained
the granular strings. No client depended on them.

**`normalizeName` renamed to `validateName` at the call site** rather than
re-exported under an alias. An alias would have preserved a name that no longer
describes the function (it validates and returns a result object; it does not
normalize in place), and left two names for one thing — the same drift this
change exists to remove.

**kit-leaderboard's copy deleted in the same pass.** The phase brief described
this as already done, but commit `517ab60` had only added `modules/kit-names/`;
the client module still held its own inline rules and its doc still read
`Tag: v0.1.0` / `Depends on: nothing`. Now a true re-export (`export {
validateName, NAME_CHANGE_NOTICE } from '../kit-names/kit-names.js'`), so it is
reference-identical to `KitNames.validateName` as the doc's checklist requires —
verified by `===`, not by inspection.

**No fallback copy anywhere.** Per `docs/kit-names.md` §1.2: a fallback that
only runs when an import fails is untested code. Confirmed `wrangler deploy`'s
esbuild resolves the cross-directory import by reading the emitted bundle — the
charset test appears before `.toUpperCase()` in the deployed output, and the old
`[A-Z0-9 \-_]` regex appears nowhere in it.

**Rate limiting re-tested; the 2026-08-14 gap still stands, with one nuance.**
A deliberate controlled burst of 6 rapid submits from one IP for one game
(`SUBMIT_LIMITER` is 3/60s) returned `200` six times — no 429. So the known gap
is unchanged and nothing caps submission rate in production.

The nuance worth recording: during an earlier unthrottled run, exactly **one**
of ~16 rapid submits did return `429 RATE_LIMITED`, and across both bursts it
fired once in ~22 requests. So the binding is not a clean no-op the way the
2026-08-14 entry's "never once rate limited" implies — it appears to fire
sporadically rather than not at all. Practically identical (no usable cap), but
worth knowing, because it means a future test seeing a lone 429 should not
conclude the limiter started working.

Side effect worth remembering when reading smoke-test output: the limiter runs
at `scores.js:84`, *before* name validation at line 117. A 429 therefore
short-circuits the name check entirely — during this run one name case returned
429 and looked like a failure when it was simply untested. Re-run it after the
window clears rather than reading it as a rejection.

**Cost baseline** (deploy notes' post-smoke-test step), top-players board query,
`window=all`, `limit=25`, 9-row table: `rows_read: 59`, `rows_written: 0`,
`duration 0.56ms`. Against the free plan's 5M reads/day that is ~85k board
reads/day at current table size. Worth re-measuring once the table is large —
the query scans the window before ranking, so reads scale with rows in window,
not with `limit`.

## 2026-08-17 — kit-profile design (extraction from Orbital Overhaul)

Treated as an extraction, not a fresh design. `ensurePlayerId`, the defensive
`load()` parse including the `seq` floor rule, monotonic ids, not clearing a
removed profile's stores, `remove()` refusing the last profile, the legacy probe,
and `PROFILE_LEGACY` transparency all carry forward unchanged.

**`ensurePlayerId` verified and kept verbatim; only its call sites grew.** In
production the backfill fires for the profile being *activated* — `init()` and
`activate()` — so a roster entry never selected never gets an id, which is safe
today only because `getPlayer()` calls it belt-and-suspenders first. kit-profile
invokes it at every point identity is read or established: boot, `select()`,
`current()`, `player()`. Check-then-mint is idempotent, so more call sites can
only shrink the window; the three lines themselves are untouched. Explicitly
**not** called from `list()` or `create()` — minting eight UUIDs because a player
opened a picker would tie identity creation to a UI event.

**`maxProfiles` is configurable, default 8.** The component plan proposed 4;
Orbital Overhaul ships `PROFILE_MAX = 8`. Defaulted to 8 so OO passes nothing.

**Changed from production: `load()` no longer truncates to the maximum.**
Production breaks out of its parse loop at `PROFILE_MAX`, so a stored roster of 6
read by a build configured for 4 would silently lose two — the destructive
direction of making the cap configurable. Now: `load()` truncates only at a hard
ceiling of 32 (to bound corrupt input), an over-capacity roster loads and
re-saves intact, and `create()` enforces the real limit.

**Changed from production: `select()` fires two phases, not one.** The component
plan sketched a single `change` event, which silently loses production
`activate()`'s ordering guarantee — a handler can't tell which side of the switch
it's on. `beforeChange` fires while the outgoing profile is still current (flush
it there); `change` fires after (reset to defaults, then load). The reset list
itself stays in the game — kit-profile can't know settings, bindings, lifetime
counters, `game.stats` or `game.wave` exist — but is quoted verbatim in both
kit-profile docs with each item traced to the bug it came from
(`FLAG-CS031-d`), including the ⛔ that nothing in the reset may write.

**Changed from production: `remove()` on the current profile auto-selects a
replacement** and runs the full lifecycle, rather than leaving `activeId` naming
a gone id for the caller to repair in the same act. Exporting a contract that
leaves the module in an invalid state only a disciplined caller fixes isn't worth
the flexibility.

**Changed from production: roster ops return `{ ok, reason }`.** `add()` returned
bare `null` for invalid name, duplicate name and full roster alike; a UI needs to
say three different things.

**Boot requires selection; "Anonymous" is an ordinary profile.** Per the repo
owner: no auto-created profile. A genuinely empty install mints nothing, writes
nothing, and sets `firstBoot`, which the title screen routes off. The picker
offers a named profile or an Anonymous shortcut — the latter is a normal profile
with a default name, no flag, no distinct type, renameable later. Because
`nameTaken` is case-insensitive, a device holds at most one, which is the right
outcome and needs no special-casing.

**`player_id` and display name are separate, and the board may show several
`ANONYMOUS` rows.** Those are genuinely different players; the board
deduplicates on `player_id`. ⛔ Marked in the spec as not-a-bug, since
deduplicating by name would look like an obvious fix.

**Existing board-illegal names are preserved, unflagged.** Per the repo owner: a
profile stored as `Gh0st!` loads intact, is not renamed, not normalized, and
carries no "needs fixing" bit. Accepted consequence — its runs get
`NAME_REJECTED`, which isn't queued, so the score is lost. A game that cares can
call `KitNames.validateName(current().name).ok` itself before offering to submit.
Capability exported, policy left to the game; silently rewriting a player's
chosen name is the worse failure.

**First profile on an empty install gets id `p0`.** `seq` starts at 0, so the
first `create()` produces the legacy id, whose stores are the root scope —
exactly where an untouched machine would have written anyway. The empty-install
and returning-player paths therefore converge on one code path with no special
case.

**Removed profiles' stores are still not cleared, now that clearing is easy.**
kit-storage v0.1.0 offers `scope.clear({ deep: true })`, making deletion a
tempting one-liner. Monotonic `seq` remains the guarantee that a recycled id
can't inherit a dead profile's data, and not-clearing is what it protects. A
"delete my data" feature, if ever wanted, is a separate confirmed action — not a
side effect of removing a roster row.

## 2026-08-18 — kit-storage phases 3–5: memory shim, quota, scopes/enumeration/raw, browser test pass

Judgment calls from phases 1–2 that the spec left unstated, deferred to be
recorded here per the phase plan (`docs/Implementation-notes-02-kit-storage.md`):

**Error types.** `TypeError` for malformed identifiers, declarations, and
unserializable/`undefined` values — §3.2 says `TypeError` explicitly for
identifiers, and the same type was used for the rest for consistency. Plain
`Error` for state conflicts: an undeclared key on `get`/`set`/`has`/`remove`,
and a conflicting `declare()`. The dividing line: `TypeError` for "the value
you handed me is the wrong shape," `Error` for "what you're asking is
inconsistent with what's already true."

**`corrupt` event `reason` strings** are `unparseable`, `not_an_envelope`,
`no_migrate`. §11 names the `corrupt` event itself but not a reason enum;
these three cover step 3's two failure modes and step 6, and were picked to
read clearly in a debug overlay.

**Event `key` is the logical key, not the full storage key.** A scoped
store's events report `settings`, not `p1.settings` or the full
`coinless.<gameId>.p1.settings`. Consistent with the module never learning
what a scope *means* (§2.3) — the scope is the caller's context, not
something kit-storage should be reconstructing for them. Revisit if a debug
overlay ever needs to disambiguate which scope emitted an event.

**`has()` reports whether bytes exist, not whether this build can read
them.** A corrupt or newer-version (downgrade) value is still the player's
data per §2.4, and returning `false` for it would invite a caller to
overwrite exactly the value step 5 is designed never to touch. `has()` is
therefore implemented directly against `readItem`, bypassing the version
comparison entirely.

**`usage()` counts the whole prefix including nested scopes.** §8 says "this
store's prefix," which is ambiguous the same way §9's "own-level by default"
principle doesn't quite settle — `usage()` isn't destructive the way `clear()`
is, so there's no "profile wipe" reason to make it opt-in to depth. An
estimate that silently excluded nested-scope bytes would be a worse estimate.
`keys()`/`clear()` stay own-level by default per §9's explicit reasoning
("wipe this profile completely" should require typing `deep`); `usage()` was
never given that same reasoning in the spec, so it wasn't given the same
default.

**A migrate result that can't be serialized emits `error` and is treated as a
failed write-back — it never turns a `get()` into a throw.** Consistent with
§2.1: `migrate` throwing or misbehaving is arguably programmer error, but by
the time `writeValue` is reached inside `readValue`, the caller is running
inside a `get()`, which §2.1 and the client API doc both promise never
throws. The failed write-back re-runs next load, same as any other
write-back failure — `migrate` already has to be idempotent for that reason.

**Not tagged `v0.1.0` — the phase plan's instruction collides with existing
repo tags.** `docs/Implementation-notes-02-kit-storage.md` phase 5 and
`kit-storage-spec.md`'s own header both say `v0.1.0`, read as a per-module
version. But this repo's git tags are unprefixed and repo-wide, not
per-module: `v0.1.0` (`cb51451`) and `v0.2.0` (`1d0f080`) already exist and
both belong to kit-leaderboard's history (§ 2026-08-14/2026-08-17 entries
above). Creating a second `v0.1.0` tag would fail outright, or — if forced —
silently repoint the tag any game currently pinning kit-leaderboard's
original v0.1.0 depends on, which is exactly the kind of hard-to-reverse,
other-consumers-affected action this repo's own conventions say to stop and
ask about rather than resolve unilaterally. Raised with the repo owner, who
chose to leave kit-storage untagged for now rather than pick a naming scheme
under time pressure. **kit-storage has no tag as of this entry — a game
cannot yet pin it.** Whoever tags it next should settle the naming question
first (module-prefixed tags going forward, e.g. `kit-storage-v0.1.0`, vs. the
next unclaimed unprefixed version, e.g. `v0.3.0`, treated as a whole-repo
snapshot) rather than defaulting back to a plain `v0.1.0`.

**Phase 5 finding: §15's "Raw" checklist references an undefined
identifier.** The last "Raw" bullet reads `raw.has() on all of
PROFILE_LEGACY_PROBE in a blocked context returns false without throwing`.
`PROFILE_LEGACY_PROBE` does not appear anywhere else in
`kit-storage-spec.md`, `kit-storage-client-api.md`, or the module. The only
similarly-named thing is `PROFILE_LEGACY = "p0"` (§3.4, §6.1) — and that's
explicitly scoped to kit-profile, a module kit-storage is deliberately
ignorant of (§2.3). Rather than invent a `PROFILE_LEGACY_PROBE` constant
inside kit-storage to satisfy the letter of the checklist — which would
violate §2.3 for the sake of one test line — the phase-5 browser test
substituted the evident intent: `raw.has()` on the three named legacy keys
from §3.4 (`afd_settings_v1`, `afd_achievements_v2`, `afd_profiles_v1`)
inside a blocked-storage context, confirmed `false` on all three without
throwing. This is flagged rather than silently resolved: it's the checklist
wording that's inconsistent with the rest of the spec, not something this
session had standing to rewrite. Needs the repo owner's call on the intended
fix.

**Quota test methodology, worth recording since it nearly produced a false
pass.** Filling storage with a handful of large (1MB) chunks leaves up to
~1MB of slack after the final chunk fails to fit. Overwriting an *existing*
key with a same-or-smaller value costs zero additional bytes regardless of
how full storage is, so a naive quota test that reuses the same key with a
similarly-sized value can pass even when storage isn't actually full — the
`set()` under test never needed the space it was supposed to be denied. Fixed
by shrinking the fill chunk size down to 1 byte until even that fails
(guaranteeing zero slack), and by making the value under test for the quota
`set()` strictly larger than what's already stored at that key.