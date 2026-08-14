# kit-leaderboard — Deploy & Smoke Test Notes

Target: `scores.coinlessgames.com` on the same Cloudflare account and zone as coinlessgames.com. The route already exists and is currently disabled pending this Worker.

---

## Prerequisites

- Wrangler **4.36 or later** (required for the stable rate limiting binding).
- The `coinlessgames.com` zone active on Cloudflare (the site migration should land first, or at least DNS for the zone).
- A DNS record for `scores` — a proxied placeholder `AAAA` to `100::` is the conventional trick, though attaching a Worker route usually creates what it needs.

---

## Create the database

```bash
npx wrangler d1 create coinless-scores
# copy the returned database_id into wrangler.jsonc
```

## `wrangler.jsonc`

```jsonc
{
  "name": "coinless-scores",
  "main": "src/index.js",
  "compatibility_date": "2026-08-14",

  "routes": [
    { "pattern": "scores.coinlessgames.com/*", "zone_name": "coinlessgames.com" }
  ],

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "coinless-scores",
      "database_id": "<from wrangler d1 create>"
    }
  ],

  "ratelimits": [
    { "name": "SUBMIT_LIMITER", "namespace_id": "1001", "simple": { "limit": 3,  "period": 60 } },
    { "name": "READ_LIMITER",   "namespace_id": "1002", "simple": { "limit": 60, "period": 60 } }
  ],

  "vars": {
    "ENVIRONMENT": "production",
    "TURNSTILE_ENABLED": "false"
  },

  "observability": { "enabled": true }
}
```

Two bindings sharing a `namespace_id` share counters, even across Workers on the account — so keep these IDs unique to this service and note them somewhere if other Workers get added later.

`TURNSTILE_SECRET` is a secret, not a var, and is only needed if Turnstile is ever switched on:

```bash
npx wrangler secret put TURNSTILE_SECRET
```

## Migrations

```bash
npx wrangler d1 migrations apply coinless-scores --local    # dev
npx wrangler d1 migrations apply coinless-scores --remote   # production
```

Keep `migrations/0001_init.sql` as the single source of schema truth. Never hand-edit production tables — the next migration file becomes untrustworthy the moment the schema and the migration history disagree.

## Local development

```bash
npx wrangler dev --local
# ENVIRONMENT must be 'dev' locally for the origin allowlist to accept localhost
```

## Deploy

```bash
npx wrangler deploy
```

Then enable the `scores.coinlessgames.com` route in the dashboard.

---

## Smoke test sequence

Run these in order against production immediately after the first deploy.

**1. Health**

```bash
curl https://scores.coinlessgames.com/v1/health
# → {"ok":true,"games":["orbital-overhaul"]}
```

**2. Origin check rejects a bare submit**

```bash
curl -X POST https://scores.coinlessgames.com/v1/scores \
  -H 'Content-Type: application/json' -d '{}'
# → 403 ORIGIN_NOT_ALLOWED
```

**3. Valid submit**

```bash
curl -X POST https://scores.coinlessgames.com/v1/scores \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://coinlessgames.com' \
  -d '{
    "game_id":"orbital-overhaul","game_version":"0.0.0-test",
    "run_id":"11111111-1111-4111-8111-111111111111",
    "player_id":"22222222-2222-4222-8222-222222222222",
    "display_name":"TESTER","metric":1000,"duration_s":120,
    "outcome":"died","stats":{"wave_reached":3},"new_achievements":[]
  }'
# → 200, public_id, flagged:false, rank present
```

**4. Idempotency — repeat step 3 verbatim**

```
# → 200 with "duplicate": true and the SAME public_id
```

**5. Flagging — implausible rate**

```bash
# same as step 3 but metric 9000000, duration_s 10
# → 200 with "flagged": true
```

**6. Name rejection**

```bash
# same as step 3 with "display_name":"WAY TOO LONG A NAME"
# → 400 INVALID_NAME
```

**7. Board read**

```bash
curl 'https://scores.coinlessgames.com/v1/scores?game=orbital-overhaul&window=24h&limit=25'
# → entries array, ranks starting at 1
```

**8. Top-players semantics** — submit a second run for the same `player_id` with a **lower** metric and a new `run_id`, then re-read the board. The player must still appear **once**, showing the higher score. This is the single most important behavioral check; it's easy to implement top-25-*runs* by accident.

**9. Window boundaries** — read with `window=all` and `window=4h` and confirm both return sensible results and that `year` behaves as a rolling 365 days.

**10. Rate limit** — fire 5 submits in under a minute from one IP; the 4th should return 429 `RATE_LIMITED`.

---

## After the smoke test

Clean up test rows:

```bash
npx wrangler d1 execute coinless-scores --remote \
  --command "DELETE FROM scores WHERE game_version = '0.0.0-test'"
```

Record a baseline for cost awareness. D1 returns a `meta` object per query containing `rows_read` and `rows_written`; log those from the board handler during the smoke test and note the numbers. Free plan headroom is 5M rows read/day and 100k written/day, so there is enormous room — but knowing the per-request scan size now makes it obvious later if a query starts scanning the whole table.

---

## Rollout order

1. Deploy Worker + migrations, run the smoke test with the permissive default validator. **The API is complete and usable at this point.**
2. Separate session: instrument Orbital Overhaul's `stats`, integrate `kit-leaderboard` per the client API doc.
3. With real `stats` flowing, write Orbital Overhaul's game-specific `validate()` using the actual scoring constants and redeploy the Worker. Backfilled flagging is not retroactive, which is fine — early rows predate any real board.

Step 3 is the piece deliberately deferred. Nothing in steps 1 or 2 blocks on it.