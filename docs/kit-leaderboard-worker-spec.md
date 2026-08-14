# kit-leaderboard — Worker & D1 Specification

**Service:** `scores.coinlessgames.com`
**Runtime:** Cloudflare Workers + D1
**Status:** implementation spec, v1
**Scope:** game-agnostic. **Scores only.** Achievements are explicitly out of scope — see §9.

---

## 1. Design principles

1. **Thin universal spine + per-game JSON blob.** Games share almost nothing stat-wise. The `scores` table holds only what every game has; everything else lives in a `stats` JSON column whose shape is defined by the game, not the database. D1 is SQLite, so `json_extract` and generated columns are available later if a specific query needs them.
2. **The registry is code, not data.** Sort direction, metric label, and bounds live in a Worker source module rather than a database table. Adding a game is a code change and a deploy — which it would be anyway.
3. **Flag, don't reject.** A false positive on a genuinely great run is worse than a flagged row sitting in the table. Only structurally invalid payloads get a 4xx.
4. **Server clock is authoritative.** `submitted_at` is set by the Worker. Client-supplied timestamps are ignored entirely, not validated.
5. **Cheap bounds, not proof.** The game is public JavaScript, so a determined person can forge a plausible submission. There is deliberately **no per-game score reconstruction validator** — the effort/payout is poor. A score-per-second ceiling plus rate limiting is the whole anti-cheat story. It catches absurdity and casual spam; it does not catch a careful forger, and it isn't meant to.

---

## 2. Schema

```sql
-- migrations/0001_init.sql

CREATE TABLE scores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT    NOT NULL UNIQUE,   -- client-minted UUID; idempotency key
  public_id     TEXT    NOT NULL UNIQUE,   -- server-minted; safe to expose in share links
  game_id       TEXT    NOT NULL,
  player_id     TEXT    NOT NULL,          -- opaque UUID, one per local profile
  display_name  TEXT    NOT NULL,          -- normalized + filtered, <= 12 chars
  metric        INTEGER NOT NULL,          -- the ranked value
  duration_s    INTEGER NOT NULL,
  outcome       TEXT    NOT NULL CHECK (outcome IN ('died','completed','quit')),
  game_version  TEXT    NOT NULL,
  stats         TEXT    NOT NULL,          -- JSON object; DISPLAY ONLY (see below)
  flagged       INTEGER NOT NULL DEFAULT 0,
  flag_reason   TEXT,                      -- nullable; which bound tripped
  submitted_at  INTEGER NOT NULL           -- SERVER clock, unix seconds
);

-- Board reads: window filter, then group-by-player.
CREATE INDEX idx_scores_board
  ON scores(game_id, submitted_at DESC, metric DESC);

-- All-time board and all-time rank counting.
CREATE INDEX idx_scores_game_metric
  ON scores(game_id, metric DESC);

-- "This player's best in this game" — rank calculation and future profile views.
CREATE INDEX idx_scores_player_best
  ON scores(game_id, player_id, metric DESC);
```

One table. That's the whole schema.

### Notes on specific columns

**`stats` is display data.** Its only job is to make a board row interesting — "wave 14, 96 canisters delivered" alongside the score. Nothing validates against it and nothing computes from it. Add or drop fields freely between game versions; old rows keep whatever shape they were submitted with, and the client renders what it finds.

**`run_id` (idempotency).** The client mints this once at run start and reuses it for every retry of that run. `UNIQUE` makes a duplicate `INSERT` fail cleanly; the handler catches the constraint violation, looks up the existing row, and returns the original `public_id` plus a freshly computed rank with `"duplicate": true`. A flaky connection or a backgrounded tab therefore cannot produce two board entries for one run.

**`player_id` vs `display_name`.** `player_id` is minted by the game (`crypto.randomUUID()`) once per local profile and never displayed. `display_name` is mutable and stored per row — so if a player renames themselves, older entries keep the old name. That is intentional, and the client is required to warn about it before a rename (see the client API doc).

**Growth.** Rows are never updated after insert. At this scale the table stays small for years. If all-time rank counting ever gets expensive, the fix is a scheduled prune keeping each player's personal best plus everything inside the 30-day window — deliberately out of scope for v1.

---

## 3. Game registry

```js
// src/registry.js
export const GAMES = {
  'orbital-overhaul': {
    displayName:   'Orbital Overhaul',
    sortDirection: 'desc',          // 'desc' = higher is better; 'asc' for time-based games
    metricLabel:   'Score',

    // --- bounds (§4) ---
    maxMetricPerSecond: 550,        // measured best rate x4; catches absurdity only
    maxMetric:          10_000_000, // typo-level ceiling
    minDurationS:       5,
    maxDurationS:       86_400,

    // Display-only stats keys. Unknown keys are stored as-sent but flag the row,
    // purely so client/server version drift is visible rather than silent.
    // CONFIRM OR TRIM THIS LIST — these are a suggestion, not derived from the game.
    statsFields: [
      'wave_reached',
      'canisters_delivered',
      'hunter_kills',
      'saucer_kills',
      'debris_destroyed',
      'longest_chain',
      'max_single_haul'
    ]
  }
};
```

Adding a game later means one more entry here and a deploy. There is no per-game validator function and no plausibility hook — the bounds above are the complete check.

`maxMetricPerSecond` is set generously on purpose. 550 is roughly four times the best real sustained rate in Orbital Overhaul, so it will never fire on legitimate play, however good the player.

---

## 4. Validation pipeline (POST)

In order. First failure wins.

| Step | Failure mode | Result |
|---|---|---|
| Method + path routing | — | 404/405 |
| Origin allowlist (§6) | not allowed | 403 `ORIGIN_NOT_ALLOWED` |
| Rate limit (§6) | exceeded | 429 `RATE_LIMITED` |
| Body parses as JSON, <= 8 KB | malformed/oversized | 400 `INVALID_PAYLOAD` |
| `game_id` in registry | unknown | 400 `INVALID_GAME` |
| Turnstile (if enabled, §7) | verify fails | 403 `TURNSTILE_FAILED` |
| Required fields present, correct types | missing/wrong type | 400 `INVALID_PAYLOAD` |
| `run_id` / `player_id` are UUID v4 | malformed | 400 `INVALID_PAYLOAD` |
| `display_name` rules (§5) | illegal chars/length | 400 `INVALID_NAME` |
| `display_name` profanity filter (§5) | matched | 400 `NAME_REJECTED` |
| **Bounds check** | out of bounds | **flag, continue** |
| Unknown `stats` keys | present | **flag, continue** |
| INSERT | `run_id` conflict | 200 with `"duplicate": true` |

### Bounds check (the whole anti-cheat)

```
duration_s < minDurationS                 -> flag 'duration_too_short'
duration_s > maxDurationS                 -> flag 'duration_too_long'
metric < 0 or metric > maxMetric          -> flag 'metric_out_of_range'
metric > maxMetricPerSecond * duration_s  -> flag 'rate_implausible'
```

Multiple reasons join with `;` into `flag_reason`. `flagged` is `1` if any reason fired. Nothing here rejects a submission.

---

## 5. Endpoints

Base: `https://scores.coinlessgames.com`. All responses `application/json`.

### `POST /v1/scores`

```json
{
  "game_id": "orbital-overhaul",
  "game_version": "1.0.0.30",
  "run_id": "b7c1e2f0-...",
  "player_id": "3f2a9e5c-...",
  "display_name": "GHOST",
  "metric": 42000,
  "duration_s": 612,
  "outcome": "died",
  "stats": {
    "wave_reached": 14, "canisters_delivered": 96, "hunter_kills": 11,
    "saucer_kills": 3, "debris_destroyed": 210, "longest_chain": 4,
    "max_single_haul": 6
  },
  "turnstile_token": null
}
```

**Response 200:**

```json
{
  "public_id": "kx3d7q9m",
  "flagged": false,
  "duplicate": false,
  "rank": { "all_time": 12, "24h": 3 }
}
```

Returning the submitter's own rank saves a round trip and is what the game shows on the game-over screen. Rank is computed **among players** (§5.1), consistent with the board.

**Response 4xx:**

```json
{ "error": { "code": "INVALID_NAME", "message": "Name must be 1-12 characters, A-Z 0-9 space - _" } }
```

Error codes: `INVALID_PAYLOAD`, `INVALID_GAME`, `INVALID_NAME`, `NAME_REJECTED`, `ORIGIN_NOT_ALLOWED`, `RATE_LIMITED`, `TURNSTILE_FAILED`, `SERVER_ERROR`.

The client distinguishes these: `INVALID_NAME` / `NAME_REJECTED` / `INVALID_PAYLOAD` are permanent and must **not** be queued for retry. `RATE_LIMITED`, `SERVER_ERROR`, and network failures are transient and **must** be queued.

### `GET /v1/scores?game=<slug>&window=<w>&limit=<n>`

`window` in `4h | 8h | 12h | 24h | 7d | 30d | year | all`. All eight are the same query with a computed cutoff — no special case for any of them. `year` is a rolling 365 days, not a calendar year, so it stays on the same code path. `all` uses cutoff `0`.

`limit` default 25, max 100. Invalid values are clamped, not rejected.

```json
{
  "game_id": "orbital-overhaul",
  "window": "24h",
  "metric_label": "Score",
  "generated_at": 1755000000,
  "entries": [
    {
      "rank": 1,
      "public_id": "kx3d7q9m",
      "display_name": "GHOST",
      "metric": 42000,
      "duration_s": 612,
      "outcome": "died",
      "stats": { "wave_reached": 14, "canisters_delivered": 96 },
      "submitted_at": 1755000000,
      "flagged": false
    }
  ]
}
```

Flagged entries **are** returned, occupy a rank slot, and carry `flagged: true`. The client renders a small marker. Holding them back would silently punish false positives; showing them marked keeps the board honest and reviewable.

`stats` is returned verbatim from the stored blob. The game decides which keys to render — the API doesn't curate.

### `GET /v1/health`

`{ "ok": true, "games": ["orbital-overhaul"] }`. Used by the deploy smoke test.

### 5.1 Board semantics — top N *players*

One row per player: their best run in the window, with `stats`, `outcome`, and `duration_s` taken from **that same run** (not aggregated across runs). Ties on `metric` break by earlier `submitted_at`. Two local profiles on one machine are two `player_id`s and legitimately occupy two slots.

```sql
-- descending games; for sortDirection='asc' swap DESC->ASC in both ORDER BYs
WITH windowed AS (
  SELECT * FROM scores
  WHERE game_id = ?1 AND submitted_at > ?2
),
ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (
           PARTITION BY player_id
           ORDER BY metric DESC, submitted_at ASC
         ) AS rn
  FROM windowed
)
SELECT public_id, display_name, metric, duration_s, outcome, stats, flagged, submitted_at
FROM ranked
WHERE rn = 1
ORDER BY metric DESC, submitted_at ASC
LIMIT ?3;
```

Rank of a submitter = 1 + the number of *other players* whose best in the window beats theirs:

```sql
SELECT COUNT(*) + 1 AS rank FROM (
  SELECT player_id, MAX(metric) AS best     -- MIN + '<' for asc games
  FROM scores
  WHERE game_id = ?1 AND submitted_at > ?2 AND player_id != ?4
  GROUP BY player_id
  HAVING best > ?3
);
```

**Cost note.** D1 bills *rows scanned*, not rows returned; the free plan allows 5M rows read/day and 100k rows written/day. The group-by-player queries scan the game's rows within the window, so an all-time board is a full per-game scan. Fine at this scale and nowhere near the ceiling, but it is what eventually motivates pruning — log the `meta.rows_read` value D1 returns during the smoke test so there's a baseline.

---

## 6. Display names, origin, rate limiting

### Name normalization

1. Trim leading/trailing whitespace, collapse internal runs of spaces to one.
2. Uppercase.
3. Reject any character outside `A-Z 0-9 space - _`. **Unicode is excluded entirely** — this kills the standard homoglyph filter-dodge with one rule instead of a lookalike table.
4. Length after normalization must be 1–12.

Reject with 400 and a reason. **Never silently truncate** — a player who typed 15 characters should learn that, not discover a mangled name on the board.

### Profanity filter

Static wordlist in the Worker source, no external service. A raw substring match is decorative, so normalize before matching:

1. Map leetspeak: `4->A 3->E 1->I 0->O 5->S 7->T 8->B @->A $->S`
2. Collapse runs of the same letter (`FUUUCK` -> `FUCK`)
3. Strip everything that isn't `A-Z0-9`
4. Substring match against the list

Expect false positives (the Scunthorpe problem). Since the response includes a reason, the client can say "that name isn't allowed, try another." Keep the list short and obvious; it's a decency filter, not content moderation.

The **server-side filter is authoritative on every submit.** The client's pre-check exists purely so the player finds out at the name-entry screen instead of after a great run — it is UX, never a control.

### Origin allowlist

Allow when the `Origin` header's host equals or is a subdomain of:

```
coinlessgames.com
itch.io          itch.zone          # itch.io serves HTML games from *.itch.zone
ungrounded.net   newgrounds.com     # Newgrounds upload origins
```

Plus `localhost` / `127.0.0.1` **only** when `env.ENVIRONMENT === 'dev'`.

This one matters: games embedded on itch or Newgrounds run from those platforms' origins, not from coinlessgames.com. Omitting them turns the Origin check into a distribution blocker that only appears after publishing.

No `Origin` header: reject on `POST`, allow on `GET`. Return the matched origin in `Access-Control-Allow-Origin` (not `*`, since the allowlist is finite) and handle `OPTIONS` preflight.

Be clear-eyed: `Origin` is trivially forged with `curl -H`. It stops drive-by scripts and misrouted requests. It is not security.

### Rate limiting

Use the Workers rate limiting binding (GA; requires Wrangler 4.36+). The binding's `period` **must be 10 or 60 seconds** — there is no hourly window — so express limits per minute:

```jsonc
"ratelimits": [
  { "name": "SUBMIT_LIMITER", "namespace_id": "1001", "simple": { "limit": 3,  "period": 60 } },
  { "name": "READ_LIMITER",   "namespace_id": "1002", "simple": { "limit": 60, "period": 60 } }
]
```

Key submits on `${clientIp}:${game_id}` and reads on `${clientIp}`. Three submits per minute is far above real play (a run takes minutes) and far below what makes scripted spam worthwhile. Get the IP from `CF-Connecting-IP`.

Limits are enforced per Cloudflare location and are eventually consistent, so a burst can slightly overshoot. Acceptable here.

---

## 7. Turnstile (wired, dark)

Build the hook now, leave it off. Enabling later is then config plus a script tag, not a re-architecture.

- `env.TURNSTILE_ENABLED` — string `'true'` / `'false'`, default `'false'`
- `env.TURNSTILE_SECRET` — Wrangler secret, only required when enabled
- Request field `turnstile_token` — accepted always, verified only when enabled. When enabled and missing -> 403 `TURNSTILE_FAILED`
- Verification: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`, `response`, `remoteip`; require `success: true`

Reasoning for launching with it off: it adds an external script to a single-file HTML game (a real nuisance on itch/Newgrounds), and it doesn't stop a headless browser farming tokens anyway. It stops casual curl spam — which rate limiting plus Origin already handles. Turn it on if the board actually gets targeted.

---

## 8. Worker structure

```
src/
  index.js          # router, CORS, origin check, rate limit, error envelope
  registry.js       # GAMES (§3)
  validate.js       # name normalization, profanity, bounds check
  scores.js         # POST handler, idempotency, rank computation
  board.js          # GET handler, window cutoffs, top-N-players query
migrations/
  0001_init.sql
wrangler.jsonc
```

No framework — two endpoints don't justify Hono. Plain `fetch` handler with a small switch.

**Conventions:** every handler returns through one `json(status, body)` helper so the error envelope and CORS headers are applied in exactly one place. Unhandled exceptions become 500 `SERVER_ERROR` with the detail logged, never echoed to the client.

---

## 9. Deliberately out of scope for v1

Named here so they don't get quietly invented during implementation:

- **Achievements, entirely.** No `player_achievements` table, no `new_achievements` field, no achievement IDs in the registry. Lifetime achievements are a separate kit module with a separate API, designed later. Orbital Overhaul's tiered achievements (one ID plus a tier number) will live there, not here.
- Per-game plausibility validators. Explicitly rejected — the bounds check in §4 is the complete story.
- Player profile / history endpoint (`player_id` and the indexes support it later).
- Moderation UI for flagged rows — inspect via `wrangler d1 execute` for now.
- Score pruning / archival.
- Weekly reset boards distinct from rolling windows.
- Any authentication. There are no accounts.