# Implementation Notes — kit-storage

## Operator notes — for you, not for Claude Code

Paste each phase block below into Claude Code on its own. Everything Claude
needs is inside the block; nothing above this line goes to it.

**Prerequisite:** session 01 complete — kit-names v0.1.0 built, kit-leaderboard
v0.2.0 tagged, Worker deployed and smoke-tested.

| Phase | Session | Launch |
|---|---|---|
| 1 | **New session** | `claude --model opus` |
| 2 | Same session as 1 | — |
| 3 | **New session** | `claude --model sonnet` |
| 4 | Same session as 3 | — |
| 5 | **New session** | `claude --model sonnet --effort xhigh` |

`high` is the default effort, so only Phase 5's session needs an `--effort` flag.

**Why Opus for 1–2 and not the rest:** Phase 2 is the one place where being
wrong is silent and permanent. Its step 5 — a stored version newer than the
running build reads nothing and writes nothing — looks like an unfinished
branch and is the single most important line in the module. That is a
"does it understand" risk, not a "did it run the tests" risk. Phase 1 rides
along rather than getting its own Sonnet session: it is small, it edits the
same file, and a boundary would cost a model switch to save very little.

**Why 5 is its own session:** a test pass wants the finished module, not the
reasoning that produced it. A fresh session reading the module it is testing
cannot lean on remembering what it meant to write.

**Escalate and stop** if any phase wants to change something on spec section 13's
list. That list is the output of a design conversation; a disagreement with it
comes back here rather than being resolved in-session.

---

## Phase 1 — Skeleton, keyspace, availability

````
Repo: coinless-kit. kit-names and kit-leaderboard v0.2.0 are done (see
STATUS.md). kit-storage does not exist yet.

Read first, in order:
- CLAUDE.md
- docs/kit-storage-spec.md
- docs/kit-storage-client-api.md

kit-storage has NO dependencies, including on kit-names. Do not import it.

Build the start of modules/kit-storage/kit-storage.js — plain ES module, named
export `create`.

- Identifier validation per spec section 3.2: gameId, scopeId, key, and '.'
  illegal in all three. These THROW. Spec section 2.1 governs: environmental
  failure is a return value, programmer error is an exception.
- Availability probe per section 5.1. The try must wrap the property access
  `window.localStorage` itself, not only the setItem call — some embedded
  contexts throw on access.
- Declaration table: create({ keys }) plus declare(), with idempotency and
  conflict-throw per section 7.1.
- Undeclared key on get/set/has/remove throws. keys/scopes/clear/usage never
  throw for undeclared keys.

The 3-character minimum on gameId is deliberate: kit-leaderboard already owns
coinless.lb.<gameId>.v1, and a 3-char minimum makes 'lb' an impossible gameId,
so collision is structurally impossible rather than merely unlikely. Do not
relax it.

Test the validators and the declaration conflict cases, then continue to the
next phase in this same session when I paste it.
````

## Phase 2 — Envelope and the version algorithm

````
Continuing in the same session. Phase 1 built the skeleton, validators,
availability probe, and declaration table.

Implement the {v, d} envelope (spec section 4) and the COMPLETE seven-step read
algorithm in section 7.3. Implement each numbered step; do not paraphrase the
algorithm into something shorter.

This is the phase that can silently destroy player data. One branch looks like
an oversight and is not:

  STEP 5 — stored version is NEWER than declared. Return the fallback, fire
  'downgrade', and WRITE NOTHING. This is a player who loaded an older build
  over newer data: a cached itch.io build, or a rollback. It is the only path
  in the module capable of destroying data the running build does not
  understand yet. It is deliberately inert. Do not "complete" it.

Steps 3, 6 and 7's failure branches are also all non-writing. The ONLY read
path that writes is step 7's successful forward migration.

Also required from the spec, and each is deliberate:
- Versions are per key, not per store.
- migrate() receives the origin version and handles any older version it cares
  about. There is no migration chaining.
- A failed migration write-back is not an error; migration simply runs again
  next load.

Test now, before anything else depends on this. Run all five version cases from
section 15's "Versioning" block. For every non-writing case, assert on the
STORED BYTES afterward, not just the returned value — a test that only checks
the return value passes even if the module silently rewrote storage.

Then stop and report. Show the downgrade-case test and its byte assertion
specifically. Do not continue to the memory shim or scopes — that is a separate
session.
````

## Phase 3 — Memory shim and quota

````
Repo: coinless-kit. Already done: modules/kit-storage/kit-storage.js has its
skeleton, validators, availability probe, declaration table, envelope handling,
and the full version/migration algorithm from spec section 7.3, all tested. See
STATUS.md.

Read first, in order:
- CLAUDE.md
- docs/kit-storage-spec.md, sections 5, 8, and 13
- modules/kit-storage/kit-storage.js

Implement the memory shim per section 5.2:
- Any failed write is retained in memory for the rest of the page session.
- set() returns false to say it is not durable.
- A SUCCESSFUL set() clears any memory entry for that key, so a durable write
  is never shadowed by a stale in-memory copy.
- remove() clears both.
- No read cache: a get() with no memory entry always re-reads storage.

Implement quota handling per section 8:
- Detect by error name OR DOM code — browsers disagree. Cover
  QuotaExceededError, NS_ERROR_DOM_QUOTA_REACHED, code 22, and code 1014, and
  treat any unrecognized write failure as quota anyway.
- Fire 'quota', return false.
- NO EVICTION, ever. Not LRU, not oldest, not largest. kit-storage cannot know
  what is valuable; the owning module decides what to shed.

Note a deliberate asymmetry, in case it looks like a bug: kit-leaderboard's
offline queue keeps NOTHING in memory when storage is blocked. kit-storage
retains. Both are correct for their own case — see section 5.3. Do not
harmonize them.

Continue to the next phase in this same session when I paste it.
````

## Phase 4 — Scopes, enumeration, raw

````
Continuing in the same session. Phase 3 added the memory shim and quota
handling.

Implement, per spec sections 6, 9, and 3.4:

scope(id) — same interface over a longer prefix, SHARING the parent's probe
result, onEvent handler, and declaration table. Declarations are store-wide,
not per-scope; that is what makes one declare('achievements', ...) work across
every profile scope.

Enumeration, using the segment-count rule that the no-'.' guarantee makes
possible:
- keys() and clear() are own-level only.
- clear({ deep: true }) includes nested scopes.
- scopes() lists direct children, one level.
Own-level-only as the default is deliberate: "wipe this profile completely"
should require typing deep.

raw — unprefixed, unversioned, un-enveloped STRINGS. Exempt from clear(),
invisible to keys(), same shim rules. This exists because real production keys
predate the namespace and cannot be moved (afd_settings_v1,
afd_achievements_v2, afd_profiles_v1). Do not remove it.

usage() — estimate, UTF-16, this prefix only.

Then stop and report. Do not start the browser test pass — that is a separate
session.
````

## Phase 5 — Real-browser test pass

````
Repo: coinless-kit. modules/kit-storage/kit-storage.js is complete: skeleton,
version algorithm, memory shim, quota handling, scopes, enumeration, and raw.
See STATUS.md. It has not yet been tested in a real browser.

Read first, in order:
- docs/kit-storage-spec.md, section 15 (the test checklist) and section 13
- docs/kit-storage-client-api.md
- modules/kit-storage/kit-storage.js

Build a static demo.html harness in the module directory, same pattern as
kit-leaderboard's: single file, <script type="module">, served over real http
(ES modules do not load from file://). It exercises the API and imports no game
code.

Run the FULL section 15 checklist in a real browser. Two blocks cannot be
verified in Node with a mocked localStorage and must be done in the browser:

- BLOCKED STORAGE. Simulate with an iframe carrying sandbox="allow-scripts" and
  NOT allow-same-origin — localStorage access throws there, which is the real
  itch.io / Newgrounds failure mode. Verify create() does not throw,
  available === false, 'unavailable' fires once, and every method still works.

- QUOTA. Actually fill storage, then set(). Verify the false return, the
  'quota' event, get() returning the new value from memory, and a direct
  storage read still holding the OLD value.

Also verify cross-namespace isolation: two gameIds do not see each other, and
clear() leaves coinless.lb.* untouched. Create a kit-leaderboard-shaped key by
hand and assert it survives.

For every version case that should not write, assert on stored bytes, not just
return values.

Then: tag kit-storage v0.1.0. Update STATUS.md with a kit-storage section in
the established format — what was built, what was tested and how, any known
gaps. Add DECISIONS.md entries for judgment calls the spec did not resolve. If
anything on spec section 13's list looked wrong during implementation, raise it
rather than working around it.

Report back. Do not start kit-profile — it must be written against the shipped
API, not a remembered one, and it has its own notes file.
````