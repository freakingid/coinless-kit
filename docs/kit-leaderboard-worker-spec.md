# kit-leaderboard — Worker & D1 Specification

**Service:** `scores.coinlessgames.com`
**Runtime:** Cloudflare Workers + D1
**Status:** implementation spec, v1
**Scope:** game-agnostic. Nothing in this document is specific to Orbital Overhaul except one registry entry.

---

## 1. Design principles

1. **Thin universal spine + per-game JSON blob.** Games share almost nothing stat-wise. The `scores` table holds only what every game has; everything else lives in a `stats` JSON column whose shape is defined by the game, not the database. D1 is SQLite, so `json_extract` and generated columns are available later if a specific query needs them.
2. **The registry is code, not data.** Each game's plausibility validator is a JavaScript function, so it must live in the Worker source regardless. Putting sort direction, metric label, and the valid achievement set alongside it keeps one registry in one place. Adding a game is a code change and a deploy — which it would be anyway.
3. **Flag, don't reject.** A false positive on a genuinely great run is worse than a flagged row sitting in the table. Only structurally invalid payloads get a 4xx.
4. **Server clock is authoritative.** `submitted_at` is set by the Worker. Client-supplied timestamps are ignored entirely, not validated.
5. **Honest threat model.** The game is public JavaScript, so a determined person can forge a plausible submission. Every control here raises effort; none is proof. The goal is a board that stays respectable, not one that is cryptographically sound.

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
  stats         TEXT    NOT NULL,          -- JSON object; shape defined per game
  flagged       INTEGER NOT NULL DEFAULT 0,
  flag_reason   TEXT,                      -- nullable; which check tripped
  submitted_at  INTEGER NOT NULL           -- SERVER clock, unix seconds
);

-- Board reads: window filter, then group-by-player.
CREATE INDEX idx_scores_board
  ON scores(game_id, submitted_at DESC, metric DESC);

-- All-time board and all-time rank counting.
CREATE INDEX idx_scores_game_metric
  ON scores(game_id, metric DESC);

-- "This player's best in this game" — used by the rank calculation and future profile views.
CREATE INDEX idx_scores_player_best
  ON scores(game_id, player_id, metric DESC);

CREATE TABLE player_achievements (
  player_id      TEXT    NOT NULL,
  game_id        TEXT    NOT NULL,
  achievement_id TEXT    NOT NULL,
  unlocked_at    INTEGER NOT NULL,
  score_id       INTEGER REFERENCES scores(id),  -- provenance: which run reported it
  PRIMARY KEY (player_id, game_id, achievement_id)
);
```

### Notes on specific columns

**`run_id` (idempotency).** The client mints this once at run start and reuses it for every retry of that run. `UNIQUE` makes a duplicate `INSERT` fail cleanly; the handler catches the constraint violation, looks up the existing row, and returns the original `public_id` plus a freshly computed rank with `"duplicate": true`. A flaky connection or a backgrounded tab therefore cannot produce two board entries for one run.

**`player_id` vs `display_name`.** `player_id` is minted by the game (`crypto.randomUUID()`) once per local profile and never displayed. `display_name` is mutable and stored per row — so if a player renames themselves, older entries keep the old name. That is intentional, and the client is required to warn about it before a rename (see the client API doc).

**No `games` table.** Sort direction, metric label, achievement set, and validator all live in the Worker registry (§3).

**Growth.** Rows are never updated after insert. At Paul-scale this table stays small for years. If it grows enough that all-time rank counting gets expensive, the fix is a scheduled prune that keeps each player's personal best per game plus everything inside the 30-day window — deliberately out of scope for v1.

---

## 3. Game registry

```js
// src/registry.js
export const GAMES = {
  'orbital-overhaul': {
    displayName:  'Orbital Overhaul',
    sortDirection: 'desc',          // 'desc' = higher is better; 'asc' for time-based games
    metricLabel:  'Score',

    // --- permissive default validator inputs (see §4) ---
    maxMetric:         10_000_000,  // absolute ceiling; a typo-level sanity bound
    maxMetricPerSecond: 400,        // score-per-second ceiling
    minDurationS:       5,
    maxDurationS:       86_400,

    // Known stats keys. Unknown keys are stored as-sent but flag the row,
    // so a client/server version drift is visible rather than silent.
    statsFields: [
      'wave_reached', 'canisters_delivered', 'ufo_kills', 'hunter_kills',
      'garbage_sat_kills', 'max_single_haul', 'longest_chain'
    ],

    // Valid achievement IDs. Unknown IDs are skipped and flag the row.
    achievements: new Set([
      // populate when Orbital Overhaul's achievement list is finalized
    ]),

    // Game-specific bound check. null = use the permissive default only.
    // Orbital Overhaul's real check lands in the session where stats
    // instrumentation is added to the game.
    validate: null
  }
};
```

`maxMetricPerSecond` should be set generously — roughly 3–5× the best plausible sustained rate. It exists to catch a submission claiming a million points in eight seconds, not to police skilled play.

When Orbital Overhaul's `validate` is written, its shape is:

```js
validate(payload) {
  // payload: { metric, duration_s, outcome, stats, game_version }
  // Return null if plausible, or { reason: 'short_string' } to flag.
  // Must not throw. Must not reject — flagging only.
}
```

The intended Orbital Overhaul implementation computes the maximum achievable metric from the reported stats:
`canisters × maxPointsPerCanister + Σ(kills × maxPointsPerKillType) + waveBonusTable[wave_reached]`, using the same constants `addScore()` already enforces in-game. This only works if `stats` covers every scoring path — worth auditing when the instrumentation is added.

---

## 4. Validation pipeline (POST)

In order. First failure wins.

| Step | Failure mode | Result |
|---|---|---|
| Method + path routing | — | 404/405 |
| Origin allowlist (§7) | not allowed | 403 `ORIGIN_NOT_ALLOWED` |
| Rate limit (§7) | exceeded | 429 `RATE_LIMITED` |
| Body parses as JSON, ≤ 8 KB | malformed/oversized | 400 `INVALID_PAYLOAD` |
| `game_id` in registry | unknown | 400 `INVALID_GAME` |
| Turnstile (if enabled, §8) | verify fails | 403 `TURNSTILE_FAILED` |
| Required fields present, correct types | missing/wrong type | 400 `INVALID_PAYLOAD` |
| `run_id` / `player_id` are UUID v4 | malformed | 400 `INVALID_PAYLOAD` |
| `display_name` rules (§6) | illegal chars/length | 400 `INVALID_NAME` |
| `display_name` profanity filter (§6) | matched | 400 `NAME_REJECTED` |
| **Permissive default plausibility** | out of bounds | **flag, continue** |
| Game-specific `validate()` | returns reason | **flag, continue** |
| Unknown `stats` keys | present | **flag, continue** |
| Unknown `achievement_id`s | present | **flag + skip those rows, continue** |
| INSERT | `run_id` conflict | 200 with `"duplicate": true` |

### Permissive default plausibility (v1 behavior)

```
duration_s < minDurationS            → flag 'duration_too_short'
duration_s > maxDurationS            → flag 'duration_too_long'
metric < 0 or metric > maxMetric     → flag 'metric_out_of_range'
metric > maxMetricPerSecond * duration_s → flag 'rate_implausible'
```

Multiple reasons are joined with `;` into `flag_reason`. `flagged` is `1` if any reason fired.

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
    "wave_reached": 14, "canisters_delivered": 96, "ufo_kills": 3,
    "hunter_kills": 11, "garbage_sat_kills": 2, "max_single_haul": 6,
    "longest_chain": 4
  },
  "new_achievements": ["dock_king", "wave_15_survivor"],
  "turnstile_token": null
}
```

`new_achievements` contains **only** IDs newly unlocked during this run — never a lifetime list, never a count. The `player_achievements` primary key makes resubmission a silent no-op, so no upsert logic is needed and a retried submit is harmless. A lifetime total is a `COUNT(*)` at read time, which also means it can't be claimed by a client.

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

The client distinguishes these: `INVALID_NAME` / `NAME_REJECTED` / `INVALID_PAYLOAD` are permanent and must **not** be queued for retry (§ client doc). `RATE_LIMITED`, `SERVER_ERROR`, and network failures are transient and **must** be queued.

### `GET /v1/scores?game=<slug>&window=<w>&limit=<n>`

`window` ∈ `4h | 8h | 12h | 24h | 7d | 30d | year | all`. All eight are the same query with a computed cutoff — no special case for any of them. `year` is a rolling 365 days, not a calendar year, so it stays on the same code path. `all` uses cutoff `0`.

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
-- descending games; for sortDirection='asc' swap DESC→ASC in both ORDER BYs
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

**Cost note.** D1 bills *rows scanned*, not rows returned, and the free plan allows 5M rows read/day and 100k rows written/day. The group-by-player queries scan the game's rows within the window, so an all-time board is a full per-game scan. That is fine at this scale and nowhere near the ceiling, but it is the thing that eventually motivates pruning — worth checking the `meta.rows_read` value that D1 returns on each query during the smoke test so there's a baseline.

---

## 6. Display name handling

**Normalization** (applied before validation and before storage):

1. Trim leading/trailing whitespace, collapse internal runs of spaces to one.
2. Uppercase.
3. Reject any character outside `A-Z 0-9 space - _`. **Unicode is excluded entirely** — this kills the standard homoglyph filter-dodge with one rule instead of a lookalike table.
4. Length after normalization must be 1–12.

Reject with 400 and a reason. **Never silently truncate** — a player who typed 15 characters should learn that, not discover a mangled name on the board.

**Profanity filter.** Static wordlist in the Worker source, no external service. A raw substring match is decorative, so normalize before matching:

1. Map leetspeak: `4→A 3→E 1→I 0→O 5→S 7→T 8→B @→A $→S`.
2. Collapse runs of the same letter to one (`FUUUCK` → `FUCK`).
3. Strip everything that isn't `A-Z0-9`.
4. Substring match against the list.

Expect false positives (the Scunthorpe problem). Since the response includes a reason, the client can say "that name isn't allowed, try another" rather than failing mysteriously. Keep the list short and obvious; it is a decency filter, not a content moderation system.

The **server-side filter is authoritative on every submit.** The client's pre-check exists purely so the player finds out at the name-entry screen instead of after a great run — it is UX, never a control.

---

## 7. Origin allowlist & rate limiting

### Origin

Allow when the `Origin` header's host equals or is a subdomain of:

```
coinlessgames.com
itch.io          itch.zone          # itch.io serves HTML games from *.itch.zone
ungrounded.net   newgrounds.com     # Newgrounds upload origins
```

Plus `localhost` / `127.0.0.1` **only** when `env.ENVIRONMENT === 'dev'`.

This one matters: games embedded on itch or Newgrounds run from those platforms' origins, not from coinlessgames.com. Omitting them turns the Origin check into a distribution blocker that only shows up after publishing.

Requests with no `Origin` header are rejected on `POST` and allowed on `GET`. Return the matched origin in `Access-Control-Allow-Origin` (not `*`, since the allowlist is finite) and handle `OPTIONS` preflight.

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

Limits are enforced per Cloudflare location and are eventually consistent, so a burst can slightly overshoot. That's acceptable here.

---

## 8. Turnstile (wired, dark)

Build the hook now, leave it off. Enabling later is then config plus a script tag, not a re-architecture.

- `env.TURNSTILE_ENABLED` — string `'true'` / `'false'`, default `'false'`.
- `env.TURNSTILE_SECRET` — Wrangler secret, only required when enabled.
- Request field `turnstile_token` — accepted always, verified only when enabled. When enabled and the field is missing → 403 `TURNSTILE_FAILED`.
- Verification: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`, `response`, and `remoteip`; require `success: true`.

Reasoning for leaving it off at launch: it adds an external script to a single-file HTML game (a real nuisance on itch/Newgrounds), and it doesn't stop a headless browser farming tokens anyway. It stops casual curl spam — which rate limiting plus Origin already handles. Turn it on if the board actually gets targeted.

---

## 9. Worker structure

```
src/
  index.js          # router, CORS, origin check, rate limit, error envelope
  registry.js       # GAMES (§3)
  validate.js       # name normalization, profanity, default + per-game plausibility
  scores.js         # POST handler, idempotency, rank computation
  board.js          # GET handler, window cutoffs, top-N-players query
  achievements.js   # new_achievements insert
migrations/
  0001_init.sql
wrangler.jsonc
```

No framework needed — two endpoints don't justify Hono. Plain `fetch` handler with a small switch.

**Conventions:** every handler returns through one `json(status, body)` helper so the error envelope and CORS headers are applied in exactly one place. Unhandled exceptions become 500 `SERVER_ERROR` with the detail logged, never echoed to the client.

---

## 10. Deliberately out of scope for v1

Named here so they don't get quietly invented during implementation:

- Player profile / history endpoint (`player_id` and the indexes support it later).
- Cross-game unified profile.
- Moderation UI for flagged rows — inspect via `wrangler d1 execute` for now.
- Score pruning / archival.
- Weekly reset boards distinct from rolling windows.
- Any authentication. There are no accounts.