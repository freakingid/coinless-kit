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
