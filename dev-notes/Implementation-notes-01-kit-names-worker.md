# Implementation Notes — kit-names + Worker integration

## Operator notes — for you, not for Claude Code

Paste each phase block below into Claude Code on its own. Everything Claude
needs is inside the block; nothing above this line goes to it.

| Phase | Session | Launch |
|---|---|---|
| 1 | **New session** | `claude --model sonnet` |
| 2 | Same session as 1 | — |
| 3 | **New session** | `claude --model sonnet --effort xhigh` |
| 4 | Same session as 3 | — |

`high` is the default effort, so Phase 1's session needs no `--effort` flag.

**Why the boundary is between 2 and 3:** the client-side work and the
production Worker change are different risk profiles, and the effort step to
`xhigh` needs a fresh launch. Phases 1–2 are small enough that splitting them
wastes a docs re-read.

**Escalate to `opus` only if** Phase 3's diff finds a real behavioral delta
between the Worker's old rules and kit-names. That stops being a refactor and
becomes a design question — bring it back to a design conversation rather than
letting an implementation session decide it.

---

## Phase 1 — kit-names module

````
Repo: coinless-kit. Nothing for this task has been built yet.

Read first, in order:
- CLAUDE.md
- docs/kit-names.md (the authoritative contract for this work)

Build modules/kit-names/kit-names.js per docs/kit-names.md sections 2 and 3.

- Plain ES module, no dependencies, no DOM access.
- Named exports: validateName, NAME_CHANGE_NOTICE, MAX_NAME_LENGTH.
- Implement the normalize-then-validate sequence exactly as section 2 lists it.

The charset check runs BEFORE uppercasing, deliberately. Uppercasing can
introduce characters that pass an ASCII charset check: 'ß'.toUpperCase() is
'SS' and 'ﬁ'.toUpperCase() is 'FI'. Validating after uppercasing lets both
through, silently changing the name's length and admitting the Unicode the
rules exclude. Do not reorder those two steps.

Run the full test checklist in section 5. Include the 'ß' and 'ﬁ' cases
explicitly — they look redundant next to the general charset test and they are
the regression tests for the ordering above.

Then stop and report results before doing anything else. Do not continue to
kit-leaderboard or the Worker.
````

## Phase 2 — kit-leaderboard v0.2.0

````
Continuing in the same session. Phase 1 built modules/kit-names/kit-names.js
and its tests pass.

Update modules/kit-leaderboard/kit-leaderboard.js:
- Remove the inline validateName implementation and the NAME_CHANGE_NOTICE
  constant.
- Re-export both from kit-names, reference-identical rather than wrapped.
- Update docs/kit-leaderboard-client-api.md: the header line "Depends on:
  nothing" becomes "Depends on: kit-names", and the Tag line becomes v0.2.0.
- Replace that doc's name-rules section with a pointer to docs/kit-names.md.

Verify:
- Existing kit-leaderboard tests pass unmodified. Call sites like
  KitLeaderboard.validateName and KitLeaderboard.NAME_CHANGE_NOTICE must keep
  working with no change.
- Add one test asserting KitLeaderboard.validateName is the same function
  reference as KitNames.validateName, not merely equivalent in behavior.

Do NOT touch the Orbital Overhaul repo. It pins kit-leaderboard v0.1.0 and is
unaffected by this tag existing.

Tag kit-names v0.1.0 and kit-leaderboard v0.2.0.

Update STATUS.md with a kit-names section and the kit-leaderboard version bump.
Add DECISIONS.md entries for any judgment call these two phases required that
docs/kit-names.md did not already resolve.

Then stop and report. Do not start the Worker change — that is a separate
session.
````

## Phase 3 — Worker import

````
Repo: coinless-kit. Already done: modules/kit-names/kit-names.js exists and is
tagged v0.1.0; kit-leaderboard is tagged v0.2.0 and re-exports from it. See
STATUS.md.

Read first, in order:
- CLAUDE.md
- docs/kit-names.md, sections 1.2 and 2
- modules/kit-names/kit-names.js
- services/leaderboard/src/validate.js  (current production code, to be changed)

Before changing anything: diff the Worker's current inline name rules against
kit-names' rules, field by field — charset, length, case folding, whitespace
handling, and the order the checks run in. They should be identical.

If they are NOT identical, stop and report the delta. Do not silently adopt
kit-names' version. A change to what the leaderboard accepts is not something
to introduce as a side effect of a refactor, and it may affect rows already in
D1.

If they are identical, proceed:
- Import validateName from modules/kit-names/kit-names.js.
- Delete the Worker's inline copy of the rules entirely. Do not keep it as a
  fallback. A fallback that only runs when an import fails is untested code; if
  the import breaks, the deploy should fail loudly rather than serve stale
  rules.
- Confirm the cross-directory import resolves under `wrangler deploy`'s esbuild
  bundling. If it does not resolve cleanly, stop and report rather than
  restructuring the repo layout to work around it.

Then stop and report before deploying.
````

## Phase 4 — Deploy and smoke test

````
Continuing in the same session. Phase 3 changed
services/leaderboard/src/validate.js to import from kit-names and deleted the
inline copy. Nothing has been deployed yet.

Read first: docs/kit-leaderboard-deploy-notes.md

Run:
  cd services/leaderboard
  npx wrangler deploy

Then run the FULL smoke-test sequence from the deploy notes against production,
exactly as it was run for the original rollout: health, origin rejection, valid
submit, idempotent duplicate, bounds-check flagging, name rejection,
unknown-stats-key flagging, top-players dedup, and board reads across the
24h / 4h / year / all windows.

Give the name-rejection case extra attention specifically, since that is the
behavior actually changing. Submit a name that both the old inline rules and
kit-names should reject, and confirm it is still rejected.

Clean up test rows (game_version = '0.0.0-test') from production per the deploy
notes' post-smoke-test step.

Update STATUS.md: note the name-rules consolidation, the date, and that the
Worker now has no independent copy of the rules. Add DECISIONS.md entries for
anything that came up.

Then report back. Do not chain into the next module — kit-storage is a separate
session with its own notes file.
````