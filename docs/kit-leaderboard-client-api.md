# kit-leaderboard — Client Module API

**Module:** `kit-leaderboard`
**Part of:** coinless-kit
**Depends on:** nothing (no other kit module, no third-party library)
**Talks to:** `scores.coinlessgames.com` (see the Worker spec)

> This is the first coinless-kit module doc, so it doubles as the template for the other six.
> The contract below is what a game reads. A game should never need to read this module's source.

---

## Contract summary

The game passes configuration **in** and receives results **out**. The module never reaches into game state, never touches the DOM, never renders anything. All UI — the board screen, the name entry field, the rename warning — belongs to the game (or later, to `kit-menu`).

The module owns exactly three things: talking to the API, queueing failed submits, and validating names client-side.

---

## Creating an instance

```js
const board = KitLeaderboard.create({
  endpoint:    'https://scores.coinlessgames.com',
  gameId:      'orbital-overhaul',
  gameVersion: '1.0.0.30',

  // Called whenever the module needs identity. Must return the CURRENT
  // profile — the game owns profiles, this module does not cache them.
  getPlayer: () => ({ playerId: '3f2a9e5c-...', displayName: 'GHOST' }),

  // Optional.
  storageKey:      'coinless.lb.orbital-overhaul.v1',  // default derived from gameId
  timeoutMs:       8000,
  turnstileToken:  null,     // or () => token, when Turnstile is enabled
  onEvent:         (name, detail) => {}
});
```

`getPlayer` is a function rather than a value so a mid-session profile switch or rename is picked up without recreating the instance.

---

## Methods

### `board.beginRun() → runId`

Call at the **start** of a run, not the end. Returns a UUID and stores it internally as the current run. This is the idempotency key: every retry of this run reuses it, so a duplicate submit can never produce a duplicate board entry.

Calling `beginRun()` again discards the previous unsubmitted run ID.

### `board.submit(result) → Promise<SubmitResult>`

```js
const outcome = await board.submit({
  metric:          42000,
  durationS:       612,
  outcome:         'died',            // 'died' | 'completed' | 'quit'
  stats:           { wave_reached: 14, canisters_delivered: 96, /* ... */ },
  newAchievements: ['dock_king']      // unlocked THIS RUN only — never a lifetime list
});
```

`runId`, `playerId`, `displayName`, `gameId`, and `gameVersion` are filled in by the module.

**Never rejects on network failure.** Resolves with one of:

```js
{ status: 'submitted', publicId: 'kx3d7q9m', flagged: false,
  rank: { allTime: 12, h24: 3 }, duplicate: false }

{ status: 'queued',    reason: 'offline' | 'server_error' | 'rate_limited' | 'timeout' }

{ status: 'rejected',  code: 'INVALID_NAME', message: '...' }
```

`rejected` means permanently rejected — a bad name or malformed payload. These are **not** queued, because retrying produces the same rejection forever. Everything else is queued.

The game should treat `queued` as success from the player's perspective: the local high score table is authoritative locally, and the network board is additive. Show something like "score saved — will post when you're back online," never an error.

### `board.fetchBoard({ window, limit }) → Promise<Board>`

```js
const b = await board.fetchBoard({ window: '24h', limit: 25 });
// { gameId, window, metricLabel, generatedAt, entries: [...] }
```

`window` ∈ `4h | 8h | 12h | 24h | 7d | 30d | year | all` (default `all`). `limit` default 25, max 100.

Entries are **top players**, not top runs: one row per player, their best run in the window, with `stats` / `outcome` / `durationS` from that same run.

Rejects on network failure — reading a board is a foreground action with a visible retry, unlike submitting.

### `board.queueLength() → number`

Pending submits. Useful for a small "1 score waiting to post" indicator on the title screen.

### `board.flushQueue() → Promise<{ sent, failed, dropped }>`

Attempt all queued submits now. Called automatically (see below); expose a manual trigger only if you want a retry button.

---

## The offline queue

**Required behavior in every game.** A great run must never vanish because the wifi hiccuped.

- Failed transient submits are persisted to `localStorage` under `storageKey`.
- The queue is flushed on `create()`, on `window` `online` events, and after any successful submit.
- Retry uses exponential backoff (2s, 8s, 30s, then once per session) so a down endpoint doesn't produce a request storm.
- Cap: 20 entries. When full, the **lowest-metric** entry is dropped, not the oldest — the point is to preserve the runs a player would care about.
- Entries older than 30 days are dropped on load. A late arrival is still ranked by its *server* receipt time, so a score sitting in the queue for a week will land in the 24h window on the day it finally posts. Accept this; the alternative is trusting client timestamps.
- `localStorage` unavailable (private browsing, embedded iframes with storage blocked): the module degrades to no queue and reports `status: 'queued', reason: 'offline'` truthfully but forgets. It must not throw.

---

## Name validation

```js
KitLeaderboard.validateName('Gh0st!')
// → { ok: false, reason: 'illegal_character', normalized: null }

KitLeaderboard.validateName('  ghost ')
// → { ok: true, reason: null, normalized: 'GHOST' }
```

Rules mirror the server: 1–12 chars after normalization, `A-Z 0-9 space - _`, uppercased, internal whitespace collapsed, no Unicode. The client check is **UX only** — the server is authoritative and may still return `NAME_REJECTED` for profanity, which the client filter deliberately does not duplicate (keeping the wordlist out of shipped game source is the point).

### Required: the rename warning

Old board entries keep the display name they were submitted with. A player who renames themselves will see both names on the board and should not be surprised by it.

```js
KitLeaderboard.NAME_CHANGE_NOTICE
// "Scores you've already posted will keep the name you used at the time.
//  Only new scores will show your new name."
```

Show this in the rename flow, before confirmation, with the option to cancel.

This notice is a *leaderboard* fact but a *profile UI* concern — which makes it the first real test of where the seams between kit modules fall. In v1 it lives here as a constant the game renders. When `kit-menu` / profile management is extracted, that module should import the constant rather than re-type the sentence.

---

## Events

`onEvent(name, detail)` fires for: `submitted`, `queued`, `flushed`, `rejected`, `board_loaded`, `error`. Intended for telemetry, a queue indicator, or a debug overlay. Nothing in the module's behavior depends on the game handling them.

---

## What this module deliberately does not do

- **Mint or store `player_id`.** The game owns profiles. This module asks for identity via `getPlayer()` and never persists it.
- **Track achievements.** It transmits IDs the game says were unlocked this run. Achievement *logic* is a separate future kit module.
- **Maintain local high scores.** Local scores are a separate concern that must keep working with no network at all.
- **Render anything.**

---

## Integration checklist for a new game

1. Ensure the game mints a `player_id` UUID per local profile.
2. Add the game's registry entry to the Worker (`gameId`, sort direction, metric label, plausibility bounds, achievement ID set) and deploy.
3. Instrument the game to collect the `stats` fields declared in that registry entry — every scoring path must be represented, or the bound check can't work.
4. `beginRun()` at run start.
5. `submit()` at game over, including quits, with `newAchievements` from this run.
6. Render the board from `fetchBoard()`, showing a marker on `flagged` entries.
7. Show `NAME_CHANGE_NOTICE` in the rename flow.
8. Show queue state on the title screen if `queueLength() > 0`.