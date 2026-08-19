// kit-storage — client module. Plain ES module, no build step, no dependencies.
// Contract: docs/kit-storage-client-api.md. Implementation contract:
// docs/kit-storage-spec.md. Local only — no network, no DOM beyond
// window.localStorage, no knowledge of games, profiles or achievements.
//
// Governing rule, spec §2.1: environmental failure (blocked storage, quota,
// corrupt bytes, an unreadable version) is a RETURN VALUE. Programmer error
// (an undeclared key, an illegal identifier, an unserializable value) is an
// EXCEPTION, thrown at the call site.

export const VERSION = '0.1.0';

// --- Identifiers (spec §3.2) -------------------------------------------------
//
// '.' is the keyspace segment separator (§3.1) and is therefore absent from
// every charset below. It is also rejected explicitly, ahead of the pattern
// test, so the error message names the actual problem.
//
// ⛔ The 3-character minimum on gameId is load-bearing, not cosmetic: it makes
// 'lb' an impossible gameId, so kit-leaderboard's coinless.lb.<gameId>.v1
// queue key can never collide with a store's namespace. §3.3, §13.

const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;   // 3–32 chars
const SCOPE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/; // 1–64 chars
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;      // 1–64 chars

const ROOT_PREFIX = 'coinless.';
const PROBE_KEY = 'coinless.__probe';

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return Object.prototype.toString.call(value);
  return String(value);
}

function checkIdentifier(value, kind, pattern, rule) {
  if (typeof value !== 'string') {
    throw new TypeError(`kit-storage: ${kind} must be a string, got ${describe(value)}`);
  }
  if (value.includes('.')) {
    throw new TypeError(
      `kit-storage: ${kind} may not contain '.' — it is the keyspace segment ` +
      `separator (got ${describe(value)})`
    );
  }
  if (!pattern.test(value)) {
    throw new TypeError(`kit-storage: invalid ${kind} ${describe(value)} — must be ${rule}`);
  }
  return value;
}

const checkGameId = (v) =>
  checkIdentifier(v, 'gameId', GAME_ID_RE, "3–32 chars of [a-z0-9-], starting alphanumeric");
const checkScopeId = (v) =>
  checkIdentifier(v, 'scopeId', SCOPE_ID_RE, "1–64 chars of [a-z0-9_-], starting alphanumeric");
const checkKey = (v) =>
  checkIdentifier(v, 'key', KEY_RE, "1–64 chars of [a-z0-9_-], starting alphanumeric");

// --- Availability probe (spec §5.1) -----------------------------------------
//
// The try wraps the property READ of window.localStorage, not just setItem —
// in a sandboxed iframe without allow-same-origin the access itself throws,
// which is the real itch.io / Newgrounds failure mode.
//
// Probed once, at create(). Never re-probed: `available` means "storage exists
// and accepts writes", not "storage has room", so a later quota failure does
// not flip it to false.

function probeLocalStorage() {
  try {
    const ls = window.localStorage;
    ls.setItem(PROBE_KEY, '1');
    ls.removeItem(PROBE_KEY);
    return { ls, error: null };
  } catch (error) {
    return { ls: null, error };
  }
}

// --- Declaration table (spec §7.1) ------------------------------------------
//
// Store-wide, shared by every scope: a per-profile key is the same key in
// every profile, so it is declared once. Version travels with the key, never
// with the call site.

function checkDeclaration(key, spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError(
      `kit-storage: declaration for key ${describe(key)} must be an object ` +
      `like { version: 1 }, got ${describe(spec)}`
    );
  }
  const { version, migrate } = spec;
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError(
      `kit-storage: key ${describe(key)} needs an integer version >= 1, got ${describe(version)}`
    );
  }
  if (migrate !== undefined && typeof migrate !== 'function') {
    throw new TypeError(
      `kit-storage: migrate for key ${describe(key)} must be a function, got ${describe(migrate)}`
    );
  }
  return { version, migrate: migrate ?? null };
}

function declareKey(ctx, key, spec) {
  checkKey(key);
  const next = checkDeclaration(key, spec);
  const existing = ctx.declarations.get(key);

  if (existing) {
    // Idempotent only when the spec is identical — same version AND the same
    // function reference. Two modules disagreeing about one key's version is a
    // bug that must not resolve silently (§7.1).
    if (existing.version === next.version && existing.migrate === next.migrate) return;
    throw new Error(
      `kit-storage: conflicting declaration for key ${describe(key)} — ` +
      `already declared version ${existing.version}` +
      `${existing.migrate ? ' with a migrate function' : ' with no migrate function'}, ` +
      `redeclared as version ${next.version}` +
      `${next.migrate ? ' with a migrate function' : ' with no migrate function'}`
    );
  }

  ctx.declarations.set(key, next);
}

// Read/write access to an undeclared key throws. This is the typo guard: it is
// what turns store.get('profile') — missing an 's' — into an immediate error
// instead of a silently empty result found a month later. ⛔ §13: it must not
// default to version 1 instead.
function requireDeclared(ctx, key, method) {
  checkKey(key);
  const declaration = ctx.declarations.get(key);
  if (!declaration) {
    const known = [...ctx.declarations.keys()].sort();
    throw new Error(
      `kit-storage: ${method}(${describe(key)}) on an undeclared key. ` +
      `Declare it at create({ keys }) or with store.declare(). ` +
      `Declared keys: ${known.length ? known.join(', ') : '(none)'}`
    );
  }
  return declaration;
}

// --- Events (spec §11) ------------------------------------------------------
//
// Telemetry and debug overlays only — no module behavior depends on any of
// these being handled, and a handler that throws must never break the caller.

function makeEmitter(onEvent) {
  if (onEvent === undefined || onEvent === null) return () => {};
  if (typeof onEvent !== 'function') {
    throw new TypeError(`kit-storage: onEvent must be a function, got ${describe(onEvent)}`);
  }
  return (name, detail) => {
    try {
      onEvent(name, detail);
    } catch {
      /* a broken handler is the caller's problem, never ours */
    }
  };
}

// --- Envelope (spec §4) -----------------------------------------------------
//
// {"v":<int >= 1>,"d":<the value>}. Nothing else lives in the envelope.

function encodeEnvelope(key, version, value) {
  if (value === undefined) {
    throw new TypeError(
      `kit-storage: set(${describe(key)}, undefined) — undefined is not storable, use remove()`
    );
  }
  // The VALUE is serialized on its own, then spliced into the envelope. Doing
  // it the other way round — JSON.stringify({v, d: value}) — hides the failure:
  // a function or a symbol makes the whole `d` property vanish and yields a
  // valid-looking `{"v":1}`, which then reads back as corruption on the next
  // load instead of throwing at the call site where the bug is. `version` is a
  // validated integer and `json` is valid JSON, so the splice is safe.
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(
      `kit-storage: value for key ${describe(key)} is not JSON-representable ` +
      `(${error && error.message ? error.message : error})`
    );
  }
  if (json === undefined) {
    throw new TypeError(
      `kit-storage: value for key ${describe(key)} is not JSON-representable ` +
      `(${describe(value)} serializes to nothing)`
    );
  }
  return `{"v":${version},"d":${json}}`;
}

// A parsed value is an envelope only if it is a plain object carrying an
// integer v >= 1 and a d property that is PRESENT — d may legitimately be
// null, so presence is tested with `in`, never truthiness.
function isEnvelope(parsed) {
  return (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Number.isInteger(parsed.v) &&
    parsed.v >= 1 &&
    'd' in parsed
  );
}

// --- Storage plumbing -------------------------------------------------------

function readItem(ctx, storageKey) {
  if (!ctx.ls) return null;
  try {
    return ctx.ls.getItem(storageKey);
  } catch {
    return null;
  }
}

// Low-level write, one level below the memory shim. `error` distinguishes WHY
// it failed: null means ctx.ls was simply absent (storage unavailable), a
// caught exception means setItem itself threw (quota, most likely) —
// shimmedWrite uses that distinction to decide what to emit (§5.2, §8).
function tryWriteItem(ctx, storageKey, json) {
  if (!ctx.ls) return { ok: false, error: null };
  try {
    ctx.ls.setItem(storageKey, json);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  }
}

function removeItem(ctx, storageKey) {
  if (!ctx.ls) return true;
  try {
    ctx.ls.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

// Snapshot before mutating — removing while walking ls.key(i) reindexes.
function storageKeys(ctx) {
  if (!ctx.ls) return [];
  try {
    const out = [];
    for (let i = 0; i < ctx.ls.length; i += 1) {
      const k = ctx.ls.key(i);
      if (typeof k === 'string') out.push(k);
    }
    return out;
  } catch {
    return [];
  }
}

// --- The read algorithm (spec §7.3) ----------------------------------------
//
// Seven numbered steps, written out one for one. The ONLY step that writes is
// step 7's SUCCESSFUL forward migration. Steps 3, 5, 6 and step 7's failure
// branches all return the fallback and leave the stored bytes exactly as they
// were, because §2.4 governs: a build that cannot read something is not
// evidence that the something is worthless.

// The memory shim (§5.2): a write that doesn't reach durable storage is kept
// in ctx.memory for the rest of the page session instead. A successful write
// clears any stale entry for the same key first, so a durable value is never
// shadowed by an in-memory copy left over from an earlier failure. Shared by
// writeValue (managed keys) and raw.set() — §14 step 7 says raw gets "the
// same shim rules". `shimValue` is what get() should hand back from memory:
// the decoded value for a managed key, the bare string for raw — never the
// encoded bytes actually handed to tryWriteItem. `eventKey` is what events
// name: the logical key for a managed write, the raw key for raw.
function shimmedWrite(ctx, storageKey, encoded, shimValue, eventKey) {
  const { ok, error } = tryWriteItem(ctx, storageKey, encoded);

  if (ok) {
    ctx.memory.delete(storageKey);
    return true;
  }

  ctx.memory.set(storageKey, shimValue);

  // error === null means ctx.ls was absent, not that setItem threw — that
  // case already got its one-time 'unavailable' event at create(); re-firing
  // on every write would be noise for a condition that hasn't changed. An
  // actual setItem throw is classified 'quota' per §8: browsers report a full
  // store inconsistently (QuotaExceededError, legacy
  // NS_ERROR_DOM_QUOTA_REACHED, or a numeric DOM code — 22, or legacy 1014),
  // and kit-storage cannot distinguish those from any other write failure any
  // more reliably than the browsers can, so an unrecognized throw is treated
  // as quota too — the response (memory shim, `false`, an event) is identical
  // either way.
  if (error !== null) {
    ctx.emit('quota', { key: eventKey, bytes: (storageKey.length + encoded.length) * 2 });
  }

  return false;
}

function writeValue(ctx, prefix, key, version, value) {
  const storageKey = prefix + key;
  const json = encodeEnvelope(key, version, value);
  return shimmedWrite(ctx, storageKey, json, value, key);
}

function readValue(ctx, prefix, key, declaration, fallback) {
  const declared = declaration.version;
  const storageKey = prefix + key;

  // STEP 1 — the memory shim holds this key → return that value. Done.
  // Any value that failed to reach durable storage is retained here for the
  // rest of the page session (§5.2), and it takes precedence over whatever
  // storage still holds — there is no read cache, but the shim is checked
  // before every other step, every call.
  if (ctx.memory.has(storageKey)) return ctx.memory.get(storageKey);

  // STEP 2 — storage unavailable, or no stored value → fallback.
  // Not a corruption and not an error: nothing is emitted here.
  const raw = readItem(ctx, storageKey);
  if (raw === null) return fallback;

  // STEP 3 — unparseable, or parseable but not a {v, d} envelope → emit
  // 'corrupt', return the fallback, LEAVE THE BYTES ALONE.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.emit('corrupt', { key, reason: 'unparseable' });
    return fallback;
  }
  if (!isEnvelope(parsed)) {
    ctx.emit('corrupt', { key, reason: 'not_an_envelope' });
    return fallback;
  }

  // STEP 4 — stored version matches the declared version → the value.
  if (parsed.v === declared) return parsed.d;

  // STEP 5 — DOWNGRADE. The stored version is NEWER than this build declares.
  //
  // ⛔ Return the fallback, emit 'downgrade', and WRITE NOTHING. This is not an
  // unfinished branch. It is a player who loaded an older build over newer data
  // — a cached itch.io build, or a rollback — and it is the only path in this
  // module capable of destroying data the running build does not understand
  // yet. It is deliberately inert. §7.3 step 5, §13. Do not "complete" it.
  if (parsed.v > declared) {
    ctx.emit('downgrade', { key, stored: parsed.v, declared });
    return fallback;
  }

  // STEP 6 — stored version is older and no migrate was declared → emit
  // 'corrupt', return the fallback, write nothing. The old bytes survive, so a
  // later build that does declare a migrate can still read them.
  if (!declaration.migrate) {
    ctx.emit('corrupt', { key, reason: 'no_migrate' });
    return fallback;
  }

  // STEP 7 — stored version is older and migrate was declared.
  //
  // migrate receives the ORIGIN version and must handle any version below the
  // declared one it cares about. There is no chaining: with two or three
  // lifetime versions per key a chain is more machinery than it is worth, and
  // harder to test. migrate must be pure and must not call back into the store.
  let migrated;
  try {
    migrated = declaration.migrate(parsed.v, parsed.d);
  } catch (error) {
    ctx.emit('error', { key, error });
    return fallback;
  }

  // Returning undefined is how migrate says "I cannot handle this version" —
  // the fallback path takes over and nothing is destroyed.
  if (migrated === undefined) {
    ctx.emit('error', {
      key,
      error: new Error(
        `kit-storage: migrate for key ${describe(key)} returned undefined for stored ` +
        `version ${parsed.v} (declared ${declared}) — falling back, bytes left alone`
      )
    });
    return fallback;
  }

  // The one and only write on any read path. Best-effort by contract: a failed
  // write-back is NOT an error and does not change what get() returns —
  // migration simply runs again on the next load, which is why migrate has to
  // be idempotent. Wrapped because encoding an unserializable migrate result
  // must not turn a read into a throw.
  try {
    writeValue(ctx, prefix, key, declared, migrated);
  } catch (error) {
    ctx.emit('error', { key, error });
  }

  ctx.emit('migrated', { key, from: parsed.v, to: declared });
  return migrated;
}

// --- Enumeration (spec §9) --------------------------------------------------
//
// Given the store's prefix P, strip it from every matching storage key:
// a remainder with no '.' is an own-level key; a remainder with a '.' belongs
// to a child scope, whose id is its first segment. The no-'.'-in-identifiers
// rule (§3.1) is what makes this unambiguous.
//
// These four operate on what is STORED, not what is declared, and never throw
// for undeclared keys — enumeration must be able to see leftovers from an
// older build (§7.1).

function underPrefix(ctx, prefix) {
  const out = [];
  for (const storageKey of storageKeys(ctx)) {
    if (!storageKey.startsWith(prefix)) continue;
    const remainder = storageKey.slice(prefix.length);
    if (remainder.length === 0) continue;
    out.push({ storageKey, remainder });
  }
  return out;
}

// Same walk, over the memory shim instead of storage — a key that has never
// reached durable storage (every set() has failed so far this session) has no
// entry for underPrefix() to find, so clear() needs this separately to reach
// it (§9: "clear matching entries from the memory shim").
function underPrefixMemory(ctx, prefix) {
  const out = [];
  for (const storageKey of ctx.memory.keys()) {
    if (!storageKey.startsWith(prefix)) continue;
    const remainder = storageKey.slice(prefix.length);
    if (remainder.length === 0) continue;
    out.push({ storageKey, remainder });
  }
  return out;
}

// --- Store construction -----------------------------------------------------

function createStore(ctx, prefix) {
  const store = {
    get gameId() {
      return ctx.gameId;
    },
    get available() {
      return ctx.ls !== null;
    },

    declare(key, spec) {
      declareKey(ctx, key, spec);
    },

    // The fallback is returned as-is, not cloned. There is no read cache: every
    // get() re-reads storage. §7.3, step by step, lives in readValue().
    get(key, fallback) {
      const declaration = requireDeclared(ctx, key, 'get');
      return readValue(ctx, prefix, key, declaration, fallback);
    },

    // Versions are per key, never per store and never per call site — the
    // version written here comes from the declaration, so a caller cannot pass
    // 2 in one file and forget in another (§7.1).
    set(key, value) {
      const declaration = requireDeclared(ctx, key, 'set');
      return writeValue(ctx, prefix, key, declaration.version, value);
    },

    // has() reports whether BYTES are stored at this key, not whether this
    // build can read them. A corrupt or newer-version value is still data the
    // player owns (§2.4), and hiding it behind `false` would invite a caller to
    // overwrite exactly the value step 5 refuses to touch. It never emits and
    // never writes.
    has(key) {
      requireDeclared(ctx, key, 'has');
      return readItem(ctx, prefix + key) !== null;
    },

    // Clears both the durable value and any memory-shimmed one (§5.2) — a
    // failed write's in-memory copy must not outlive an explicit remove().
    remove(key) {
      requireDeclared(ctx, key, 'remove');
      const storageKey = prefix + key;
      ctx.memory.delete(storageKey);
      if (readItem(ctx, storageKey) === null) return true;
      return removeItem(ctx, storageKey);
    },

    // Same interface over a longer prefix, sharing the parent's probe result,
    // onEvent handler and declaration table (§6) — that sharing is what makes
    // one declare('achievements', ...) work across every profile scope.
    scope(id) {
      checkScopeId(id);
      return createStore(ctx, `${prefix}${id}.`);
    },

    keys() {
      return underPrefix(ctx, prefix)
        .filter((e) => !e.remainder.includes('.'))
        .map((e) => e.remainder)
        .sort();
    },

    scopes() {
      const ids = new Set();
      for (const { remainder } of underPrefix(ctx, prefix)) {
        const dot = remainder.indexOf('.');
        if (dot > 0) ids.add(remainder.slice(0, dot));
      }
      return [...ids].sort();
    },

    // Own-level-only by default is deliberate: "wipe this profile completely"
    // should require typing deep (§9). Never touches coinless.lb.*, another
    // game's namespace, or unprefixed legacy keys — it only walks its own
    // prefix. Also clears matching memory-shim entries (§9), including keys
    // that never reached storage at all — a never-durable value has nothing
    // for the storage walk to find, hence the separate underPrefixMemory pass.
    // The returned count is durable removals only, matching "removes own-level
    // keys" read literally; a memory-only entry was never "in" storage to
    // remove from it.
    clear(options) {
      const deep = Boolean(options && options.deep);
      let removed = 0;
      for (const { storageKey, remainder } of underPrefix(ctx, prefix)) {
        if (!deep && remainder.includes('.')) continue;
        ctx.memory.delete(storageKey);
        if (removeItem(ctx, storageKey)) removed += 1;
      }
      for (const { storageKey, remainder } of underPrefixMemory(ctx, prefix)) {
        if (!deep && remainder.includes('.')) continue;
        ctx.memory.delete(storageKey);
      }
      return removed;
    },

    // An estimate, and the doc says so: UTF-16, key plus value, this prefix
    // only. There is no dependable "how much room is left" API — set()
    // returning false is the real signal (§8).
    usage() {
      let bytes = 0;
      let keys = 0;
      for (const { storageKey } of underPrefix(ctx, prefix)) {
        const value = readItem(ctx, storageKey);
        if (value === null) continue;
        bytes += (storageKey.length + value.length) * 2;
        keys += 1;
      }
      return { bytes, keys };
    },

    // Unprefixed, unversioned, un-enveloped strings — the escape hatch for
    // real production keys that predate the namespace and cannot be moved
    // (afd_settings_v1, afd_achievements_v2, afd_profiles_v1). Exempt from
    // clear(), invisible to keys(), identical on a scoped store and its parent
    // because it is not scoped by definition (§3.4, §6). ⛔ §13: do not remove.
    raw: ctx.raw
  };

  return store;
}

function createRaw(ctx) {
  const checkRawKey = (key) => {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError(`kit-storage: raw key must be a non-empty string, got ${describe(key)}`);
    }
    return key;
  };

  return {
    // Same memory-shim precedence as the managed get() (§7.3 step 1): a raw
    // write that failed to reach storage is served from memory until reload.
    get(key) {
      const k = checkRawKey(key);
      if (ctx.memory.has(k)) return ctx.memory.get(k);
      return readItem(ctx, k);
    },
    set(key, value) {
      const k = checkRawKey(key);
      if (typeof value !== 'string') {
        throw new TypeError(
          `kit-storage: raw.set(${describe(key)}, ...) takes a string — ` +
          `raw values are unversioned and un-enveloped, got ${describe(value)}`
        );
      }
      return shimmedWrite(ctx, k, value, value, k);
    },
    // Durable bytes only, like the managed has() (§2.4) — not whether a
    // memory-shimmed value would answer get().
    has(key) {
      return readItem(ctx, checkRawKey(key)) !== null;
    },
    // Clears both the durable value and any memory-shimmed one, same as the
    // managed remove().
    remove(key) {
      const k = checkRawKey(key);
      ctx.memory.delete(k);
      if (readItem(ctx, k) === null) return true;
      return removeItem(ctx, k);
    }
  };
}

// --- create() (spec §12, §14 step 1) ----------------------------------------
//
// Two create() calls with the same gameId return independent instances over
// the same keyspace with SEPARATE declaration tables. That is a footgun, not a
// feature: create once per game and pass the instance around.

export function create(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError(`kit-storage: create() needs a config object, got ${describe(config)}`);
  }

  const gameId = checkGameId(config.gameId);
  const emit = makeEmitter(config.onEvent);

  const { keys } = config;
  if (keys !== undefined && (keys === null || typeof keys !== 'object' || Array.isArray(keys))) {
    throw new TypeError(`kit-storage: create({ keys }) must be an object, got ${describe(keys)}`);
  }

  const ctx = {
    gameId,
    ls: null,
    declarations: new Map(),
    // The memory shim (§5.2), keyed by full storage key so root and every
    // scope share one map — consistent with the probe result, onEvent handler
    // and declaration table already being shared across scope() (§6).
    memory: new Map(),
    emit,
    raw: null
  };

  // Declarations are validated before the probe so a malformed config throws
  // loudly whether or not storage happens to be available.
  if (keys) {
    for (const key of Object.keys(keys)) declareKey(ctx, key, keys[key]);
  }

  const { ls, error } = probeLocalStorage();
  ctx.ls = ls;
  ctx.raw = createRaw(ctx);

  if (ls === null) emit('unavailable', { error });

  return createStore(ctx, `${ROOT_PREFIX}${gameId}.`);
}
