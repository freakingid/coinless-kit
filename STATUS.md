# STATUS

Last updated: 2026-08-14

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
