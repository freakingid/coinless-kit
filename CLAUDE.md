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

## Working on the leaderboard service

    cd services/leaderboard
    npx wrangler dev --local --var ENVIRONMENT:dev    # local dev + D1
    npx wrangler d1 migrations apply coinless-scores --local   # after schema changes
    npx wrangler d1 migrations apply coinless-scores --remote  # production
    npx wrangler deploy

D1 binding name is `coinless_scores` (not `DB`) — set explicitly per the repo
owner's instruction, overriding the example name in the deploy notes doc.

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