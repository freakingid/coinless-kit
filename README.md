# coinless-kit

Shared, reusable components for the coinlessgames.com game series.

Planned modules: title/menu system, options (sound channels, music choice,
difficulty), local high scores, achievements, internet leaderboard, captions
and voice, event-driven procedural music.

## Layout

    services/leaderboard/    Cloudflare Worker + D1 leaderboard API (shared by all games)
    modules/kit-leaderboard/ Client module a game imports to talk to that API
    docs/                    Spec and integration docs, one set per module

Each future module gets `modules/kit-<name>/` and, if it needs a backend,
`services/<name>/`.

## How games consume this

Games pin a **tagged version** of this repo rather than tracking `main`, so
improving a module later never silently changes an already-shipped game.
Upgrades are deliberate.

    git tag v0.1.0 && git push --tags

## Working on it

Each module's doc in `docs/` is the contract. When adding a feature, update
the doc in the same commit as the code — the docs are what future Claude Code
sessions read instead of reverse-engineering the source, which is the entire
point of this repo existing.
