# kit-storage — Client Module API

**Module:** `kit-storage`
**Part of:** coinless-kit
**Tag:** v0.1.0
**Depends on:** nothing (no other kit module, no third-party library)
**Talks to:** nothing — local only, no server, no network
**Scope:** persistence primitives. Namespacing, versioning, graceful degradation.

> The contract below is what a game or another kit module reads. Nothing should
> need to read this module's source. Design rationale and the implementation
> contract live in `kit-storage-spec.md`.

---

## Contract summary

kit-storage is not a feature module — it's the shared dependency every other
kit module persists through. It owns exactly four things: namespacing keys per
game, versioning and migrating stored values, degrading without throwing when
storage is blocked or full, and reporting what it couldn't do.

It owns none of these: deciding what data is worth keeping, validating the
shape of your data, knowing what a profile is, or talking to a network.

Two rules explain most of the API:

- **Environmental failure is a return value; programmer error is an exception.**
  Blocked storage, a full quota, corrupt bytes, an unknown version — all
  normal, none throw. An undeclared key or an illegal key name is a bug in
  your code and throws immediately.
- **kit-storage never throws away your data to make room.** When a write
  doesn't fit, `set()` returns `false` and you decide what to shed.

Everything is synchronous.

---

## Creating an instance

```js
import * as KitStorage from './kit-storage.js';

const store = KitStorage.create({
  gameId: 'orbital-overhaul',

  // Every key you'll read or write must be declared, here or via declare().
  keys: {
    profiles: { version: 1 },
    settings: {
      version: 2,
      migrate(fromVersion, data) {
        if (fromVersion === 1) return { ...data, captions: false };
        return undefined;          // can't handle it — fall back, keep bytes
      }
    }
  },

  // Optional.
  onEvent: (name, detail) => {}
});
```

`gameId` is 3–32 chars, `[a-z0-9-]`, starting alphanumeric. **Create one store
per game and pass the instance around** — kit-profile and every other module
takes a store rather than making its own.

```js
store.available   // false in blocked-storage contexts (see below)
store.gameId
```

Keys are stored at `coinless.<gameId>.<key>`, so two coinless games on one
origin never collide.

---

## Declaring keys

```js
store.declare('achievements', { version: 2, migrate });
```

For modules that receive a store they didn't create. Declarations are
**store-wide**, shared by every scope — a per-profile key is the same key in
every profile, so you declare it once.

- `version` — integer ≥ 1. Required.
- `migrate(fromVersion, data)` — optional. See *Versioning*.

Redeclaring identically is a no-op. Redeclaring with a different version or
migrate function throws — two modules disagreeing about one key's version is a
bug, not something to resolve silently.

**Reading or writing an undeclared key throws.** This is on purpose: it's the
guard that turns `store.get('profile')` (missing an `s`) into an immediate
error instead of a silently empty result you find out about a month later.

---

## Reading and writing

### `store.get(key, fallback) -> value`

Returns the stored value, or `fallback` if there's nothing usable there —
absent, blocked storage, corrupt bytes, or a version this build can't read.
Never throws for any of those.

`fallback` is returned as-is, not cloned. Don't hand it a shared mutable
object you then mutate.

There's no read cache; every `get()` re-reads storage.

### `store.set(key, value) -> boolean`

Returns `true` if the value reached durable storage, `false` if it didn't.

`value` must be JSON-representable — object, array, string, number, boolean,
or `null`. `undefined` throws (use `remove()`), as does anything circular.
kit-storage does not validate the *shape* of what you store; it guarantees you
get back valid JSON at the version you declared, not that it's the right JSON.
Field-by-field known-value-else-default checking stays in your module, where
the shape is known.

A `false` return is not an error and not an exception — it's information. See
*When storage is blocked or full*.

### `store.has(key) -> boolean`
### `store.remove(key) -> boolean`

`remove()` returns `false` only if a durable copy existed and couldn't be
removed.

---

## Scopes

```js
const ps = store.scope('p1');
ps.set('settings', { ... });      // coinless.orbital-overhaul.p1.settings
```

A scoped store has the **same interface** as its parent, including `scope()`
for further nesting. It shares the parent's availability state, event handler,
and key declarations.

kit-storage has no idea what a scope *means*. It's one more path segment. You
supply the id — a profile id, a slot number, whatever. This is why achievements
and settings can scope by profile without depending on kit-profile for
anything but the id string.

```js
store.scopes()      // -> ['p1', 'p2']  direct children, one level
```

Scope ids are 1–64 chars, `[a-z0-9_-]`, starting alphanumeric.

---

## Enumeration and clearing

```js
store.keys()                    // own-level key names, sorted; excludes scopes
store.clear()                   // removes own-level keys only -> count
store.clear({ deep: true })     // ...and every nested scope -> count
store.usage()                   // -> { bytes, keys }  estimate, this prefix only
```

Own-level-only is the default deliberately: "wipe this profile completely"
should require typing `deep`.

All of these operate on what's *stored*, not what's declared — so they can see
leftovers from an older build — and none of them throw on undeclared keys.

`clear()` only ever walks this store's own prefix. It cannot touch another
game's namespace, kit-leaderboard's queue, or unprefixed legacy keys.

`usage()` is an estimate (UTF-16 bytes, keys plus values). No browser offers a
reliable "how much room is left" number for `localStorage`, so don't build a
budget on it — `set()` returning `false` is the real signal.

---

## Versioning

Version travels with the key, never with the call site — that's why keys are
declared. A caller passing version 2 in one file and forgetting in another is
exactly the kind of silent corruption this removes the opportunity for.

Versions are **per key**. Bumping the profile format doesn't force a no-op
migration on settings and achievements.

On `get()`, comparing the stored version to the declared one:

| Stored | Behavior |
|---|---|
| same as declared | value returned |
| **lower**, `migrate` declared | `migrate(storedVersion, data)` runs; result returned and written back at the new version; `migrated` fires |
| **lower**, no `migrate` | `fallback` returned, `corrupt` fires, **stored bytes untouched** |
| **higher** | `fallback` returned, `downgrade` fires, **stored bytes untouched** |
| unparseable / not an envelope | `fallback` returned, `corrupt` fires, **stored bytes untouched** |

The higher-version row is the one worth internalizing. It's a real scenario —
a cached itch.io build, a rollback — and the module's response is to read
nothing and write nothing. A build that can't understand your data is not
evidence the data is worthless.

`migrate` receives the **origin version** and handles any older version it
cares about; there's no chaining. Return `undefined` for a version you can't
handle and the fallback path takes over without destroying anything. Keep it
pure, don't call back into the store, and make it idempotent — if the
write-back can't persist (blocked storage), it simply runs again next load.

---

## When storage is blocked or full

`localStorage` is entirely unavailable in some embedded iframes on itch.io and
Newgrounds, and in private browsing. On those platforms this is a normal
operating condition, not an edge case.

**kit-storage never throws for it.** Every method works; `set()` just tells you
the truth about durability.

```js
store.available     // false — nothing here survives a reload
```

Any value that fails to reach durable storage — blocked *or* over quota — is
**retained in memory for the rest of the page session**. So:

- `set()` returns `false`: not durable.
- `get()` returns the value for the rest of this page load.
- A reload loses it.

This matters because an embed session is often a single page load. A player
whose profile name resets the moment they change screens is playing a broken
game; one whose settings work until they reload is playing a degraded one.

`set() === true` still means "persisted." The memory retention only affects
readback within one page load.

One consequence, stated plainly: after a quota failure, `get()` returns your
new value from memory while storage still holds the old one, and the old one
comes back on reload. `set()` already returned `false` to tell you that.

### What to do with `false`

**kit-storage will never evict anything to make room**, because it can't know
what's valuable. kit-leaderboard drops the *lowest-metric* queued run rather
than the oldest for exactly that reason. When `set()` returns `false`, your
module decides: shed something, warn the player, or carry on knowing this
session's data is session-only. Most modules should carry on — losing a
settings change on reload is not worth interrupting play over.

---

## Raw keys — the legacy escape hatch

```js
store.raw.get(key)        // -> string | null
store.raw.set(key, str)   // -> boolean
store.raw.has(key)        // -> boolean
store.raw.remove(key)     // -> boolean
```

**Unprefixed, unversioned, un-enveloped strings.** No namespace, no envelope,
no migration — you parse it yourself.

This exists because real production keys predate the namespace and cannot be
moved: Orbital Overhaul's `afd_settings_v1`, `afd_achievements_v2`,
`afd_profiles_v1`. Its intended uses are legacy detection and one-time
migration, and it's exempt from `clear()` and invisible to `keys()`.

If your module uses `raw`, say so in your module's own doc and name the keys.

`raw` is identical on a scoped store and its parent — it isn't scoped, by
definition.

---

## Events

```js
onEvent: (name, detail) => {}
```

Fires for: `unavailable`, `quota`, `corrupt`, `downgrade`, `migrated`,
`error`. Intended for telemetry, a debug overlay, or a dev-time warning.
**Nothing in the module's behavior depends on your handling them**, and a
handler that throws won't break the caller.

`corrupt` and `downgrade` in particular are worth logging in a debug build —
they're the events that mean a player has data this build silently ignored.

---

## What this module deliberately does not do

- **Evict, prune, or compress.** It reports; the owning module decides.
- **Validate the shape of your data.** Valid JSON at the declared version is
  the guarantee. Field checking belongs where the shape is known.
- **Know what a profile is.** `scope()` is a generic prefix segment.
- **Anything asynchronous.** `localStorage` is synchronous and so is this. A
  cloud-save backend would be a different module, not a retrofit.
- **Talk to a network, render anything, or touch the DOM** beyond
  `window.localStorage`.
- **Manage kit-leaderboard's offline queue.** kit-leaderboard v0.1.0 is
  dependency-free and owns its own `coinless.lb.*` key. kit-storage doesn't
  see it or clear it.

---

## Integration checklist for a module or game

1. `create()` one store per game, at boot, before anything reads persisted
   state. Pass the instance to other kit modules rather than creating a second.
2. Declare every key you'll touch — at `create()` if you own the store, via
   `declare()` if you were handed one.
3. Start every key at `version: 1`. Add `migrate` only when you actually bump.
4. Treat `set() === false` as information, not an error. Decide once per module
   what it means for you and write it down.
5. Keep field-level defaulting in your own load path. kit-storage hands back
   JSON, not a validated object.
6. Check `store.available` if you want to tell the player their progress won't
   be saved. Say it once, at the title screen — not on every write.
7. Use `scope(id)` for anything per-profile; don't hand-roll key prefixes.
8. Log `corrupt` and `downgrade` in debug builds.