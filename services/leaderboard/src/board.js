import { GAMES } from './registry.js';
import { json, errorJson } from './index.js';

const WINDOW_SECONDS = {
  '4h': 4 * 3600,
  '8h': 8 * 3600,
  '12h': 12 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 86400,
  '30d': 30 * 86400,
  year: 365 * 86400,
  all: null
};

function clampLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 25;
  return Math.min(n, 100);
}

export async function handleBoard(request, env, corsHeaders) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get('game');
  const gameConfig = GAMES[gameId];
  if (!gameConfig) {
    return errorJson(400, 'INVALID_GAME', 'Unknown or missing game', corsHeaders);
  }

  const windowParam = url.searchParams.get('window');
  const windowKey = Object.prototype.hasOwnProperty.call(WINDOW_SECONDS, windowParam) ? windowParam : 'all';
  const windowSeconds = WINDOW_SECONDS[windowKey];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = windowSeconds === null ? 0 : nowSeconds - windowSeconds;

  const limit = clampLimit(url.searchParams.get('limit'));

  const metricOrder = gameConfig.sortDirection === 'asc' ? 'ASC' : 'DESC';

  const result = await env.coinless_scores
    .prepare(
      `WITH windowed AS (
         SELECT * FROM scores WHERE game_id = ?1 AND submitted_at > ?2
       ),
       ranked AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY player_id
                  ORDER BY metric ${metricOrder}, submitted_at ASC
                ) AS rn
         FROM windowed
       )
       SELECT public_id, display_name, metric, duration_s, outcome, stats, flagged, submitted_at
       FROM ranked
       WHERE rn = 1
       ORDER BY metric ${metricOrder}, submitted_at ASC
       LIMIT ?3`
    )
    .bind(gameId, cutoff, limit)
    .all();

  if (result.meta) {
    console.log('board read', { gameId, windowKey, rows_read: result.meta.rows_read, rows_written: result.meta.rows_written });
  }

  const entries = result.results.map((row, i) => ({
    rank: i + 1,
    public_id: row.public_id,
    display_name: row.display_name,
    metric: row.metric,
    duration_s: row.duration_s,
    outcome: row.outcome,
    stats: JSON.parse(row.stats),
    submitted_at: row.submitted_at,
    flagged: !!row.flagged
  }));

  return json(
    200,
    {
      game_id: gameId,
      window: windowKey,
      metric_label: gameConfig.metricLabel,
      generated_at: nowSeconds,
      entries
    },
    corsHeaders
  );
}
