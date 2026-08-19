# kit-storage — Design & Implementation Spec

**Module:** `kit-storage`
**Part of:** coinless-kit
**Version:** v0.1.0
**Depends on:** nothing
**Talks to:** nothing — local only, no server component, no deploy notes doc
**Scope:** persistence primitives. Namespacing, versioning, graceful degradation.

> This is the implementation contract. A game reads
> `kit-storage-client-api.md` instead; it should never need this doc or the
> module source. This doc is what a Claude Code session implements against.

---

## 1. Why this module exists

Four problems recur in every other kit module, and solving them once is the
entire justification for a module this small:

1. **`localStorage` may be entirely unavailable** — embedded iframes on
   itch.io and Newgrounds with storage blocked, private browsing, or
   enterprise policy. Access to `window.localStorage` can *throw on property
   read*, not merely return null. Every consumer must degrade, not crash.
2. **Keys need namespacing per game**, or two coinless games served from the
   same origin collide.
3. **Schema versioning**, so a format change migrates rather than corrupts.
4. **Quota** (~5MB nominal, materially less in some embedded contexts), which
   surfaces as a thrown `QuotaExceededError` on write with no advance warning.

kit-storage owns exactly those four things and nothing else.

---

## 2. Governing principles

These are the rules every other decision in this doc derives from. A future
session resolving an ambiguity should resolve it in the direction these point.

### 2.1 Environmental failure is a return value. Programmer error is an exception.

Storage being blocked, full, corrupt, or holding an unknown format is *normal
operating condition* on the platforms these games ship to. None of it throws.
It surfaces as a `false` return, a fallback value, and an event.

Calling the API wrong — an undeclared key, an illegal key name, an
unserializable value — is a bug in the calling module, and it throws
immediately and loudly at the call site. This distinction is deliberate: the
recurring failure mode in this project is *silent empty results*, not crashes.
Making misuse loud is how a typo'd key name gets caught in the first playtest
rather than a month later when a player reports lost settings.

### 2.2 kit-storage never decides what data is worth keeping.

It does not evict. It does not prune. It does not compress. When a write
doesn't fit, it reports that and the owning module decides what to shed —
because only the owning module knows. kit-leaderboard drops the
**lowest-metric** queue entry rather than the oldest, precisely because
"oldest" would throw away the run the player cares about. kit-storage cannot
know that about anyone's data. See §8.

### 2.3 kit-storage does not know what a profile is.

Scoping is a generic prefix tree. `scope('p1')` is "one more path segment,"
nothing more. kit-profile supplies the id; achievements, settings, and local
scores can scope by the same id without any of them depending on kit-profile
to compute a string. See §6.

### 2.4 Never destroy data you don't understand.

Corrupt JSON, an unrecognized envelope, a version *newer* than the running
build — all return the fallback and **leave the stored bytes untouched**. The
one and only case where kit-storage overwrites existing data on a read path is
a successful forward migration (§7.3). A build that can't read something is
not evidence that the something is worthless.

---

## 3. Keyspace

### 3.1 Layout

```
coinless.<gameId>.<key>                 root scope
coinless.<gameId>.<scopeId>.<key>       one scope deep
coinless.<gameId>.<scopeId>.<scopeId>.<key>   nested (supported, unused today)
```

`.` is the segment separator and is therefore **illegal inside `gameId`,
`scopeId`, and `key`**. This is what makes enumeration unambiguous: after
stripping the store's prefix, a remainder containing no `.` is an own-level
key, and a remainder containing one or more belongs to a nested scope. §9
depends on this.

### 3.2 Validation

| Identifier | Pattern | Notes |
|---|---|---|
| `gameId` | `^[a-z0-9][a-z0-9-]{2,31}$` | 3–32 chars |
| `scopeId` | `^[a-z0-9][a-z0-9_-]{0,63}$` | 1–64 chars |
| `key` | `^[a-z0-9][a-z0-9_-]{0,63}$` | 1–64 chars |

Violations throw `TypeError` at `create()` / `scope()` / call time (§2.1).

### 3.3 Reserved: `coinless.lb.*`

kit-leaderboard v0.1.0 already owns `coinless.lb.<gameId>.v1` for its offline
queue. The 3-character minimum on `gameId` makes a collision structurally
impossible — `lb` is two characters and can never be a valid `gameId`. That is
the reason for the minimum; do not relax it.

**kit-leaderboard is not a kit-storage consumer.** It is tagged, dependency-free
by its own doc, and its queue key sits outside kit-storage's namespace.
`clear()` never touches it. If kit-leaderboard is ever rebuilt on kit-storage,
that is a deliberate change to kit-leaderboard's contract — see §5.3, because
its degradation semantics differ from this module's on purpose.

### 3.4 The raw escape hatch

Orbital Overhaul has pre-kit keys in production that predate any namespace:
`afd_settings_v1`, `afd_achievements_v2`, `afd_profiles_v1`. `PROFILE_LEGACY =
"p0"` exists specifically so those keys never move. Any namespacing scheme
that cannot address an unprefixed key breaks real saves on extraction.

`store.raw` therefore reads and writes **unprefixed, unversioned,
un-enveloped strings**. It is an escape hatch for legacy and migration paths.
A module using it must say so in its own doc.

---

## 4. On-disk format

Every kit-storage-managed value is stored as a JSON envelope:

```json
{"v":1,"d":<the value>}
```

- `v` — integer schema version of `d`, ≥ 1.
- `d` — the value, as supplied to `set()`. Any JSON-representable value:
  object, array, string, number, boolean, or `null`.

Nothing else lives in the envelope. No timestamps, no checksums, no key echo —
each would be a field to migrate later for no present benefit.

kit-storage does **not** validate the shape of `d`. It guarantees you get back
either valid JSON at the declared version, or your fallback. It does not
guarantee the JSON is the *right* JSON. Field-level known-value-else-default
checking stays in the module that owns the shape — exactly as Orbital
Overhaul's `Profiles.load()` does it today. That code is correct and should
not be pushed down into kit-storage; a generic validator would have to be
either useless or a schema language.

---

## 5. Availability and the memory shim

### 5.1 Detection

Probed **once**, at `create()`, matching kit-leaderboard's approach:

```js
let ls = null;
try {
  ls = window.localStorage;             // property access itself can throw
  const probe = 'coinless.__probe';
  ls.setItem(probe, '1');
  ls.removeItem(probe);
} catch (e) {
  ls = null;
}
```

`store.available` is `ls !== null`. It is not re-probed, and a later quota
failure does not flip it to `false` — availability means "storage exists and
accepts writes," not "storage has room."

### 5.2 The memory shim

**Any value that fails to reach durable storage is retained in memory for the
rest of the page session.** One rule, covering both the storage-unavailable
case and the quota-exceeded case.

- `set()` returns `false` — the value is **not durable**.
- `get()` returns that value for the remainder of the session.
- On reload it is gone.

The memory map holds **only non-durable values**. A successful `set()` removes
any memory entry for that key, so a durable write is never shadowed by a stale
in-memory copy. `remove()` clears both. There is no read cache: a `get()` with
no memory entry always re-reads storage.

Consequence worth stating plainly: after a quota-failed `set()`, `get()`
returns the new value from memory while storage still holds the old one. On
reload the old value comes back. This is correct — `set()` already returned
`false` to say so.

### 5.3 Why this differs from kit-leaderboard

kit-leaderboard's offline queue keeps **nothing** in memory when storage is
blocked; `push()` is a no-op and `queueLength()` reports 0. That is right for a
queue, whose entire job is to outlive the failure that filled it — an
in-memory queue dies on reload and buys a nonzero-but-unflushable count for the
trouble.

Settings, profiles, and identity are the opposite case. An itch.io embed
session is frequently a single page load, and a player whose profile name
resets mid-session because storage is blocked is playing a broken game, not a
degraded one.

The reconciling detail: `set() === true` still means "persisted" in both
modules. The shim changes only readback within one page load, so any consumer
keying off the boolean behaves identically under either module's rules.

---

## 6. Scopes

```js
const ps = store.scope('p1');   // coinless.orbital-overhaul.p1.<key>
```

A scoped store exposes the **same interface** as its parent, including
`scope()` for further nesting.

Shared with the root instance, not copied:

- the availability probe result and the underlying `localStorage` handle
- the `onEvent` handler
- **the key declaration table** (§7.1)

Declarations being store-wide rather than per-scope is what makes this work:
`store.declare('achievements', {version: 2, migrate})` once, and
`store.scope('p1').get('achievements')` and `store.scope('p7')` both migrate
correctly. Per-profile keys are the same key in every profile.

`store.raw` is unprefixed by definition and is therefore identical on a scoped
store and its parent. It is exposed on both for convenience; it is not scoped.

### 6.1 kit-profile's legacy transparency, for reference only

kit-profile will reproduce Orbital Overhaul's `keyFor()` behavior — where the
legacy profile `p0` addresses the parent scope directly — with:

```js
const scopeFor = id => (id === PROFILE_LEGACY ? store : store.scope(id));
```

Noted here so a future session doesn't add a "transparent scope" feature to
kit-storage. It is not needed. kit-storage stays ignorant of profiles (§2.3).

---

## 7. Versioning and migration

### 7.1 Keys are declared, not versioned per call

Version travels with the key, never with the call site. A caller that passes
version 2 in one file and forgets in another silently corrupts data, so the
API removes the opportunity.

```js
KitStorage.create({
  gameId: 'orbital-overhaul',
  keys: {
    profiles:     { version: 1 },
    settings:     { version: 2, migrate(from, data) { /* ... */ } },
    achievements: { version: 2, migrate(from, data) { /* ... */ } }
  }
});
```

Modules that receive a store they did not create register their own keys:

```js
store.declare('achievements', { version: 2, migrate });
```

- `declare()` is idempotent when the spec is identical (same version, same
  function reference).
- A conflicting redeclaration **throws** — two modules fighting over one key's
  version is a bug that must not resolve silently.
- `get()`, `set()`, `has()` or `remove()` on an **undeclared** key throws.
  This is the typo guard; it is the main reason declaration is mandatory
  rather than defaulted.
- `keys()`, `clear()`, `scopes()`, `usage()` operate on what is *stored*, not
  what is declared, and never throw for undeclared keys — enumeration must be
  able to see leftovers from an older build.

**Versions are per key, not per store.** Bumping the profile format must not
force a no-op migration on settings and achievements. Production already works
this way: `afd_profiles_v1` and `afd_achievements_v2` carry independent
versions today.

### 7.2 Deviation from the component plan

The plan sketched `store.migrate(fromVersion, migrationFn)` as a method. That
shape can't express "which key," and it invites migration being registered
after a read has already happened. Declaring `migrate` alongside `version` on
the key subsumes it. Record this in `DECISIONS.md` when implementing.

### 7.3 Read algorithm

On `get(key, fallback)`, with `V` the declared version:

1. Memory shim holds this key → return that value. Done.
2. Storage unavailable, or no stored value → return `fallback`.
3. `JSON.parse` throws, or the result is not an object with an integer `v` ≥ 1
   and a `d` property present → emit `corrupt`, return `fallback`, **leave
   the bytes alone**.
4. `stored.v === V` → return `stored.d`.
5. `stored.v > V` — **downgrade.** Emit `downgrade`, return `fallback`,
   **write nothing.** The player has loaded an older build over newer data
   (a cached itch.io build, a rollback). Overwriting newer data with an older
   format is the one genuinely destructive move available here, and it is
   never taken. This case is easy to get wrong by treating any mismatch
   uniformly — it is called out separately for that reason.
6. `stored.v < V` and no `migrate` declared → emit `corrupt`, return
   `fallback`, write nothing.
7. `stored.v < V` with `migrate` → call `migrate(stored.v, stored.d)`.
   - Throws, or returns `undefined` → emit `error`, return `fallback`, write
     nothing.
   - Returns a value → `set()` it at version `V` (best-effort; a failed
     write-back is not an error and does not change the return), emit
     `migrated`, return the value.

`migrate` receives the **origin version** and must handle any version below
`V` it cares about — there is no migration chaining. With two or three
lifetime versions per key this is simpler than a chain and easier to test.
`migrate` must be pure and must not call back into the store.

If the write-back fails, migration simply runs again on the next load. Write
`migrate` so that is harmless.

---

## 8. Quota

- `set()` wraps `setItem` in try/catch. Any throw → the value goes to the
  memory shim (§5.2), an event fires, `set()` returns `false`.
- A `QuotaExceededError` (or `NS_ERROR_DOM_QUOTA_REACHED`, or DOM code 22 /
  1014 — browsers disagree, so detect by name *or* code and treat any
  unrecognized write failure as quota anyway) emits `quota` with
  `{ key, bytes }`. Any other throw emits `error`.
- **No eviction, ever.** Not LRU, not oldest-first, not largest-first. §2.2.
- `usage()` returns `{ bytes, keys }` for this store's prefix, `bytes`
  estimated as `(key.length + value.length) * 2` summed — UTF-16, which is
  what browsers count. It is an estimate and the doc says so.

`navigator.storage.estimate()` was considered and rejected: it is async,
which would infect the whole API (§10), and it does not report `localStorage`
usage reliably across browsers. There is no dependable "how much room is left"
API. `set() === false` is the signal modules act on.

---

## 9. Enumeration

Given the store's prefix `P`, walk `localStorage` keys starting with `P` and
strip it:

- remainder contains no `.` → an own-level key.
- remainder contains a `.` → its first segment is a child scope id.

Therefore:

- `keys()` → own-level logical key names, sorted. Excludes nested scopes.
- `scopes()` → distinct child scope ids, sorted. One level only.
- `clear()` → removes own-level keys only. Returns the count removed.
- `clear({ deep: true })` → own-level keys **and** every nested scope.

Own-level-only as the default is deliberate: a caller who means "wipe this
profile completely" should have to type `deep`.

All four also clear matching entries from the memory shim.

**`clear()` never touches `coinless.lb.*`, unprefixed legacy keys, or another
game's namespace** — it only walks its own prefix. §3.3, §3.4.

### 9.1 Note for kit-profile (Phase 2)

Orbital Overhaul's `Profiles.remove()` deliberately does **not** clear the
removed profile's stores, which is why `seq` is monotonic — a recycled id must
never inherit a dead profile's data. `scope.clear()` existing does not oblige
kit-profile to call it, and the Phase 2 default should remain "don't." The
capability exists because deleting a profile's data is impossible to do
*safely* from outside kit-storage: the alternative is kit-profile either
reaching around its own dependency into `localStorage` or maintaining a
manifest of every key any other module ever wrote.

---

## 10. Synchronous, on purpose

The whole API is synchronous. `localStorage` is synchronous, every existing
consumer is synchronous, and an async API would tax every call site in every
module forever in exchange for a backend nobody has asked for. If cloud saves
ever happen, that is a new module with its own contract, not a retrofit of
this one.

---

## 11. Events

`onEvent(name, detail)` — same shape as kit-leaderboard's. Telemetry and debug
overlays only; **no module behavior depends on any of these being handled.**

| Event | Fires when | `detail` |
|---|---|---|
| `unavailable` | once, at `create()`, if the probe failed | `{ error }` |
| `quota` | a write failed on quota | `{ key, bytes }` |
| `corrupt` | unparseable, bad envelope, or version below declared with no `migrate` | `{ key, reason }` |
| `downgrade` | stored version is newer than declared | `{ key, stored, declared }` |
| `migrated` | a forward migration succeeded | `{ key, from, to }` |
| `error` | `migrate` threw or returned `undefined`; any non-quota write failure | `{ key, error }` |

`onEvent` throwing must never break the caller — wrap invocation in try/catch.

---

## 12. Module shape

Plain ES module, no dependencies, no DOM access beyond `window.localStorage`.
Named exports, matching kit-leaderboard's precedent:

```js
export function create(config) { /* ... */ }
```

so a consumer writes `import * as KitStorage from './kit-storage.js'` and the
doc's `KitStorage.create(...)` call sites work unmodified.

Two `create()` calls with the same `gameId` return independent instances over
the same keyspace with **separate declaration tables**. That is a footgun, not
a feature: create once per game and pass the instance around, as the component
plan's `KitProfile.create({ storage })` already assumes.

---

## 13. Things a future session must not "fix"

- ⛔ **Don't add eviction.** §2.2. `set()` returning `false` is the contract.
- ⛔ **Don't make the downgrade case (§7.3 step 5) write.** It is the only
  path that can destroy newer data, and it is deliberately inert.
- ⛔ **Don't add schema validation of `d`.** §4. Field checking belongs to the
  module that owns the shape.
- ⛔ **Don't make the API async.** §10.
- ⛔ **Don't teach kit-storage about profiles.** §2.3, §6.1.
- ⛔ **Don't relax the 3-character `gameId` minimum.** It is what keeps
  `coinless.lb.*` uncollidable. §3.3.
- ⛔ **Don't remove `raw`.** Real production keys live outside the namespace
  and cannot be moved. §3.4.
- ⛔ **Don't make undeclared-key access default to version 1 instead of
  throwing.** The throw is the typo guard. §7.1.

---

## 14. Implementation checklist

1. `create(config)` — validate `gameId`, probe availability, build the
   declaration table from `config.keys`, wire `onEvent`, emit `unavailable`
   if the probe failed.
2. Key/scope validators; `.` rejected everywhere.
3. Envelope read/write with the full §7.3 algorithm.
4. Memory shim map, wired into `get` / `set` / `remove` / `clear`.
5. `scope()` returning the same interface over a longer prefix, sharing probe
   result, declarations, and `onEvent`.
6. Enumeration (`keys`, `scopes`, `clear`, `usage`) via prefix walk + segment
   count.
7. `raw.get/set/remove/has` — unprefixed strings, same shim and error rules.
8. `declare()` with idempotency and conflict-throw.

---

## 15. Test checklist

Verify in a real browser, not only in Node with a mock — the failure modes
that matter are browser-specific. A blocked-storage context can be simulated
with a sandboxed iframe lacking `allow-same-origin`.

**Happy path**
- Round-trip object, array, string, number, boolean, `null`.
- `get()` on an absent key returns the fallback.
- `remove()` then `get()` returns the fallback.
- Two scopes hold independent values under the same logical key.
- Nested scope round-trips.

**Namespacing**
- Two stores with different `gameId`s do not see each other's keys.
- `clear()` on one game leaves the other's keys and `coinless.lb.*` intact.
- `keys()` excludes nested-scope keys; `clear()` leaves them; `clear({deep:true})` removes them.
- `scopes()` lists child ids once each, not per key.

**Versioning**
- Same version → value returned, storage byte-identical afterward.
- Lower stored version + `migrate` → migrated value returned, `migrated`
  emitted, **and the stored envelope now reads the new version** (re-read to
  confirm the write-back happened).
- Lower stored version, no `migrate` → fallback, `corrupt` emitted, **stored
  bytes unchanged**.
- **Higher stored version → fallback, `downgrade` emitted, stored bytes
  unchanged.** Assert on the bytes, not just the return value.
- `migrate` that throws → fallback, `error` emitted, bytes unchanged.

**Corruption**
- Hand-write non-JSON at a managed key → fallback, `corrupt`, bytes unchanged.
- Hand-write valid JSON that isn't an envelope → same.

**Degradation**
- Blocked-storage context: `create()` does not throw, `available === false`,
  `unavailable` emitted once.
- Blocked: `set()` returns `false`, `get()` returns the value in-session,
  a fresh `create()` in a new page load does not see it.
- Blocked: `remove()`, `clear()`, `keys()`, `usage()` all behave and none throw.
- Quota: fill storage, then `set()` → returns `false`, `quota` emitted,
  `get()` returns the new value from memory, and a re-read from storage still
  holds the old one.
- Successful `set()` after a failed one clears the memory entry — reload shows
  the durable value, not the shimmed one.

**Programmer error (these must throw)**
- Undeclared key on `get` / `set` / `has` / `remove`.
- Illegal `gameId`, `scopeId`, `key`; anything containing `.`.
- `set(key, undefined)` — use `remove()`.
- Circular value.
- Conflicting `declare()`.

**Raw**
- `raw.get/set/has/remove` on an unprefixed key; `clear()` does not touch it;
  `keys()` does not list it.
- `raw.has()` on all of `PROFILE_LEGACY_PROBE` in a blocked context returns
  `false` without throwing.