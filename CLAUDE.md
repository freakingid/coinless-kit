# CLAUDE.md

coinless-kit: shared, reusable components for the coinlessgames.com HTML5
arcade game series. Games pin a tagged version of this repo rather than
tracking `main`.

## Layout

    services/<name>/    Server components (Cloudflare Worker + D1, etc.)
    modules/<name>/     Client modules a game imports
    docs/               One doc set per module — the contract, read these first

See `STATUS.md` for which modules and services actually exist and what state
they're in. This section describes the shape, not the inventory.

## The docs are authoritative

Before touching a module, read its docs in `docs/`. They're the product of a
design conversation with the repo owner and represent decisions already
made, not suggestions. If code and docs disagree, that's a bug to flag, not
a chance to improvise. When you change behavior, update the doc in the same
commit — the docs are what future sessions read instead of reverse-engineering
source.

Several docs carry ⛔-marked lines. Those mark decisions that look like
oversights or over-complications but aren't — each one traces to a real bug or
a real data-loss risk, and the reason is stated inline. Don't "simplify" past
one without raising it first.

See `STATUS.md` for what's currently built/deployed and `DECISIONS.md` for
implementation choices made where the docs were silent or ambiguous.

## Module versioning

Each module's version is independent of the others and lives in two places
that must always agree: the module's own JS file (`export const VERSION =
'X.Y.Z'`) and its doc's `**Version:**` header line. A mismatch between them
is a bug, same as any other doc/code disagreement.

Ordinary semver, decided per module: PATCH for a bug fix with no contract
change, MINOR for an additive/backward-compatible change, MAJOR for a
breaking change to the doc'd contract. Bump it in the same commit as the
change that motivates it, and record the *why* in `DECISIONS.md` as usual.

A module's `Depends on:` header line names a minimum version of anything it
depends on, e.g. `` `kit-names` >= 0.1.0 `` — so a future bump to the
dependency can be checked against what actually needs it.

⛔ **Git tags are not how modules are versioned**, and an instruction that
says "tag module X vY" (an older doc may still phrase it that way) means
"bump `VERSION`," not "create a git tag." Tags are repository-wide, so one
tag can't represent "kit-names changed but kit-storage didn't" — that
mismatch is exactly what this section replaced. Tags are the repo owner's
own bookmarks now, created by hand whenever they choose; nothing in this
repo's workflow depends on a tag's name or existence, and a session should
not create one without being explicitly asked to.

## Working on the leaderboard service

    cd services/leaderboard
    npx wrangler dev --local --var ENVIRONMENT:dev    # local dev + D1
    npx wrangler d1 migrations apply coinless-scores --local   # after schema changes
    npx wrangler d1 migrations apply coinless-scores --remote  # production
    npx wrangler deploy

D1 binding name is `coinless_scores` (not `DB`) — set explicitly per the repo
owner's instruction, overriding the example name in the deploy notes doc.

## How to report back

Work here runs in phases, and the repo owner's next action is almost always
"start the next phase or don't." **Lead every report with that verdict, in the
first line or two, before any detail:**

- **"Done, all checks passed — safe to proceed to X."**
- **"Stopped — blocked on X, do not proceed."** Say what's needed to unblock.
- **"Done, but X is broken/uncertain"** — only when something genuinely
  affects whether the next phase can run.

**Immediately after the verdict, list any non-blocking suggestions — one line
each, no detail.** This is a table of contents, not the discussion: enough for
the owner to decide whether any of them is worth reading about, and nothing
more. Write `Suggestions: none.` when there are none, so the absence is
explicit rather than something to infer.

    Done, all checks passed — safe to run Phase 4.

    Suggestions (none blocking):
    - Use `ß` as the smoke-test name-rejection case, not `Gh0st!`.
    - Tag `v0.2.0` doesn't exist yet — fine for now, but a game can't pin
      this work until it does.

**Every item in that list must be verified, not inferred, before it's
written** — the same evidence bar as the main verdict, just applied to the
small stuff too. Run the check (read the file, grep, `git tag -l`, whatever
it takes) rather than pattern-matching from context and presenting a guess as
a fact. If a check can't be run quickly, either run it anyway, drop the
suggestion, or label it plainly as unverified — never state it as settled
when it isn't. This adds no extra confirmation step and does not slow down or
interrupt otherwise-autonomous work; it is a bar the report has to clear
before it's written, not a reason to stop and ask.

Then a short paragraph of what actually changed and what was verified. Details,
file lists, and any expansion on the suggestions go last, in that order.

Do not bury the verdict under caveats. Notes headed "two things to flag" or
"worth noting" read as blockers even when they aren't, and cost the owner time
working out whether they can move. **If something is not a blocker, say so
where you raise it** — "doesn't block Phase 4" — or leave it out and open it as
its own item. An unrelated observation is not a reason to make a green result
look yellow.

If tests failed or a step was skipped, say that plainly and early. A clean
report that turns out to be wrong is far more expensive than a blunt one.

## Hard constraints (repo-wide, not just one module)

- No game code lives here, ever. Orbital Overhaul and any other game is a
  separate repo. This repo never reaches into game state or renders anything.
- No achievements in any module built so far. Achievements are a separate
  future kit module, designed later, by deliberate decision — not an
  oversight. This applies to kit-leaderboard, kit-storage and kit-profile
  alike; nothing achievement-shaped belongs in any of them.
- No per-game plausibility/score-reconstruction validators. The bounds check
  in the worker spec is the complete anti-cheat story, on purpose.
- No frameworks. Modules are plain ES modules that run directly from source
  in a browser. No bundler, transpiler, or watcher is required to develop,
  test, or read a module day to day, and none may ever become required to
  understand one — that means no JSX, no TypeScript syntax, no decorators,
  no compile-time codegen, no framework build plugins in module source.
- A release build step is expected and fine. One scripted command (esbuild,
  near-zero config) inlines modules into a game's distributable HTML at
  release time. That step is deliberate. The rule above constrains what
  module *source* may depend on, not how a game is shipped.
- Dependencies default to zero. A strong preference, not an absolute ban: a
  module may take one if its doc names it and says why. Kit modules
  depending on *each other* is normal and expected — see each module's
  `Depends on:` header line.
- If something in a doc looks ambiguous, wrong, or missing, stop and ask
  rather than inventing a resolution and moving on.