// kit-storage — client module. Plain ES module, no build step, no dependencies.
// Contract: docs/kit-storage-client-api.md. Implementation contract:
// docs/kit-storage-spec.md. Local only — no network, no DOM beyond
// window.localStorage, no knowledge of games, profiles or achievements.
//
// Governing rule, spec §2.1: environmental failure (blocked storage, quota,
// corrupt bytes, an unreadable version) is a RETURN VALUE. Programmer error
// (an undeclared key, an illegal identifier, an unserializable value) is an
// EXCEPTION, thrown at the call site.

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
  let json;
  try {
    json = JSON.stringify({ v: version, d: value });
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
  return json;
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

// PHASE 3 owes this the memory shim and quota classification (§5.2, §8): a
// failed write must retain the value in memory for the page session and emit
// 'quota' or 'error'. Today it reports the failure honestly and keeps nothing.
function writeItem(ctx, storageKey, json) {
  if (!ctx.ls) return false;
  try {
    ctx.ls.setItem(storageKey, json);
    return true;
  } catch {
    return false;
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

    // PHASE 2 owes get() the complete seven-step read algorithm of §7.3 —
    // corrupt/downgrade/migrate handling and their events. What is here now is
    // only steps 2 and 4: absent or unreadable storage returns the fallback,
    // and an exact version match returns the value. Every other case falls
    // back WITHOUT writing, which is the safe half of the algorithm but not
    // yet the specified one.
    get(key, fallback) {
      const declaration = requireDeclared(ctx, key, 'get');
      const stored = readItem(ctx, prefix + key);
      if (stored === null) return fallback;

      let parsed;
      try {
        parsed = JSON.parse(stored);
      } catch {
        return fallback;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
      if (!Number.isInteger(parsed.v) || parsed.v < 1 || !('d' in parsed)) return fallback;
      if (parsed.v !== declaration.version) return fallback;
      return parsed.d;
    },

    set(key, value) {
      const declaration = requireDeclared(ctx, key, 'set');
      const json = encodeEnvelope(key, declaration.version, value);
      return writeItem(ctx, prefix + key, json);
    },

    has(key) {
      requireDeclared(ctx, key, 'has');
      return readItem(ctx, prefix + key) !== null;
    },

    remove(key) {
      requireDeclared(ctx, key, 'remove');
      const storageKey = prefix + key;
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
    // prefix. PHASE 3/4 owes it the memory-shim sweep.
    clear(options) {
      const deep = Boolean(options && options.deep);
      let removed = 0;
      for (const { storageKey, remainder } of underPrefix(ctx, prefix)) {
        if (!deep && remainder.includes('.')) continue;
        if (removeItem(ctx, storageKey)) removed += 1;
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
    get(key) {
      return readItem(ctx, checkRawKey(key));
    },
    set(key, value) {
      checkRawKey(key);
      if (typeof value !== 'string') {
        throw new TypeError(
          `kit-storage: raw.set(${describe(key)}, ...) takes a string — ` +
          `raw values are unversioned and un-enveloped, got ${describe(value)}`
        );
      }
      return writeItem(ctx, key, value);
    },
    has(key) {
      return readItem(ctx, checkRawKey(key)) !== null;
    },
    remove(key) {
      checkRawKey(key);
      if (readItem(ctx, key) === null) return true;
      return removeItem(ctx, key);
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
