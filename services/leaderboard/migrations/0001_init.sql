CREATE TABLE scores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT    NOT NULL UNIQUE,   -- client-minted UUID; idempotency key
  public_id     TEXT    NOT NULL UNIQUE,   -- server-minted; safe to expose in share links
  game_id       TEXT    NOT NULL,
  player_id     TEXT    NOT NULL,          -- opaque UUID, one per local profile
  display_name  TEXT    NOT NULL,          -- normalized + filtered, <= 12 chars
  metric        INTEGER NOT NULL,          -- the ranked value
  duration_s    INTEGER NOT NULL,
  outcome       TEXT    NOT NULL CHECK (outcome IN ('died','completed','quit')),
  game_version  TEXT    NOT NULL,
  stats         TEXT    NOT NULL,          -- JSON object; DISPLAY ONLY (see below)
  flagged       INTEGER NOT NULL DEFAULT 0,
  flag_reason   TEXT,                      -- nullable; which bound tripped
  submitted_at  INTEGER NOT NULL           -- SERVER clock, unix seconds
);

-- Board reads: window filter, then group-by-player.
CREATE INDEX idx_scores_board
  ON scores(game_id, submitted_at DESC, metric DESC);

-- All-time board and all-time rank counting.
CREATE INDEX idx_scores_game_metric
  ON scores(game_id, metric DESC);

-- "This player's best in this game" — rank calculation and future profile views.
CREATE INDEX idx_scores_player_best
  ON scores(game_id, player_id, metric DESC);
