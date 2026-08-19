# STATUS

Last updated: 2026-08-18

## Phase 1 — Worker (`services/leaderboard/`) — deployed and smoke tested in production

Built per `docs/kit-leaderboard-worker-spec.md` and
`docs/kit-leaderboard-deploy-notes.md`:

- `migrations/0001_init.sql` — the `scores` table + three indexes, exactly as specced.
- `src/registry.js`, `src/validate.js`, `src/scores.js`, `src/board.js`, `src/index.js`
- `wrangler.jsonc` — `database_id: fee9d1ef-4c89-4c1e-910a-cda98080888c`,
  binding `coinless_scores`, database name `coinless-scores`.

Done:
- Migration applied to local D1 (`--local`) and to **production** D1 (`--remote`).
- `npx wrangler deploy` succeeded — Worker is live, route
  `scores.coinlessgames.com/*` attached.
- DNS: `scores.coinlessgames.com` needed a proxied placeholder `AAAA -> 100::`
  record (attaching the route didn't create one automatically) — added
  manually via the dashboard on 2026-08-14 and resolves now.
- Full smoke test sequence from the deploy notes run against **production**:
  health, origin rejection, valid submit, idempotent duplicate, bounds-check
  flagging, name rejection, unknown-stats-key flagging, top-players dedup
  (verified twice — once locally, once against production with a fresh
  player), and board reads across `24h`/`4h`/`year`/`all` windows. All passed.
- Test rows (`game_version = '0.0.0-test'`) cleaned up from production per
  the deploy notes' post-smoke-test step.

**Known gap — rate limiting does not work in production.** See
`DECISIONS.md` (2026-08-14 entry). The account is on the Workers Free plan,
which appears not to enforce the `ratelimits` binding — 9 rapid submits from
one IP all returned 200 with no 429, despite the binding being correctly
configured and working in local `wrangler dev`. **Practical effect: nothing
currently caps submission rate in production.** Origin checking is
explicitly non-security per the spec, so right now the only real deterrent
to submission spam is... none. Confirmed acceptable to the repo owner for
now; revisit if the board is ever actually targeted (upgrade to Workers
Paid, most likely).

## Phase 2 — client module (`modules/kit-leaderboard/`) — done

Built per `docs/kit-leaderboard-client-api.md`:

- `kit-leaderboard.js` — plain ES module, no dependencies, no DOM access.
  Exports `create`, `validateName`, `NAME_CHANGE_NOTICE`. Public API on the
  instance returned by `create()`: `beginRun`, `submit`, `fetchBoard`,
  `queueLength`, `flushQueue` — matches the doc exactly.
- `demo.html` — single static file, `<script type="module">`, exercises
  `submit()` and `fetchBoard()`. Uses `orbital-overhaul` as `gameId` (the
  only registered game) and `game_version: "0.0.0-demo"` so demo rows are
  easy to spot/delete later — it doesn't import or reference any game code.

Tested in an actual headless Chromium (Playwright — `chromium-cli` and any
existing Playwright install weren't available in this environment, so a
scratch npm install + `playwright install chromium` was done in
`/tmp/.../scratchpad/pw-test/`, outside the repo, nothing added to the repo
or its dependencies):

- Served `demo.html` over `http://localhost:8080` (ES modules need real
  http, not `file://`).
- **Failure path, against production** (`localhost:8080` isn't on the
  production Worker's origin allowlist since `ENVIRONMENT=production`
  there): confirmed `submit()` never threw — resolved
  `{status:'queued', reason:'offline'}` — the offline queue recorded it,
  and the 2s backoff timer auto-retried and fired a `flushed` event on its
  own with no further user action. `fetchBoard()` correctly rejected, and
  the demo page caught it and rendered an inline error instead of crashing.
- **Happy path, against a local `wrangler dev --local --var
  ENVIRONMENT:dev`** (which does allow `localhost` origins): pointed the
  demo's endpoint field at `http://localhost:8787`, confirmed `submit()`
  returns a real `{status:'submitted', publicId, flagged, duplicate,
  rank:{allTime,h24}}`, queue length drops back to 0, and `fetchBoard()`
  renders the board table correctly including the flagged-entry marker.
  Screenshot confirms the page renders correctly.
- No JS console errors in either run beyond the expected/handled CORS
  failures in the failure-path test.

Nothing in this test run touched production D1 — the CORS-blocked attempt
never reached the server, and the successful submit went to local dev D1
only.

## Phase 3 — `kit-names` extracted (`modules/kit-names/`) — done 2026-08-18

`kit-names.js` — `validateName`, `NAME_CHANGE_NOTICE`, `MAX_NAME_LENGTH`. Plain
ES module, no dependencies. Contract: `docs/kit-names.md`.

## Phase 4 — name rules consolidated; Worker redeployed 2026-08-18

**There is now exactly one implementation of the display-name rules in this
repo, in `modules/kit-names/kit-names.js`. Neither the Worker nor
kit-leaderboard keeps an independent or fallback copy.**

- `services/leaderboard/src/validate.js` re-exports `validateName` from
  kit-names; its inline `normalizeName` is deleted. `src/scores.js` updated to
  the new name.
- `modules/kit-leaderboard/kit-leaderboard.js` re-exports `validateName` and
  `NAME_CHANGE_NOTICE` from kit-names (a real re-export — verified
  reference-identical with `===`, not merely equivalent). Its inline copy is
  deleted. Doc header now reads `Tag: v0.2.0` / `Depends on: kit-names`.

**Behavior changed, deliberately — the board is now stricter.** All three
former copies were *not* identical: both the Worker's and kit-leaderboard's ran
the charset check *after* `.toUpperCase()`, which is the ⛔ ordering bug
`docs/kit-names.md` §2.1 exists to prevent. Confirmed against production before
deploying: `display_name: "ß"` returned `200` and was stored as `SS`. After the
deploy it returns `400 INVALID_NAME`. Same for `ﬁ` (was `FI`). Nothing else
about what the board accepts changed. Existing D1 rows were deliberately not
audited or rewritten — see `DECISIONS.md`.

`npx wrangler deploy` succeeded (version `7b59f920-69bb-4e95-a2f4-7b4ca1f73a39`).
esbuild resolves the cross-directory import into `services/` cleanly; verified
by reading the emitted bundle, not just by the deploy exiting 0.

Full deploy-notes smoke-test sequence re-run against **production**, all
passing: health, origin rejection, valid submit, idempotent duplicate (same
`public_id`), bounds flagging (`rate_implausible`), name rejection,
unknown-stats-key flagging, top-players dedup (one player, three runs at 1000 /
900000 / 5 → appears once at 900000), and board reads across `24h`/`4h`/`year`/
`all`. `year` confirmed rolling-365-day, not calendar. Name rejection was
tested hardest since it's the behavior that changed: 16 cases including both
§2.1 regressions, the unchanged accept/reject sets, and server-owned profanity.

Test rows (`game_version = '0.0.0-test'`, 15 of them) deleted from production.
The 3 real rows (`PAUL` ×2, `BUDDY`) verified intact afterward.

**Cost baseline:** top-players board query `window=all&limit=25` on a 9-row
table — `rows_read: 59`, `rows_written: 0`, `0.56ms`. Reads scale with rows in
the window, not with `limit`; re-measure when the table grows.

**Rate limiting is still not enforced in production** (unchanged known gap — see
below and `DECISIONS.md`). A deliberate 6-submit burst against a 3/60s limit
returned 200 six times. One stray 429 did appear earlier in ~22 rapid submits,
so it fires sporadically rather than never — but it provides no usable cap.

## kit-storage (`modules/kit-storage/`) — implementation and browser test pass done 2026-08-18; **not yet tagged**

Built per `docs/kit-storage-spec.md`, phase plan in
`docs/Implementation-notes-02-kit-storage.md`. Plain ES module, named export
`create`, **no dependencies — it does not import kit-names**.

### Phase 1 — skeleton, keyspace, availability (done 2026-08-18)

- Identifier validators (§3.2) for `gameId` / `scopeId` / `key`. `.` is
  rejected explicitly ahead of the pattern test so the error names the segment
  separator. The 3-char `gameId` minimum is what keeps `coinless.lb.*`
  uncollidable (§3.3, §13).
- Availability probe (§5.1) — the `try` wraps the `window.localStorage`
  *property read*, not just `setItem`, which is the sandboxed-iframe mode.
- Store-wide declaration table via `create({keys})` and `declare()`. Idempotent
  only on identical version **and** identical `migrate` function reference;
  anything else throws and leaves the table unmutated (§7.1).
- `get`/`set`/`has`/`remove` throw on an undeclared key and name the declared
  ones; `keys`/`scopes`/`clear`/`usage` never throw for undeclared keys.

154 assertions, Node + a mock `localStorage`: validator boundaries, declaration
conflicts, the undeclared-key guard, and both probe-failure modes.

### Phase 2 — envelope and the version algorithm (done 2026-08-18)

- The `{"v":N,"d":...}` envelope (§4). The *value* is serialized on its own and
  spliced in — `JSON.stringify({v, d: value})` silently drops `d` for a
  function or symbol and yields a valid-looking `{"v":1}` that reads back as
  corruption a load later instead of throwing at the call site. Found by test.
- The complete seven-step read algorithm (§7.3), written out step for step.
  **The only write on any read path is step 7's successful forward migration.**
  Steps 3, 5, 6 and both of step 7's failure branches return the fallback and
  leave the stored bytes untouched.
- **Step 5 (downgrade) is deliberately inert** and commented ⛔ as such.

124 assertions. All five §15 "Versioning" cases plus the "Corruption" block,
`migrate` returning `undefined`, no-chaining, per-key versions, and a failed
migration write-back. **Every non-writing case asserts on a snapshot of the
whole of `localStorage` before and after, not on the return value** — a
return-value-only test passes even if the module silently rewrote storage.

### Phase 3 — memory shim and quota (done 2026-08-18)

- Memory shim (§5.2): any write that fails to reach durable storage is
  retained in `ctx.memory`, keyed by full storage key so it's shared across
  `scope()` the same way the probe result, `onEvent` handler and declaration
  table already are. A successful write clears the entry first, so a durable
  value is never shadowed by a stale in-memory copy. `remove()` clears both.
- Quota classification (§8): `setItem` failures are distinguished by whether
  `ctx.ls` was absent to begin with (no event — already covered by the
  one-time `unavailable` at `create()`) versus `setItem` itself throwing,
  which is always classified `quota` — browsers disagree on
  `QuotaExceededError` vs. `NS_ERROR_DOM_QUOTA_REACHED` vs. numeric codes 22 /
  1014, and the spec says to treat any unrecognized write failure as quota
  too, so kit-storage doesn't try to out-guess the browser.
- No eviction anywhere in the write path — `set()` returning `false` plus the
  `quota` event is the entire contract (§2.2).

### Phase 4 — scopes, enumeration, raw (done 2026-08-18)

- `scope(id)` returns the same interface over a longer prefix, sharing the
  parent's probe result, `onEvent` handler and declaration table (§6).
- `keys()` / `scopes()` / `clear()` / `clear({deep:true})` via the prefix walk
  and the no-`.`-in-identifiers segment-count rule (§9). All four also sweep
  matching entries out of the memory shim, including keys that never reached
  durable storage at all (`underPrefixMemory`, needed because a never-durable
  key has nothing in `localStorage` for the storage-side walk to find).
- `raw` (§3.4): unprefixed, unversioned, un-enveloped strings, same shim
  rules as managed keys, exempt from `clear()`, invisible to `keys()`.

### Phase 5 — real-browser test pass (done 2026-08-18)

`demo.html` and `blocked-storage-test.html` built in the module directory,
same single-file/`<script type="module">` pattern as kit-leaderboard's —
served over real http, no game code imported. `blocked-storage-test.html` is
a standalone fixture (not just a demo helper): loaded in a
`sandbox="allow-scripts"` iframe with no `allow-same-origin`, it runs its own
assertions and posts the result to its parent, so it's reusable by both the
manual demo and automated verification.

The full §15 checklist was run in real headless Chromium (Playwright —
scratch npm install + `playwright install chromium` in
`/tmp/.../scratchpad/pw-test/`, outside the repo, same as the kit-leaderboard
precedent) via a temporary assertion-suite page (not committed — deleted
after the run, same rationale as kit-leaderboard's Playwright scripts never
entering the repo):

- **Happy path** — all 6 JSON-representable types round-trip; absent-key and
  post-`remove()` fallback; two scopes independent under the same key; nested
  scope round-trip.
- **Namespacing** — two `gameId`s don't see each other's keys; `clear()` on
  either leaves a hand-written `coinless.lb.<gameId>.v1` key byte-identical;
  `keys()` excludes nested scopes, shallow `clear()` leaves them, `clear({deep:
  true})` removes them; `scopes()` lists each child once, not per key.
- **Versioning** — all 5 §15 cases, **every non-writing case asserted on the
  raw `localStorage.getItem()` bytes before/after**, not just the return
  value: same-version (byte-identical), lower+migrate (migrated value,
  `migrated` fired, re-read confirms the version 2 write-back), lower+no-migrate
  (fallback, `corrupt`/`no_migrate`, bytes untouched), higher/⛔downgrade
  (fallback, `downgrade`, bytes untouched), migrate-returns-`undefined`
  (fallback, `error`, bytes untouched), migrate-throws (fallback, `error`,
  bytes untouched).
- **Corruption** — non-JSON and valid-JSON-non-envelope, both fallback +
  `corrupt` + bytes untouched.
- **Degradation — blocked storage.** Verified inside the real sandboxed
  iframe (not a mock): `create()` doesn't throw, `available === false`,
  `unavailable` fires once with the actual browser
  `SecurityError: Failed to read the 'localStorage' property from 'Window':
  The document is sandboxed and lacks the 'allow-same-origin' flag.` — this
  is the literal exception the spec's §5.1 probe is written to catch. Every
  method (`set`/`get`/`has`/`remove`/`keys`/`usage`/`raw`) still works; a
  second `create()` in the same blocked context (standing in for a fresh page
  load, since the memory shim is a fresh `Map` per instance either way) does
  not see the first instance's shimmed value.
- **Degradation — quota.** Filled storage in shrinking chunk sizes (1MB down
  to 1 byte) until even a 1-byte write failed, then `set()` a value **larger**
  than the existing durable one (same-or-smaller overwrites take zero
  additional bytes and would spuriously succeed even at genuine capacity —
  caught by the first pass of this test). Confirmed: `false` returned, `quota`
  fired, `get()` returns the new value from memory, a direct storage read
  still holds the old bytes. Freed the filler keys and confirmed a subsequent
  successful `set()` clears the memory shim, verified by reading storage
  directly afterward (what would survive a reload) rather than through
  `get()`.
- **Programmer error** — all 9 checklist cases throw: undeclared key on each
  of get/set/has/remove, illegal `gameId` (short and bad-charset), illegal
  `scopeId`, `.` in a key, `set(key, undefined)`, a circular value, and a
  conflicting `declare()`. Identical redeclaration confirmed as a no-op.
- **Raw** — round-trip, `has()`/`remove()`, invisible to `keys()`, survives
  `clear()`. See the flagged spec inconsistency below for the last bullet.

80/80 assertions passed. `demo.html` was also independently smoke-tested by
driving its actual buttons (not just the assertion suite) in Playwright —
set/get, `keys()`/`usage()`, `raw`, a hand-written v99 envelope demonstrating
the downgrade fallback, an undeclared-key throw, and the blocked-storage
iframe button — zero console or page errors, screenshot confirms correct
rendering.

**Spec inconsistency flagged, not silently resolved.** §15's "Raw" block's
last bullet reads `raw.has() on all of PROFILE_LEGACY_PROBE in a blocked
context returns false without throwing`. `PROFILE_LEGACY_PROBE` is not
defined anywhere in `kit-storage-spec.md` or the module — the only related
name is `PROFILE_LEGACY = "p0"` (§3.4, §6.1), and that's explicitly a
**kit-profile** concept kit-storage stays ignorant of per §2.3. Tested the
evident intent instead — `raw.has()` on the three named legacy keys
(`afd_settings_v1`, `afd_achievements_v2`, `afd_profiles_v1`) inside the
blocked-storage context returns `false` without throwing, which passed — but
that's a substitution, not literal fulfillment of the checklist line as
written. Repo owner should confirm the intended fix to the checklist wording;
see `DECISIONS.md`.

### Judgment calls the spec left open, now recorded

See `DECISIONS.md`, 2026-08-18 entry, for the items deferred here during
phases 1–2 (error types, `corrupt` reason strings, event `key` scoping,
`has()` semantics, `usage()`'s nested-scope inclusion, unserializable-migrate
handling) plus the `PROFILE_LEGACY_PROBE` inconsistency above.

## kit-profile (`modules/kit-profile/`) — implementation and browser test pass done 2026-08-18; **not tagged**

Built per `docs/kit-profile-spec.md`, phase plan in
`dev-notes/Implementation-notes-03-kit-profile.md`. Plain ES module, depends
on `kit-storage` (instance injected, never created here) and `kit-names` (all
name rules). `VERSION` is `0.1.1` in the module and both docs' `**Version:**`
headers — no git tag; see CLAUDE.md "Module versioning." (`0.1.1`, not the
phase-5 starting `0.1.0`: a PATCH bump for the `crypto.randomUUID` fix below —
no contract change.)

Roster model, all four boot paths (fresh roster, legacy roster import, legacy
probe, genuinely empty install), `ensurePlayerId` and its four call sites,
roster operations (`create`/`createAnonymous`/`rename`/`remove`), and the
two-phase `select()` switch lifecycle were built in phases 1–4. This session
(phase 5) added `player()` (§9 — already present when this phase started;
confirmed it matches the spec exactly), built the browser test harnesses, and
ran the full real-browser verification pass below — the first time the whole
module has been exercised end to end rather than read against the spec.

### Real-browser test pass (done 2026-08-18)

`demo.html` and `blocked-storage-test.html` built in the module directory,
same pattern as the other modules — served over real http (a small
CORS-enabling static server, not `python3 -m http.server`, was needed for the
blocked-storage fixture; see below), no game code imported.

Full §14 checklist run in real headless Chromium (Playwright — scratch
install in `/tmp/.../scratchpad/pw-test/`, outside the repo, same precedent as
the other modules) via a temporary assertion-suite page (not committed,
deleted after the run):

- **`player_id` mechanics** — all 7 checklist items: `player()` stable within
  a session and across a simulated reload (a fresh instance over the same
  storage); backfill fires at boot (minted **before** any other save could
  run — read directly off `localStorage` immediately after `create()`
  returns) and again via `select()`; stable across rename, switch-away-and-
  back, and a *different* profile being removed; `list()` exposes no
  `playerId` field on any entry; two profiles mint distinct ids.
- **Boot paths** — all 7 items: empty install (`firstBoot`, nothing written);
  first `create()` on an empty install lands on `p0` whose scope aliases the
  root store; pre-profile install mints one `PLAYER 1` profile and leaves the
  probed blob byte-identical; legacy roster import leaves the legacy key
  byte-identical while writing the new one; corrupt roster JSON leaves an
  empty roster and the bytes untouched, no throw; a roster with a duplicate
  id, a non-object entry, and an empty name loads with just the two good
  entries; the `seq` floor rule.
- **Roster ops** — all 8 items: the three distinct `create()` refusal
  reasons; case/trim-insensitive name collision; `rename()` collision and
  self-rename; `remove()` refuses the last profile; `remove()` on the current
  profile auto-selects a replacement and fires the full two-phase lifecycle;
  removed ids are never reissued; a removed profile's scoped data stays
  readable via `scope(id)`; `maxProfiles` lower than a stored roster's size
  loads and persists all of it intact and only blocks new `create()`s.
- **Switch lifecycle** — all 6 items, including `beforeChange`/`change`
  seeing the correct side of the switch from *inside the handler* (not just
  after `select()` returns), a write in each handler landing in the correct
  profile's scope, `select()` on an unknown/current id firing nothing, and a
  throwing handler not leaving `activeId` half-moved.
- **Names** — all 3 items: `Gh0st!` is refused by `create()` but a profile
  already stored under that name loads intact and is never rewritten;
  `createAnonymous()` twice returns `name_taken` the second time; an
  anonymous profile renames like any other.

30/30 assertion groups passed (covering all 31 non-degradation checklist
items — two switch-lifecycle items share one test since they're two sides of
the same write). `demo.html` was independently smoke-tested by driving its
actual buttons in Playwright — create, select, create-anonymous, rename, and
a switch between two profiles — zero console errors, screenshot confirms
correct rendering, and the event log correctly shows `beforeChange` before
`change` on every switch.

**Degradation (blocked storage) — real bug found and fixed, repo-owner
approved.** Tested inside a real `sandbox="allow-scripts"` iframe with no
`allow-same-origin` (the same "itch.io / Newgrounds" scenario kit-storage's
own probe fixture models). `crypto.randomUUID()` — called unconditionally by
`ensurePlayerId()` and the legacy-probe mint, carried verbatim from production
per spec §3/§12 — was `undefined` there: an opaque origin is never a secure
context (confirmed directly: `window.isSecureContext === false`), and
`Crypto.randomUUID()` is secure-context-only, unlike
`crypto.getRandomValues()`. Effect: `current()`, `player()`, and `select()`
threw the first time they reached an unminted profile in that embed type.
**Not a kit-profile-specific regression** — the identical unguarded call
exists in the production source this module extracts
(`docs/orbital-overhaul-player-id-source.md`), so the same throw was already
present there if Orbital Overhaul has ever been embedded this way; it simply
hadn't been isolated before.

Fixed with the repo owner's approval: a new `mintPlayerId()` helper falls back
to building a v4 UUID from `crypto.getRandomValues()` when `crypto.randomUUID`
is unavailable, used at both call sites. This changes nothing about
`ensurePlayerId`'s three §12-protected properties (check-then-mint, immediate
persist, the call sites) — only what generates the id string. `VERSION`
bumped `0.1.0` → `0.1.1` (PATCH, no contract change). Re-ran both the full
§14 suite (still 30/30) and `blocked-storage-test.html` (now 13/13, up from
5/11 before the fix) after the fix — no regressions. The fixture's own
reporting was also tightened while re-verifying: several "does not throw"
checks previously logged only on failure, so a fully-green run reported fewer
checks than a partially-failing one; every `tryCall()` now logs its own
pass/fail unconditionally, so the count is stable across runs. Stays
committed as a standing regression check.

### Integration check — the contract the whole module exists to satisfy

`npx wrangler dev --local --var ENVIRONMENT:dev` stood up against
`services/leaderboard`, migrations applied locally. A temporary page (not
committed) built `profiles` and then:

```js
const board = KitLeaderboard.create({ /* ... */, getPlayer: () => profiles.player() });
```

with **no change to `kit-leaderboard.js`**. `beginRun()` + `submit()`
returned `{status:'submitted'}` for a freshly created profile; the profile was
then renamed mid-session with **no change to the `board` instance**, and a
second `beginRun()` + `submit()` also returned `{status:'submitted'}`.
Verified past the client's own report by reading local D1 directly
(`wrangler d1 execute coinless-scores --local`): both rows carry the same
`player_id`; `display_name` is `INTEGTEST` on the first row and `RENAMED2` on
the second — confirming the rename really was picked up by the next
`submit()`, not just that both calls happened to succeed. `player()` with no
current profile returns `{playerId: null, displayName: ''}` as specced.
Nothing written by this test touched production — local dev D1 only, and no
game code or Orbital Overhaul repo was touched (out of scope for this
session).

### Judgment calls and findings, now recorded

See `DECISIONS.md`, 2026-08-18 (Phase 5) entry, for: the `crypto.randomUUID`
finding and proposed fix, in full; and §14 item 6's checklist wording, which
(like kit-storage's still-open `PROFILE_LEGACY_PROBE` item) is inconsistent
with the spec's own §3.1 and was tested against the evident intent instead of
the literal text.

## Open items for the repo owner

1. `statsFields` for `orbital-overhaul` was trimmed to `wave_reached,
   canisters_delivered, hunter_kills, saucer_kills, debris_destroyed` per
   your instruction — `longest_chain` and `max_single_haul` were dropped.
   Easy to add back later since a stats-key mismatch only flags, never rejects.
2. Rate limiting is not actually enforced in production (Workers Free plan).
   No action needed unless/until the board gets abused.
3. Both phases are now complete. Next step, per the deploy notes' rollout
   order, is integrating `kit-leaderboard` into Orbital Overhaul — a
   separate repo, separate session.
4. **Tagged `v0.2.0`** (at `fa2d983`, commit `1d0f080` — the kit-names
   extraction plus the name-rule consolidation). A game can pin this work.
   `v0.1.0` (at `cb51451`) predates kit-names and still contains the
   self-contained kit-leaderboard, so any game pinned there is unaffected by
   the stricter name rules.
5. Orbital Overhaul's `Profiles.cleanName` is still the fourth copy of the
   name rules and still diverges (trims and slices to 12, enforces nothing
   else). It lives in the game repo, out of scope here, but it is the
   remaining half of the drift `kit-names` was created to end — a profile
   stored as `Gh0st!` still produces a permanently-rejected submission.
6. **kit-storage's implementation and browser test pass are done; tagging is
   not.** Full §15 checklist passed in a real browser (80/80). The phase notes
   said to tag it `v0.1.0`, but that collides with this repo's existing
   unprefixed `v0.1.0`/`v0.2.0` tags, both already claimed by kit-leaderboard
   (§ see kit-storage section above). Flagged to you rather than guessed;
   you chose not to tag yet, pending a naming decision — no game can pin
   kit-storage until a tag exists.
7. Separately, §15's "Raw" block references an undefined identifier,
   `PROFILE_LEGACY_PROBE` — see the kit-storage section above and the
   2026-08-18 `DECISIONS.md` entry. Doesn't block anything; kit-storage's own
   behavior is unaffected either way, it's the spec doc's checklist wording
   that needs a decision.
8. kit-profile is next per the phase notes, but that's explicitly a separate
   session — it needs to be written against kit-storage's shipped API, not a
   remembered one, and should wait until the tag question above is settled.
9. **kit-profile's implementation and real-browser test pass are done; it has
   no git tag.** That's expected, not deferred — module versioning moved to
   `VERSION`/`**Version:**` (see 2026-08-19 `DECISIONS.md` entry and
   CLAUDE.md), and kit-profile's is confirmed `0.1.1` in the module and both
   docs.
10. **Bug found and fixed, with your approval:** `crypto.randomUUID()` threw
    in a sandboxed embed with no `allow-same-origin` (itch.io/Newgrounds-style
    — the exact scenario kit-storage's own blocked-storage fixture models),
    breaking `current()`/`player()`/`select()` the first time any of them
    reached an unminted profile there. Inherited verbatim from the production
    code kit-profile extracts, so the same throw most likely already exists in
    Orbital Overhaul today — worth checking there too. Fixed via a
    `mintPlayerId()` helper that falls back to `crypto.getRandomValues()`
    when `randomUUID` is absent, touching nothing `ensurePlayerId`'s §12
    protections cover. Re-verified: full §14 suite still 30/30,
    `blocked-storage-test.html` now 13/13 (was 5/11). `VERSION` bumped to
    `0.1.1` for this fix. See `DECISIONS.md` for the change itself.
11. §14 item 6's checklist wording ("assert storage still holds zero
    `playerId`s" after `list()`) was inconsistent with the spec's own §3.1,
    which requires boot itself to mint the active profile's id — so after any
    non-empty-roster boot, exactly one profile already has one before `list()`
    is ever called. **Fixed, with your approval** — `kit-profile-spec.md` §14
    now says to assert exactly one `playerId` after boot and that `list()`
    adds no more. kit-storage's still-open `PROFILE_LEGACY_PROBE` item (open
    item 7 above) got the same kind of finding but is still awaiting a
    decision — unrelated to this one beyond the pattern.
12. kit-profile is ready for the step the phase notes originally pointed to:
    integrating into Orbital Overhaul. That's a separate session in a separate
    repo with its own notes file, and this session did not touch it, per
    instruction. Worth checking there whether the `crypto.randomUUID` failure
    mode (open item 10) has ever actually manifested in production.
