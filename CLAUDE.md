# CLAUDE.md

coinless-kit: shared, reusable components for the coinlessgames.com HTML5
arcade game series. Games pin a tagged version of this repo rather than
tracking `main`.

## Layout

    services/leaderboard/    Cloudflare Worker + D1 leaderboard API
    modules/kit-leaderboard/ Client module a game imports to talk to that API
    docs/                    One doc set per module — the contract, read these first

## The docs are authoritative

Before touching a module, read its docs in `docs/`. They're the product of a
design conversation with the repo owner and represent decisions already
made, not suggestions. If code and docs disagree, that's a bug to flag, not
a chance to improvise. When you change behavior, update the doc in the same
commit — the docs are what future sessions read instead of reverse-engineering
source.

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

## Hard constraints (repo-wide, not just this module)

- No game code lives here, ever. Orbital Overhaul and any other game is a
  separate repo. This repo never reaches into game state or renders anything.
- No achievements anywhere in this module. Separate future kit module,
  designed later, by deliberate decision — not an oversight.
- No per-game plausibility/score-reconstruction validators. The bounds check
  in the worker spec is the complete anti-cheat story, on purpose.
- No frameworks, no build step, no dependencies unless a doc says otherwise.
- If something in a doc looks ambiguous, wrong, or missing, stop and ask
  rather than inventing a resolution and moving on.
