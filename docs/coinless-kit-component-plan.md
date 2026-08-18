# coinless-kit — Component Plan

**Status:** planning document. One module (`kit-leaderboard`) is built and shipped;
`kit-scores` is in progress. Everything else here is proposed, not decided.

This document exists to be argued with. Where it proposes features, those are
suggestions for the classic-arcade category you're building in — take the ones
that fit the vision and discard the rest.

---

## Part 1 — Cross-cutting decisions to make first

These aren't modules. They're decisions that shape every module, and getting
them wrong means rework across the whole kit. Worth settling before building
the next component.

### 1.1 The big one: DOM overlay or canvas-rendered UI?

Every visual module — menus, options, high score tables, achievement lists,
captions — has to answer this, and they should all answer it the same way.

**DOM overlay** (HTML elements positioned over the canvas):
- Text rendering, layout, scrolling, and accessibility come free
- Screen readers work; captions are genuinely accessible
- Styling via CSS, so theming is trivial
- Breaks the illusion slightly — DOM text looks different from canvas pixels
- Fullscreen and scaling need care to stay aligned with the canvas

**Canvas-rendered** (drawn with the same renderer as the game):
- Pixel-perfect consistency with the game's aesthetic — matters a lot for
  authentic arcade feel
- Scales identically with the game, no alignment problems
- You reimplement text layout, wrapping, scrolling, focus, and input handling
- Accessibility is effectively impossible without a parallel DOM layer
- Considerably more code per module

**My recommendation: DOM overlay, styled aggressively to look arcade-native.**
Bitmap-style web fonts, image-rendering pixelated, CRT effects via CSS filters.
The accessibility argument is decisive on its own — `kit-captions` is
fundamentally an accessibility feature and canvas-rendered captions would
undercut its entire purpose. The aesthetic gap is closable with CSS; the
accessibility gap is not closable with canvas.

**Caveat worth weighing:** if Orbital Overhaul's existing menus are already
canvas-rendered and look right to you, switching to DOM means visual rework
plus a period where the kit's UI and the game's own UI don't match. Worth
checking what's actually there before committing.

### 1.2 Theming

Whatever the answer to 1.1, every module needs to accept a theme rather than
hardcoding appearance. Proposed shape — a single theme object passed to each
module at creation:

```js
const theme = {
  colors: {
    bg, fg, accent, dim, danger, highlight,
    scanline, glow
  },
  fonts: {
    display,       // headings, titles, big numbers
    body,          // menu items, descriptions
    mono           // scores, tables — must be tabular-figures
  },
  effects: {
    scanlines: true,
    glow: 'soft',        // 'none' | 'soft' | 'heavy'
    flicker: false,
    chromaticAberration: false
  },
  sounds: {              // UI feedback, distinct from game SFX
    move, select, back, error, unlock
  }
};
```

One theme object per game, passed to every kit module. Change a game's palette
in one place and every kit screen follows. A `themes/` folder in coinless-kit
with two or three presets (amber terminal, green phosphor, full-color arcade)
gives new games a starting point.

**Tabular figures matter more than they sound.** Score tables with
proportionally-spaced digits look wrong — the columns jitter. Whatever display
font gets chosen needs monospaced numerals or the high score table will never
look right.

### 1.3 Persistence: `kit-storage`

Not a feature module — a shared dependency. Profiles, options, local scores,
and achievements all need to persist, and they all face the same problems:

- `localStorage` can be **entirely unavailable** in embedded iframes on itch.io
  and Newgrounds, or in private browsing. You already hit this with the
  leaderboard's offline queue. Every module needs to degrade gracefully rather
  than throw.
- Keys need namespacing per game, or two games on the same domain collide.
- Schema versioning, so a future format change can migrate rather than corrupt.
- Quota limits (~5MB, but effectively much less in some embedded contexts).

Building this once as `kit-storage` and having every other module depend on it
means the "storage is unavailable" path gets solved and tested once. The
alternative — each module rolling its own — guarantees inconsistent behavior
across modules in exactly the environments hardest to test.

**Proposed API:**

```js
const store = KitStorage.create({ gameId: 'orbital-overhaul', version: 1 });
store.available          // false in blocked-storage contexts
store.get(key, fallback)
store.set(key, value)    // returns false if it couldn't persist
store.remove(key)
store.migrate(fromVersion, migrationFn)
```

### 1.4 Module conventions (already proven with kit-leaderboard)

The pattern that worked, worth keeping:

- Config in, events out. Modules never reach into game state.
- Modules are real ES modules (`import`/`export`), developed and testable in
  isolation with no tooling required for day-to-day work. At release, one
  automated command (esbuild, near-zero config) inlines everything — kit
  modules, game code, base64 assets — into the final distributable HTML.
  This is a deliberate build step, not an accident: a scripted, repeatable
  inline is more reliable than manual copy-paste concatenation, which is
  itself an unautomated build step with more ways to go stale (e.g. shipping
  a module after it was edited but before it was re-copied in by hand).
- Dependencies default to zero — this has served the project well and is the
  right instinct for something with a long shelf life, where an abandoned or
  breaking-changed dependency years out is a real cost. But it's a strong
  default, not an absolute ban: a specific, justified dependency is fine if
  one module genuinely needs it (procedural audio synthesis in `kit-audio`
  is the one place this seems most likely to come up). `kit-storage` and
  `kit-profile` have no reason to want one.
- Each module's doc in `docs/` is the contract; a future Claude Code session
  reads the doc, not the source.
- Games pin a tagged version rather than tracking `main`.
- The doc's "what this module deliberately does not do" section is as
  important as the API section — it's what stops a session from helpfully
  expanding scope.

### 1.5 Web Audio unlock

Browsers block audio until a user gesture. This affects `kit-audio` and
`kit-captions` both, and it interacts with `kit-menu` (the title screen's
"press start" is the natural unlock moment). Worth solving once in a shared
place rather than twice: whichever module owns it, the others depend on it
being done before they can make sound.

---

## Part 2 — The modules

Ordered by dependency, not priority.

---

### `kit-storage` — foundation

**Purpose:** namespaced, version-aware, gracefully-degrading persistence.
See 1.3 above.

**Why first:** everything else depends on it. Building it after two or three
modules have already rolled their own storage means retrofitting.

**Arcade-appropriate features:** none, really — it's plumbing. But it should
support an explicit "storage unavailable" state that `kit-menu` can surface
to the player ("scores can't be saved in this browser"), which is more honest
than silently losing progress.

---

### `kit-profile` — foundation

**Purpose:** local player identity. Owns `player_id` (the stable UUID
`kit-leaderboard` requires), `display_name`, and the roster of local profiles.

**This partially exists already** — Orbital Overhaul got `player_id` minting and
backfill during the leaderboard integration. That work is the starting point;
extracting it is a good first extraction because it's small, already proven,
and unblocks the modules that depend on it.

**Inputs / config:**
```js
KitProfile.create({
  storage,                    // kit-storage instance
  maxProfiles: 4,
  defaultName: 'PLAYER',
  nameRules: 'arcade'         // 3-char initials, or 12-char full names
});
```

**API sketch:** `list()`, `current()`, `select(id)`, `create(name)`,
`rename(id, name)`, `delete(id)`, `on('change', cb)`

**Customizable:** max profiles, name length/charset (3-letter arcade initials
vs. longer names), whether profile selection is required at boot or a default
profile is auto-created.

**Arcade-appropriate features worth considering:**
- **Three-letter initials mode.** The authentic arcade choice. Note the
  tension: `kit-leaderboard` allows 12 characters, so a game using initials
  mode would submit 3-char names to a board that permits longer ones. Fine —
  but worth being deliberate about, because mixed name lengths on one board
  look inconsistent.
- **"New player?" prompt on first boot**, rather than silently creating an
  anonymous profile.
- Profile switching from the pause menu, for couch multiplayer alternating
  play.

**Critical constraint:** `player_id` is minted once and never regenerated.
Backfill for pre-existing profiles must check-then-mint on every load. This is
the failure mode that silently fragments a player's leaderboard history, and
it's already been solved once in Orbital Overhaul — carry that logic over
rather than rewriting it.

---

### `kit-scores` — local high scores *(in progress)*

**Purpose:** the local high score table. Currently being designed in a separate
conversation; included here for completeness and because its seams affect
neighboring modules.

**Open question that affects other modules:** whether the local table is a
genuinely independent list or a cache of the network board. That decision
determines whether `kit-scores` depends on `kit-leaderboard` or is fully
standalone — and whether a game without an internet leaderboard can use it
unchanged.

**Arcade-appropriate features:**
- **Initials entry with joystick-style letter selection** — up/down to cycle
  A–Z, button to confirm, with the classic timer counting down. This is one of
  the most evocative arcade interactions there is and it's almost entirely
  absent from modern games.
- **"YOUR SCORE RANKS #3" fanfare** on qualifying, before the entry screen.
- **Rolling attract-mode display** of the high score table between demo loops.
- **Per-difficulty tables**, if difficulty options end up mattering.
- Default table pre-populated with plausible fake scores, arcade-style, so a
  fresh install doesn't show an empty board. (Worth a flag distinguishing real
  from seeded entries so they can be cleared once real scores exist.)

---

### `kit-options` — settings

**Purpose:** the options/settings screen and the persistence behind it. Sound
channel volumes, music selection, difficulty parameters, accessibility toggles.

**Inputs / config:** a declarative schema the game provides, so the module
renders and persists without knowing what any setting means:

```js
KitOptions.create({
  storage, theme,
  schema: [
    { id: 'vol_music',  type: 'range',  label: 'MUSIC',  min: 0, max: 10, default: 7 },
    { id: 'vol_sfx',    type: 'range',  label: 'SFX',    min: 0, max: 10, default: 8 },
    { id: 'vol_voice',  type: 'range',  label: 'VOICE',  min: 0, max: 10, default: 8 },
    { id: 'music_set',  type: 'choice', label: 'SOUNDTRACK',
      options: ['SYNTH', 'CHIP', 'SILENT'], default: 'SYNTH' },
    { id: 'difficulty', type: 'choice', label: 'DIFFICULTY',
      options: ['EASY', 'NORMAL', 'HARD'], default: 'NORMAL' },
    { id: 'captions',   type: 'toggle', label: 'CAPTIONS', default: true },
    { id: 'scanlines',  type: 'toggle', label: 'SCANLINES', default: true }
  ],
  onChange: (id, value) => {}
});
```

**Customizable:** the entire schema is game-supplied, so the module is fully
generic. Theme controls appearance. Grouping/pagination for longer lists.

**Arcade-appropriate features worth considering:**

- **Style the options screen as an arcade operator service menu.** This is the
  strongest idea in this document for your specific brand. Real arcade cabinets
  had a hidden service menu with DIP switches for difficulty, lives, bonus
  thresholds, and free-play mode. Presenting player options in that visual
  language — monospaced, blue-screen, "OPERATOR SETTINGS," DIP switch toggles —
  is instantly evocative to anyone who ever saw one, and it's a natural fit for
  "No Coins Required": the free-play switch is permanently ON, and you can say
  so on screen.
- **Sound test mode.** Every arcade service menu had one. Lets a player audition
  music tracks and SFX by number. Cheap to build if `kit-audio` exposes a track
  list, and it's pure nostalgia.
- **Bookkeeping / statistics screen.** Arcade operators had a stats page — total
  plays, average game duration, high score. Repurposed for the player, it's a
  lifetime stats screen that costs almost nothing given the data already exists.
- **Difficulty as separate parameters rather than one preset.** Arcade DIP
  switches set lives, enemy speed, and bonus thresholds independently. Exposing
  two or three orthogonal knobs is both more authentic and more interesting than
  Easy/Normal/Hard — and it matches your "tuned for fun, not for quarters"
  philosophy, since players can tune it themselves.

**Interaction with `kit-leaderboard`:** if difficulty is player-adjustable, board
entries arguably need to record it, or an EASY run competes with a HARD one.
The `stats` blob can carry it with no schema change. Worth deciding when
difficulty options actually ship rather than now.

---

### `kit-menu` — title screen and navigation

**Purpose:** the title screen, main menu, pause menu, and the navigation model
that ties every other screen together. This is the module the others plug into.

**Inputs / config:**
```js
KitMenu.create({
  theme, storage, profile,
  title: 'ORBITAL OVERHAUL',
  subtitle: 'ATOMIC DUSTBIN DAN',
  items: [
    { id: 'start',        label: 'PRESS START',   action: () => game.start() },
    { id: 'scores',       label: 'HIGH SCORES',   screen: kitScores.screen },
    { id: 'leaderboard',  label: 'LEADERBOARD',   screen: kitLeaderboard.screen },
    { id: 'achievements', label: 'ACHIEVEMENTS',  screen: kitAchievements.screen },
    { id: 'options',      label: 'OPTIONS',       screen: kitOptions.screen }
  ],
  attract: { enabled: true, idleSeconds: 20 }
});
```

**Customizable:** theme, item list, whether items are game-supplied actions or
kit-module screens, attract-mode timing, input bindings.

**Arcade-appropriate features worth considering:**

- **Attract mode.** The single most defining arcade behavior: after idling, cycle
  through title screen → high scores → gameplay demo → story/instructions →
  repeat. Almost no modern indie game does this, and it's immediately
  recognizable. The gameplay-demo portion needs game cooperation (either a
  recorded input replay or a simple AI), so the kit should define the hook and
  let each game fill it.
- **"NO COINS REQUIRED — JUST PRESS START"** where the coin prompt would be. It's
  your tagline and this is its natural home. The joke lands harder if the
  surrounding presentation is otherwise faithful — insert-coin blink timing,
  same screen position, same urgency.
- **Marquee / bezel framing.** Optional decorative border around the play area
  evoking a cabinet bezel, with the game's logo as a marquee above. Toggleable,
  since it costs screen space.
- **High score table in the attract rotation** — ties `kit-scores` and `kit-menu`
  together the way real cabinets did.
- **A credits/attribution screen** in the classic scrolling style.
- **Consistent input model across all screens.** Arcade UIs were navigable with
  a joystick and two buttons, nothing else. Designing every kit screen to be
  fully operable with up/down/left/right/confirm/back — no mouse required — is
  both authentic and better for gamepad and accessibility. Mouse and touch can
  be additive.

---

### `kit-achievements` — lifetime achievements

**Purpose:** achievement definitions, progress tracking, unlock detection, the
achievement list screen, and the unlock notification. Plus, eventually, the
server side for making achievements visible to other players.

**Already partly specified:** Orbital Overhaul's 20 lifetime achievements are
defined, with tier structures (6 rungs, bronze→diamond) and counter types
(`SUM`, `SUM_PER_EVENT`, `SUM_PER_GAME`, `MAX`). Those counter types are the
real design work here, and they generalize well.

**Inputs / config:** a declarative achievement definition list, similar in
spirit to `kit-options`' schema:

```js
KitAchievements.create({
  storage, theme, profile,
  definitions: [
    { id: 'recycling_magnate', name: 'Recycling Magnate',
      desc: 'Deliver canisters to the dock',
      counter: 'SUM', tiers: [1000, 5000, 10000, 25000, 50000, 100000] },
    { id: 'century_club', name: 'Century Club',
      desc: 'Reach wave 25 in a single game',
      counter: 'MAX', goal: 25 }
  ],
  onUnlock: (id, tier) => {}
});
```

Game calls `report('canisters_delivered', 12)` during play; the module handles
accumulation, tier crossing, persistence, and unlock events.

**Customizable:** definitions, tier naming (bronze/silver/gold vs. numbered),
notification style and duration, whether progress is visible before unlock.

**Arcade-appropriate features worth considering:**
- **Unlock notification styled as an arcade bonus announcement** — a banner with
  a distinctive jingle, not a modern toast.
- **Tier names as materials rather than numbers** — the bronze→diamond ladder
  you've already defined reads better than "Level 4."
- **Progress bars visible before unlock**, which turns the list into a to-do
  list rather than a mystery box.
- **Weekly achievements as a separate visual section**, clearly distinguished
  from lifetime ones. You've already decided weekly achievements exist in most
  games but don't belong on leaderboards — the same distinction should be
  visible in the UI.

**Server side (deferred, already decided):** lifetime achievements should be
visible to other players, which needs an API. Tiered achievements use one ID
plus a tier number column, not one ID per rung. That's a separate service
alongside the leaderboard Worker, designed later. `kit-achievements` should be
built so the local tracking works with no server at all, and syncing is
additive — same shape as the leaderboard's offline queue.

---

### `kit-audio` — adaptive music and sound

**Purpose:** Web Audio-based music and SFX playback, with music that responds to
game events — danger escalation being the driving use case.

This is the most technically ambitious module in the kit and probably deserves
its own design conversation rather than being specced alongside the others.

**Two possible approaches, and they're very different projects:**

**A. Layered stems.** Music is authored as separate loops (bass, drums, lead,
tension) that play in sync; escalation fades layers in and out. Predictable
musical quality, requires authored audio assets, larger file size, and the
"single-file HTML" constraint gets awkward with several audio files inlined
as base64.

**B. Procedural generation.** Music is synthesized at runtime from a scale,
tempo, and pattern rules, with parameters shifting on events. No audio assets,
tiny file size, endlessly variable, and it fits the single-file constraint
perfectly. But it's much harder to make consistently *good*, and it sounds like
what it is — which for a chiptune-adjacent arcade aesthetic may be exactly right.

**My inclination for your project: B, or a hybrid** — procedural for ambient and
adaptive layers, with a few authored stingers (game over, achievement unlock,
extra life) since those need to be memorable and precise. Procedural fits both
the aesthetic and the single-file distribution constraint, and the "richer than
the hardware could deliver" framing in your project's philosophy is more
interesting when the music is generative rather than looped.

**Inputs / config:**
```js
KitAudio.create({
  storage,
  channels: { music: 0.7, sfx: 0.8, voice: 0.8, ui: 0.6 },
  tracks: [...],
  onIntensityChange: (level) => {}
});
kitAudio.setIntensity(0.8);     // danger escalation, 0..1
kitAudio.event('enemy_spawn');
kitAudio.play('explosion');
```

**Customizable:** channel volumes (wired to `kit-options`), track selection,
intensity mapping, whether music is procedural or authored per game.

**Arcade-appropriate features worth considering:**
- **Intensity as a continuous parameter, not discrete states.** Smooth escalation
  as danger rises reads better than switching between "calm" and "danger" tracks.
- **Ducking.** Music dips under voice lines and important SFX automatically.
  Essential once `kit-captions` exists.
- **A "SILENT" music option that isn't just volume zero** — some players want SFX
  without music, and arcade cabinets in noisy rooms effectively had this.
- **Sound test integration** with the options service menu.
- **Extra-life and warning stingers** as distinct, recognizable audio events —
  the arcade audio vocabulary players already know.
- **Attract-mode audio that's quieter than gameplay**, the way cabinets were
  tuned so an idle machine didn't dominate the room.

**Practical constraint:** Web Audio requires a user gesture before it can make
sound. The title screen's "press start" is the natural unlock point, which
means `kit-menu` and `kit-audio` need a defined handoff.

---

### `kit-captions` — voice and captions

**Purpose:** spoken dialogue/narration plus synchronized on-screen captions.
Primarily an accessibility feature, secondarily a character/flavor system
(Atomic Dustbin Dan's in-world voice).

**Two sources of voice, worth deciding between:**
- **Web Speech API (`speechSynthesis`)** — no assets, any text, works offline,
  but voice quality varies wildly by platform and you have little control over
  character. Availability inside embedded iframes on itch/Newgrounds is worth
  testing before committing.
- **Pre-recorded audio** — full control over character and delivery, but assets
  to author and inline, and every line is fixed at build time.

**Captions must work regardless of which voice source is used, and must work
with no voice at all.** That's the accessibility floor: a player with sound off
should get the full content.

**Inputs / config:**
```js
KitCaptions.create({
  theme, storage, audio,
  source: 'synthesis',        // or 'audio'
  voice: { rate: 1.0, pitch: 0.9 },
  position: 'bottom',
  duration: 'auto'
});
kitCaptions.say('dan_intro', "Salvage crew, we've got incoming.");
```

**Customizable:** caption position, font size, background opacity, display
duration, voice parameters, whether captions show for SFX as well as speech.

**Arcade-appropriate features worth considering:**
- **Speech-bubble or terminal-readout caption styling** rather than film-style
  subtitles — fits the in-world-log typography distinction you already use.
- **Character-attributed captions** ("DAN: ...") when multiple voices exist.
- **Captions for significant non-speech audio** — `[ALARM]`, `[HULL BREACH]`.
  This is standard captioning practice and it doubles as arcade flavor.
- **A caption log / transcript** accessible from the pause menu, so a player who
  missed a line during play can read it.
- **Speed and size options** wired into `kit-options`.

---

## Part 3 — Suggested build order

```
kit-storage  ──┬──> kit-profile ──┬──> kit-scores  (in progress)
               │                  ├──> kit-leaderboard  (DONE)
               │                  └──> kit-achievements
               ├──> kit-options ──────> kit-audio ──> kit-captions
               └──> kit-menu  (integrates all of the above)
```

**Recommended order:**

1. **`kit-storage`** — small, unblocks everything, and retrofitting it later is
   painful.
2. **`kit-profile`** — mostly extraction of work already proven in Orbital
   Overhaul. Good second extraction because the risk is low and the payoff is
   immediate.
3. **`kit-scores`** — already underway.
4. **`kit-options`** — self-contained, high value, and its schema pattern is
   worth validating before `kit-achievements` reuses the same idea.
5. **`kit-menu`** — build after the screens it hosts exist, so its navigation
   model is designed against real screens rather than hypothetical ones.
6. **`kit-achievements`** — larger; the counter/tier logic is real design work.
7. **`kit-audio`** — deserves its own design conversation. Most technically
   open-ended.
8. **`kit-captions`** — depends on audio for ducking and voice.

**A note on sequencing `kit-menu`:** there's a real argument for building it
earlier, since it's the most visible payoff and the thing you'd most want in a
new game on day one. The counterargument is that a menu system designed before
its screens exist tends to need reworking once real screens arrive. If you'd
rather have the visible win sooner, building a minimal `kit-menu` early and
extending it as screens land is a reasonable middle path.

---

## Part 4 — Open questions

Worth answering before or during the next module's design conversation:

1. **DOM or canvas for UI?** (1.1) Blocks every visual module.
2. **What's already in Orbital Overhaul?** Its menu, options, and high score
   screens exist. Which of them are good enough to extract as the kit's starting
   point, and which should be rebuilt? Extraction beat rewriting for
   `kit-leaderboard`'s client module; it may or may not here.
3. **Three-letter initials or longer names?** Affects `kit-profile`,
   `kit-scores`, and how leaderboard entries look.
4. **Does difficulty affect leaderboard eligibility?** If difficulty becomes
   player-adjustable, EASY and HARD runs on one board is a fairness question.
5. **Procedural or authored music?** Shapes `kit-audio` entirely.
6. **How much does the kit assume about the game loop?** `kit-menu` in particular
   needs to know when the game is running, paused, or idle. A minimal
   game-state contract every game implements would keep that clean.
