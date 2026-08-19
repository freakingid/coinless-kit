// kit-profile — client module. Plain ES module, no build step.
// Contract: docs/kit-profile-client-api.md. Implementation contract:
// docs/kit-profile-spec.md. Local only — no network, no DOM, no game state.
// Depends on: kit-storage (an instance is injected, never created here) and
// kit-names (all display-name rules).
//
// ⛔ THIS MODULE IS AN EXTRACTION, not a fresh design. Orbital Overhaul's
// `Profiles` object is in production and correct; spec §12 lists the twelve
// things a future session must not "fix". Several of them look like obvious
// cleanups and are not — each traces to a real bug or a real data-loss risk.
//
// Governing rule, spec §2.1: `player_id` is minted once per profile and NEVER
// regenerated. A regenerated id silently fragments a player's leaderboard
// history into two identities that can never be merged, and it fails quietly —
// it surfaces weeks later as a board listing the same person twice.

export const VERSION = '0.1.1';

import { validateName, MAX_NAME_LENGTH } from '../kit-names/kit-names.js';

// Re-exported, not wrapped, so KitProfile.NAME_CHANGE_NOTICE is reference-
// identical to KitNames.NAME_CHANGE_NOTICE (§8.4) — a rename UI needs one
// import, not two.
export { NAME_CHANGE_NOTICE } from '../kit-names/kit-names.js';

// --- Constants ---------------------------------------------------------------

// Root scope, declared at version 1 (§4.1). The old blob's internal "v": 1
// field is dropped — kit-storage's envelope carries the version now.
const ROSTER_KEY = 'profiles';
const ROSTER_VERSION = 1;

// ⛔ NOT maxProfiles. §6.3: load() must never truncate to the configured
// maximum, or a roster of 6 read by a build configured for 4 silently loses
// two. This ceiling exists only to bound corrupt input; create() enforces the
// real limit.
const ROSTER_HARD_CEILING = 32;

const DEFAULTS = {
  maxProfiles: 8,
  legacyProfileId: 'p0',
  legacyProfileName: 'PLAYER 1',
  legacyRosterKey: 'afd_profiles_v1',
  legacyProbeKeys: ['afd_settings_v1', 'afd_achievements_v2'],
  anonymousName: 'ANONYMOUS'
};

// --- Small helpers -----------------------------------------------------------

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return Object.prototype.toString.call(value);
  return String(value);
}

// crypto.randomUUID() is [SecureContext]-only, and an opaque origin — a
// sandboxed iframe with no allow-same-origin, the real itch.io/Newgrounds
// embed kit-storage's own blocked-storage probe models — is never a secure
// context, so randomUUID is undefined there even though crypto itself and
// getRandomValues() are not restricted. Confirmed in a real such iframe: this
// module's two id-minting call sites (ensurePlayerId, the legacy-probe mint)
// would otherwise throw uncaught the first time either ran in that embed.
// Falls back to building a v4 UUID from getRandomValues() — this changes
// nothing about ensurePlayerId's three load-bearing properties (spec §3/§12);
// it only changes what generates the string.
function mintPlayerId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

// Telemetry only, and a handler that throws must never break a caller —
// §10 and §13 step 10. This is what keeps a broken game handler from leaving a
// switch half-completed.
function makeEmitter(onEvent) {
  if (onEvent === undefined || onEvent === null) return () => {};
  if (typeof onEvent !== 'function') {
    throw new TypeError(`kit-profile: onEvent must be a function, got ${describe(onEvent)}`);
  }
  return (name, detail) => {
    try {
      onEvent(name, detail);
    } catch {
      /* a broken handler is the caller's problem, never ours */
    }
  };
}

// §8.2 — the LENIENT path, production's `cleanName` carried over exactly:
// trim and cap, nothing else. ⛔ No charset check, no uppercasing, no
// whitespace collapse. Stored names are preserved as-is; a profile saved under
// older rules as `Gh0st!` loads intact, is not renamed, not normalized and
// carries no "needs fixing" flag. Strict validateName() applies to create()
// and rename() only.
function lenientName(name) {
  return typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
}

// --- The defensive roster parse (§5.1) ---------------------------------------
//
// kit-storage guarantees valid JSON at the declared version, not the right
// shape (its client API says so explicitly). Field-by-field
// known-value-else-default therefore stays here, where the shape is known.
//
// Shared deliberately: §5.2's legacy import parses the old `afd_profiles_v1`
// blob with the IDENTICAL rules, so the two must not be allowed to drift into
// two implementations.
//
// Returns { profiles, lastUsed, seq } or null if the blob isn't a roster at
// all. An empty-but-valid roster returns a result with an empty list — the
// caller decides what that means.

function parseRoster(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.profiles)) return null;

  const list = [];
  const seen = new Set();
  for (const p of data.profiles) {
    if (list.length >= ROSTER_HARD_CEILING) break;
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || seen.has(p.id)) continue;
    const name = lenientName(p.name);
    if (!name) continue;
    seen.add(p.id);
    // known-value-else-default: a pre-CS033 blob simply has no playerId key,
    // which parses to undefined here and falls through to null — the exact
    // state ensurePlayerId() treats as unset. That fall-through IS the
    // backfill trigger (§3); do not "tidy" it into a required field.
    list.push({
      id: p.id,
      name,
      created: typeof p.created === 'number' ? p.created : 0,
      playerId: typeof p.playerId === 'string' && p.playerId ? p.playerId : null
    });
  }

  // ⛔ The seq floor. seq never drops BELOW what the roster already uses,
  // however the stored value was edited — max(storedSeq, max(suffix) + 1).
  // Monotonic ids are the guarantee that makes not clearing a removed
  // profile's stores safe (§4.3): a recycled id would inherit a dead
  // profile's settings and achievements.
  let seq = 0;
  for (const p of list) {
    const m = /^p(\d+)$/.exec(p.id);
    if (m) seq = Math.max(seq, Number(m[1]) + 1);
  }
  if (Number.isFinite(data.seq) && data.seq > seq) seq = Math.floor(data.seq);

  return {
    profiles: list,
    lastUsed: typeof data.lastUsed === 'string' ? data.lastUsed : '',
    seq
  };
}

// --- Roster state ------------------------------------------------------------
//
// An object literal with methods, so `this.save()` and `this.byId()` read
// exactly as they do in the production source this is extracted from. The
// public instance returned by create() is a thin façade over this — the
// documented contract is the whole exported surface.

function makeState(cfg, emit) {
  const store = cfg.storage;

  return {
    // ⛔ Defaults to the legacy id, so a build that never loads a roster keys
    // every store exactly where every pre-profile build did (§5.4).
    activeId: cfg.legacyProfileId,
    roster: [],          // [{ id, name, created, playerId }]
    lastUsed: '',        // the id to re-activate at the next boot ('' = none)
    seq: 0,              // next numeric suffix to mint — monotonic, see §4.3
    firstBoot: false,    // set ONLY on a genuinely empty install (§5.4)

    // Ids that came out of STORED data, so `minted` can report backfill
    // honestly (§10): true means a profile predating player_id just got one.
    // Not persisted, and deliberately not a field on the roster entry —
    // save() writes exactly four fields and nothing else.
    fromStore: new Set(),

    byId(id) {
      return this.roster.find((p) => p.id === id) || null;
    },

    nameOf(id) {
      const p = this.byId(id);
      return p ? p.name : '';
    },

    // Trimmed and case-insensitive (§8.1), carried from production unchanged.
    // `exceptId` lets rename() ignore the profile it is renaming. Compares
    // through the LENIENT path on both sides so a stored legacy name still
    // participates — callers pass the strictly-normalized candidate in.
    nameTaken(name, exceptId) {
      const n = lenientName(name).toLowerCase();
      if (!n) return false;
      return this.roster.some((p) => p.id !== exceptId && p.name.toLowerCase() === n);
    },

    // ------------------------------------------------------------------
    // ⛔ §3 / §12 — CARRIED VERBATIM FROM PRODUCTION. Three properties, all
    // load-bearing:
    //   1. Check-then-mint. Mints only when absent; cannot re-mint.
    //   2. Persists IMMEDIATELY, not at the next natural save, so the mint
    //      survives a crash between minting and whatever save would otherwise
    //      have come next.
    //   3. Called from every path that reaches a profile (§3.1): boot,
    //      select(), current(), player(). NOT list(), NOT create().
    // Do not restructure this into a lazy getter, a constructor-time mint, or
    // a migration pass. The only addition to production's three lines is the
    // §10 `minted` emit, which is telemetry and changes none of the three.
    // ------------------------------------------------------------------
    ensurePlayerId(id) {
      const p = this.byId(id);
      if (p && !p.playerId) {
        p.playerId = mintPlayerId();
        this.save();
        emit('minted', { id: p.id, backfill: this.fromStore.has(p.id) });
      }
      return p ? p.playerId : null;
    },

    // --- Persistence -------------------------------------------------------
    //
    // `op`/`id` default to the mint case: every one of ensurePlayerId's four
    // call sites has already moved activeId onto the profile being minted, so
    // `this.save()` — the verbatim line above — reports the right id without
    // needing an argument.
    save(op = 'save', id = this.activeId) {
      const ok = store.set(ROSTER_KEY, {
        lastUsed: this.lastUsed,
        seq: this.seq,
        // No cap here: an over-capacity roster is saved back INTACT (§6.3).
        profiles: this.roster.map((p) => ({
          id: p.id,
          name: p.name,
          created: p.created,
          playerId: p.playerId || null
        }))
      });
      if (!ok) emit('error', { op, id });
      return ok;
    },

    // Returns TRUE only when a usable, NON-EMPTY roster came back. Absent,
    // unreadable, corrupt and empty all answer false and leave the roster
    // empty — that is the single signal boot branches on (§5.1). Never throws.
    load() {
      this.roster = [];
      this.lastUsed = '';
      this.seq = 0;
      this.fromStore.clear();

      let parsed = null;
      try {
        // kit-storage already returns the fallback for absent, blocked,
        // corrupt or unreadable-version bytes, and leaves those bytes alone.
        parsed = parseRoster(store.get(ROSTER_KEY, null));
      } catch {
        parsed = null;   // create() never throws (§5)
      }
      if (!parsed) return false;

      this.roster = parsed.profiles;
      this.lastUsed = parsed.lastUsed;
      this.seq = parsed.seq;
      for (const p of this.roster) this.fromStore.add(p.id);
      return this.roster.length > 0;
    },

    // --- Boot (§5) ---------------------------------------------------------
    //
    // Runs once, synchronously, and never throws. Four outcomes, tried in the
    // order §5 sets out: a stored roster, a one-time legacy import, a
    // pre-profile install, or a genuinely empty one.
    boot() {
      this.firstBoot = false;

      // §5.1 — a usable roster is the single signal the rest of boot branches
      // on. This path READS ONLY; the only write it can produce is a backfill
      // mint below.
      if (this.load()) {
        this.activateLoaded();
        this.ensurePlayerId(this.activeId);   // backfill: this boot's profile may predate player_id
        return;
      }

      // ⛔ Everything past this point WRITES to the roster key, so the guard
      // is whether BYTES exist there — not whether load() could read them.
      // kit-storage's has() is specified for exactly this: it "reports whether
      // BYTES are stored at this key, not whether this build can read them...
      // returning false for it would invite a caller to overwrite exactly the
      // value step 5 is designed never to touch."
      //
      // The case that matters is a rollback: a cached or downgraded build
      // meets a roster written at a newer version. kit-storage read nothing
      // and wrote nothing (its §7.3 step 5). If kit-profile then treated
      // "load() said false" as "no roster key" it would import the ancient
      // afd_profiles_v1 blob straight over the newer roster, at version 1 —
      // silently destroying data this build merely failed to understand.
      // §2.4, and the same rule kit-storage lives by.
      //
      // Consequence, stated plainly: unreadable bytes leave an empty roster
      // and firstBoot true, so the game routes to the picker. Creating a
      // profile there WILL overwrite them — but that is a deliberate player
      // action, not something boot did on its own initiative.
      const rosterKeyAbsent = !store.has(ROSTER_KEY);

      // §5.2 — one-time legacy import.
      if (rosterKeyAbsent && this.importLegacyRoster()) {
        this.activateLoaded();
        this.save('legacy_import', this.activeId);
        this.ensurePlayerId(this.activeId);
        return;
      }

      // §5.3 — a returning player from before profiles existed.
      if (rosterKeyAbsent && this.probePreProfileInstall()) return;

      // §5.4 — a genuinely empty install: mint NOTHING, WRITE NOTHING, ask
      // nobody. The title screen routes off firstBoot; until then activeId is
      // the legacy id, so this build stores exactly where a pre-profile build
      // did and an untouched machine cannot tell the difference.
      this.activeId = cfg.legacyProfileId;
      this.firstBoot = true;
    },

    // Shared by §5.1 and §5.2: resolve which of a just-populated roster is
    // active. lastUsed wins if it still names someone; otherwise roster[0].
    activateLoaded() {
      this.activeId = this.byId(this.lastUsed) ? this.lastUsed : this.roster[0].id;
      this.lastUsed = this.activeId;
    },

    // §5.2 — read the pre-kit-storage roster blob and adopt it. Returns true
    // when a usable, non-empty roster came back; the caller does the write.
    //
    // ⛔ THE LEGACY KEY IS READ, NEVER DELETED AND NEVER REWRITTEN. A player
    // who rolls back to an older build still has their roster, and if the
    // write below fails (blocked storage) the next load simply imports again.
    // Nothing in this module ever calls raw.set() or raw.remove() on it.
    importLegacyRoster() {
      if (!cfg.legacyRosterKey) return false;   // a new game passes null to skip §5.2

      let parsed = null;
      try {
        const raw = store.raw.get(cfg.legacyRosterKey);
        if (raw === null) return false;
        // raw values are unversioned and un-enveloped by definition, so the
        // JSON.parse is ours to do. The old blob's own "v": 1 field is read
        // past and discarded (§4.1) — kit-storage's envelope carries the
        // version from here on, exactly as production's load() ignored it.
        // Identical defensive rules, one implementation: parseRoster.
        parsed = parseRoster(JSON.parse(raw));
      } catch {
        return false;   // an unreadable legacy blob is not usable — and not deleted
      }
      if (!parsed || parsed.profiles.length === 0) return false;

      this.roster = parsed.profiles;
      this.lastUsed = parsed.lastUsed;
      this.seq = parsed.seq;
      this.fromStore.clear();
      for (const p of this.roster) this.fromStore.add(p.id);
      return true;
    },

    // §5.3 — a machine already holding pre-profile save data gets ONE profile
    // minted over it.
    //
    // ⛔ THE PRE-PROFILE BLOBS ARE NOT COPIED, MOVED OR REWRITTEN. They are
    // only probed for existence. p0's stores ARE those keys, via scopeFor()'s
    // transparency rule (§4.2) — which is the whole reason nothing needs
    // moving.
    probePreProfileInstall() {
      let found = false;
      for (const key of cfg.legacyProbeKeys) {
        try {
          if (store.raw.has(key)) { found = true; break; }
        } catch {
          /* a probe that can't be read is not evidence of anything */
        }
      }
      if (!found) return false;

      // Minted inline rather than through ensurePlayerId, matching production:
      // this profile is being created now, so there is no check-then-mint to
      // do. backfill is false for the same reason — nothing predating
      // player_id is being backfilled here.
      const p = {
        id: cfg.legacyProfileId,
        name: cfg.legacyProfileName,
        created: Date.now(),
        playerId: mintPlayerId()
      };
      this.roster = [p];
      this.seq = 1;                  // p0 is taken; the next create() is p1 (§5.5)
      this.lastUsed = p.id;
      this.activeId = p.id;
      this.save('legacy_probe', p.id);
      emit('minted', { id: p.id, backfill: false });
      return true;                   // ⛔ firstBoot stays false — this is not an empty install
    },

    // --- Identity reads (§3.1 call sites) ----------------------------------
    current() {
      const p = this.byId(this.activeId);
      if (!p) return null;
      this.ensurePlayerId(p.id);
      return { id: p.id, name: p.name, playerId: p.playerId };
    },

    // kit-leaderboard's getPlayer() shape exactly (§9). With no current
    // profile: { playerId: null, displayName: '' } — mirroring production's
    // `p ? p.playerId : null` and nameOf() returning "".
    player() {
      const p = this.byId(this.activeId);
      if (!p) return { playerId: null, displayName: '' };
      return { playerId: this.ensurePlayerId(p.id), displayName: p.name };
    },

    // ⛔ §3.1 — list() does NOT mint and does NOT expose playerId. Roster
    // display has no need for it, and minting eight UUIDs because a player
    // opened a picker would tie identity creation to a UI event.
    list() {
      return this.roster.map((p) => ({ id: p.id, name: p.name, created: p.created }));
    },

    // --- Per-profile stores (§4.2) -----------------------------------------
    //
    // ⛔ THE LEGACY PROFILE ADDRESSES THE ROOT SCOPE DIRECTLY. That is what
    // lets p0's stores BE the pre-profile keys, unmoved — the §5.3 path mints
    // a profile over existing save data without copying a byte, and this line
    // is why that works.
    //
    // ⛔ This lives here, not in kit-storage. kit-storage has no concept of a
    // "transparent scope" and must not grow one (§4.2, §12). It sees only a
    // caller that sometimes asks for a child scope and sometimes doesn't.
    //
    // Membership is deliberately NOT checked: a removed profile's scoped data
    // must stay readable through scope(id) afterward (§4.3), and before boot
    // selection activeId is the legacy id, so scope() with no argument lands
    // on the root store — exactly where a pre-profile build would have written
    // (§5.4).
    scope(id) {
      const target = id === undefined || id === null ? this.activeId : id;
      return target === cfg.legacyProfileId ? store : store.scope(target);
    },

    // --- Roster operations (§6) --------------------------------------------
    //
    // create/rename/remove landed early, during Phase 1, because Phase 1's own
    // required tests — player_id stable across a rename, across a switch away
    // and back, and across a DIFFERENT profile being removed — cannot be
    // written without them. Verified against §6 as written in Phase 3, not
    // rewritten.

    // ⛔ Does NOT mint a player_id (§3.1). The id appears when the profile is
    // first activated, which under required boot selection (§5.4) is
    // immediately after creation anyway.
    create(name) {
      const v = validateName(name);
      if (!v.ok) return { ok: false, profile: null, reason: 'invalid_name' };
      if (this.nameTaken(v.normalized)) return { ok: false, profile: null, reason: 'name_taken' };
      if (this.roster.length >= cfg.maxProfiles) {
        return { ok: false, profile: null, reason: 'roster_full' };
      }

      // Monotonic — an id is never reused (§4.3, §12). seq starts at 0, so the
      // first create() on an empty install produces `p0`, the legacy id, whose
      // stores are the root scope (§5.5).
      const p = { id: 'p' + this.seq, name: v.normalized, created: Date.now(), playerId: null };
      this.seq++;
      this.roster.push(p);
      this.save('create', p.id);
      emit('created', { id: p.id, name: p.name });
      return { ok: true, profile: { id: p.id, name: p.name, created: p.created }, reason: null };
    },

    // §8.3 — an ORDINARY profile named cfg.anonymousName. Not a distinct
    // type, no flag, fully renameable later. nameTaken is case-insensitive, so
    // a device holds at most one profile by this name; if it's already taken,
    // this returns { ok: false, reason: 'name_taken' } and the caller should
    // select the existing one rather than retry.
    createAnonymous() {
      return this.create(cfg.anonymousName);
    },

    rename(id, name) {
      const p = this.byId(id);
      if (!p) return { ok: false, reason: 'not_found' };
      const v = validateName(name);
      if (!v.ok) return { ok: false, reason: 'invalid_name' };
      if (this.nameTaken(v.normalized, id)) return { ok: false, reason: 'name_taken' };

      const from = p.name;
      p.name = v.normalized;
      this.save('rename', id);
      emit('renamed', { id, from, to: p.name });
      return { ok: true, reason: null };
    },

    // ⛔ Refuses the LAST profile (§6.2): an empty roster after first boot is
    // the state that produces a dead title screen.
    // ⛔ The removed profile's stores are NOT cleared (§4.3), even though
    // scope.clear({ deep: true }) makes it a one-liner. Monotonic seq is the
    // guarantee that makes not-clearing safe.
    remove(id) {
      if (this.roster.length <= 1) return { ok: false, reason: 'last_profile' };
      const i = this.roster.findIndex((p) => p.id === id);
      if (i < 0) return { ok: false, reason: 'not_found' };

      this.roster.splice(i, 1);
      this.fromStore.delete(id);
      if (this.lastUsed === id) this.lastUsed = '';
      this.save('remove', id);
      emit('removed', { id });

      // §6.2 — unlike production, which left activeId naming a gone id for the
      // caller to repair in the same act, kit-profile selects a replacement
      // itself and runs the full §7 lifecycle.
      if (id === this.activeId) this.select(this.roster[0].id);
      return { ok: true, reason: null };
    },

    // --- The profile switch (§7) -------------------------------------------
    //
    // Three steps, in the required order: `beforeChange` while activeId still
    // names the OUTGOING profile, the state transition itself, then `change`
    // with activeId now the INCOMING profile. A game's beforeChange handler
    // flushes the outgoing profile; its change handler resets to shipped
    // defaults and only then loads the incoming one (§7.1) — that reset list
    // lives entirely in the game. kit-profile never imports or references
    // settings, bindings, achievements, game.stats or game.wave; it owns only
    // the two seams.
    //
    // ⛔ Do not collapse the two events into one (§7, §12). A single `change`
    // handler cannot tell which side of the switch it is on, and production's
    // activate() is correct precisely because of that ordering.
    //
    // emit() (§10) swallows a handler's exception internally, so a throwing
    // beforeChange handler cannot abort step 2 partway through — the switch
    // either completes in full or (unknown/no-op id) is never attempted.
    // activeId can never be left half-moved.
    select(id) {
      if (!this.byId(id)) return false;      // unknown id: returns false, fires nothing
      if (id === this.activeId) return true; // already current: a no-op that fires nothing

      const from = this.activeId;
      const to = id;

      // Step 1 — activeId still names the OUTGOING profile.
      emit('beforeChange', { from, to });

      // Step 2 — the switch itself, plus the roster write that makes it the
      // next boot's profile.
      this.activeId = id;
      this.lastUsed = id;
      this.save('select', id);
      this.ensurePlayerId(id);   // backfill: a profile switched TO for the first time may predate player_id

      // Step 3 — activeId now names the INCOMING profile.
      emit('change', { from, to });

      return true;
    }
  };
}

// --- create() (§11, §13 step 1) ----------------------------------------------
//
// Runs the §5 boot sequence synchronously and never throws for anything
// environmental. Missing or non-object `storage` throws — that is programmer
// error, per kit-storage §2.1. Everything else degrades to its default.

export function create(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError(`kit-profile: create() needs a config object, got ${describe(config)}`);
  }

  const { storage } = config;
  if (storage === null || typeof storage !== 'object' || Array.isArray(storage)) {
    throw new TypeError(
      `kit-profile: create({ storage }) requires a kit-storage instance, got ${describe(storage)}`
    );
  }

  const str = (v, d) => (typeof v === 'string' && v.length > 0 ? v : d);
  const cfg = {
    storage,
    maxProfiles:
      Number.isInteger(config.maxProfiles) && config.maxProfiles >= 1
        ? config.maxProfiles
        : DEFAULTS.maxProfiles,
    legacyProfileId: str(config.legacyProfileId, DEFAULTS.legacyProfileId),
    // Through the lenient path (§8.2) so the name a §5.3 mint stores is
    // already what load() will read back next boot — otherwise an over-long
    // configured name would silently shorten itself between the first boot
    // and the second.
    legacyProfileName:
      lenientName(str(config.legacyProfileName, DEFAULTS.legacyProfileName)) ||
      DEFAULTS.legacyProfileName,
    // Explicitly nullable: a new game passes null to skip §5.2 entirely.
    legacyRosterKey:
      config.legacyRosterKey === null ? null : str(config.legacyRosterKey, DEFAULTS.legacyRosterKey),
    legacyProbeKeys: Array.isArray(config.legacyProbeKeys)
      ? config.legacyProbeKeys.filter((k) => typeof k === 'string' && k.length > 0)
      : DEFAULTS.legacyProbeKeys,
    anonymousName: str(config.anonymousName, DEFAULTS.anonymousName)
  };

  const emit = makeEmitter(config.onEvent);

  // §4.1. Redeclaring identically is a no-op in kit-storage, so a game that
  // already listed `profiles` in KitStorage.create({ keys }) is fine.
  storage.declare(ROSTER_KEY, { version: ROSTER_VERSION });

  const state = makeState(cfg, emit);
  state.boot();

  const instance = {
    get firstBoot() {
      return state.firstBoot;
    },
    current: () => state.current(),
    player: () => state.player(),
    list: () => state.list(),
    create: (name) => state.create(name),
    createAnonymous: () => state.createAnonymous(),
    rename: (id, name) => state.rename(id, name),
    remove: (id) => state.remove(id),
    select: (id) => state.select(id),
    scope: (id) => state.scope(id)
  };

  emit('ready', { firstBoot: state.firstBoot, count: state.roster.length });
  return instance;
}
