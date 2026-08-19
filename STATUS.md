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

## kit-storage (`modules/kit-storage/`) — phases 1–2 of 5 done

Built per `docs/kit-storage-spec.md`, phase plan in
`docs/Implementation-notes-02-kit-storage.md`. Plain ES module, named export
`create`, **no dependencies — it does not import kit-names**. Not yet tagged.

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

### Still owed by later phases — marked `PHASE n` in the source

- **Phase 3:** the memory shim (§5.2) and quota classification (§8). Read step
  1 is written out but inert; failed writes currently keep nothing.
- **Phase 4:** `scope()`, enumeration and `raw` are implemented per §6/§9/§3.4
  but only exercised so far by the never-throw-for-undeclared-keys tests. They
  still need the memory-shim sweep in `clear()`/`remove()` and their own tests.
- **Phase 5:** real-browser pass, `demo.html`, blocked-storage and quota
  verification, tag `v0.1.0`.

### Judgment calls the spec did not settle — fold into `DECISIONS.md` at phase 5

- **Error types.** `TypeError` for malformed identifiers, declarations and
  values (§3.2 says `TypeError` explicitly); plain `Error` for state conflicts
  — an undeclared key and a conflicting `declare()`.
- **`corrupt` reasons** are `unparseable`, `not_an_envelope`, `no_migrate`.
  §11 names the event, not the strings.
- **Event `key` is the logical key**, not the full storage key — so a scoped
  store's events do not say which scope. Revisit if a debug overlay needs it.
- **`has()` reports whether bytes exist**, not whether this build can read
  them. A corrupt or newer-version value is still the player's data (§2.4), and
  a `false` there would invite a caller to overwrite exactly what step 5
  refuses to touch.
- **`usage()` counts the whole prefix including nested scopes** (§8 says "this
  store's prefix"), unlike `keys()`/`clear()`, which are own-level by default.
- **A migrate result that cannot be serialized** emits `error` and is treated
  as a failed write-back — it never turns a `get()` into a throw.

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
