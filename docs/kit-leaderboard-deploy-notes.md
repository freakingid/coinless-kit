# kit-leaderboard — Deploy & Smoke Test Notes

Target: `scores.coinlessgames.com` on the same Cloudflare account and zone as coinlessgames.com. The zone is active; the route is set up and currently disabled pending this Worker.

---

## Prerequisites

- Wrangler **4.36 or later** (required for the stable rate limiting binding).
- The `coinlessgames.com` zone active on Cloudflare — confirmed.
- A DNS record for `scores`. Attaching a Worker route usually creates what it needs; if not, a proxied placeholder `AAAA` to `100::` is the conventional trick.

---

## Create the database

```bash
npx wrangler d1 create coinless-scores
# copy the returned database_id into wrangler.jsonc
```

## DNS gotcha: the route does not create the DNS record

Attaching a `routes` entry in `wrangler.jsonc` and running `wrangler deploy`
does **not** reliably create the DNS record for a new subdomain — the route
can be live on the Worker side while `scores.coinlessgames.com` still
resolves to nothing.

Confirm and fix if needed:

```bash
dig +short scores.coinlessgames.com
```

If that's empty, add a proxied placeholder record manually in the
dashboard (DNS → Add record):

    Type: AAAA
    Name: scores
    IPv6: 100::
    Proxy status: Proxied (orange cloud)

The `100::` address is a conventional discard address — traffic never
actually goes there, because the orange-cloud proxy intercepts it and
routes to the Worker instead. This is a placeholder to satisfy Cloudflare's
DNS, not a real endpoint.

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

## Known gap: rate limiting is not enforced on the Workers Free plan

The `ratelimits` binding above works correctly in local `wrangler dev` but
**does not enforce in production on the Workers Free plan** — rapid
successive submits from one IP all return 200 with no 429. Confirmed by
sending 9 rapid submits against the live endpoint.

Practical effect: right now, nothing in production actually caps submission
rate. The Origin allowlist was always non-security (trivially forged with
`curl -H`), so at present there is no real deterrent to scripted submission
spam beyond the bounds check flagging obviously-implausible scores.

Accepted as-is for now, given current traffic. If the board is ever
actually targeted:

- Upgrading to Workers Paid is the most direct fix (rate limiting is
  documented as enforced there).
- Turnstile (§7) was built dark for exactly this situation — flipping
  `TURNSTILE_ENABLED` to `'true'` and adding the client script raises the
  bar considerably without a plan upgrade.

Revisit only if abuse is actually observed — not worth solving preemptively.

Two bindings sharing a `namespace_id` share counters, even across Workers on the account — keep these IDs unique to this service and note them somewhere if other Workers get added later.

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
# -> {"ok":true,"games":["orbital-overhaul"]}
```

**2. Origin check rejects a bare submit**

```bash
curl -X POST https://scores.coinlessgames.com/v1/scores \
  -H 'Content-Type: application/json' -d '{}'
# -> 403 ORIGIN_NOT_ALLOWED
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
    "outcome":"died","stats":{"wave_reached":3}
  }'
# -> 200, public_id, flagged:false, rank present
```

**4. Idempotency — repeat step 3 verbatim**

```
# -> 200 with "duplicate": true and the SAME public_id
```

**5. Flagging — implausible rate**

Same as step 3 but `"metric":900000, "duration_s":10` (900k over 10s is 90,000/sec against a 550/sec ceiling).

```
# -> 200 with "flagged": true and flag_reason mentioning rate_implausible
```

**6. Name rejection**

Same as step 3 with `"display_name":"WAY TOO LONG A NAME"`.

```
# -> 400 INVALID_NAME
```

**7. Board read**

```bash
curl 'https://scores.coinlessgames.com/v1/scores?game=orbital-overhaul&window=24h&limit=25'
# -> entries array, ranks starting at 1
```

**8. Top-players semantics** — submit a second run for the same `player_id` with a **lower** metric and a new `run_id`, then re-read the board. The player must still appear **once**, showing the higher score.

This is the single most important behavioral check. Top-25-*runs* is very easy to implement by accident, and it looks correct until one strong player owns the whole board.

**9. Window boundaries** — read with `window=all` and `window=4h`, confirm both return sensible results, and confirm `year` behaves as a rolling 365 days rather than a calendar year.

**10. Rate limit** — fire 5 submits in under a minute from one IP; the 4th should return 429 `RATE_LIMITED`.

**11. Unknown stats key** — submit with `"stats":{"nonsense_key":1}`. Should return 200 with `flagged: true`, not an error. Confirms drift is visible but non-blocking.

---

## After the smoke test

Clean up test rows:

```bash
npx wrangler d1 execute coinless-scores --remote \
  --command "DELETE FROM scores WHERE game_version = '0.0.0-test'"
```

Record a cost baseline. D1 returns a `meta` object per query containing `rows_read` and `rows_written`; log those from the board handler during the smoke test and note the numbers. Free plan headroom is 5M rows read/day and 100k written/day, so there is enormous room — but knowing the per-request scan size now makes it obvious later if a query starts scanning the whole table.

---

## Rollout order

1. Deploy Worker + migrations, run the smoke tests. **The API is complete at this point** — there is no deferred validator phase, since per-game plausibility checks were deliberately dropped.
2. Separate session: integrate `kit-leaderboard` into Orbital Overhaul per the client API doc's integration checklist, collecting whichever display stats look good on a board row.
3. Later, separately: the achievements module and its own API.

Nothing in step 1 blocks on the game, and nothing in step 2 blocks on step 3.