import { GAMES } from './registry.js';
import { validateName, isProfane, isUuidV4, checkBounds, checkUnknownStatsKeys } from './validate.js';
import { json, errorJson } from './index.js';

const PUBLIC_ID_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const OUTCOMES = ['died', 'completed', 'quit'];

function generatePublicId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let id = '';
  for (let i = 0; i < 8; i++) id += PUBLIC_ID_ALPHABET[bytes[i] % PUBLIC_ID_ALPHABET.length];
  return id;
}

// Returns an error message string, or null if the shape is valid.
// game_id itself is checked separately (against the registry) before this runs.
function validatePayloadShape(body) {
  if (typeof body.game_version !== 'string' || body.game_version.length === 0) {
    return 'game_version is required';
  }
  if (typeof body.run_id !== 'string') return 'run_id is required';
  if (typeof body.player_id !== 'string') return 'player_id is required';
  if (typeof body.display_name !== 'string') return 'display_name is required';
  if (!Number.isInteger(body.metric)) return 'metric must be an integer';
  if (!Number.isInteger(body.duration_s)) return 'duration_s must be an integer';
  if (!OUTCOMES.includes(body.outcome)) return 'outcome must be one of died, completed, quit';
  if (typeof body.stats !== 'object' || body.stats === null || Array.isArray(body.stats)) {
    return 'stats must be an object';
  }
  return null;
}

async function computeRank(db, gameConfig, gameId, playerId, metric, cutoff) {
  const asc = gameConfig.sortDirection === 'asc';
  const aggFn = asc ? 'MIN' : 'MAX';
  const cmp = asc ? '<' : '>';

  const row = await db
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM (
         SELECT player_id, ${aggFn}(metric) AS best
         FROM scores
         WHERE game_id = ?1 AND submitted_at > ?2 AND player_id != ?3
         GROUP BY player_id
         HAVING best ${cmp} ?4
       )`
    )
    .bind(gameId, cutoff, playerId, metric)
    .first();

  return row.rank;
}

async function rankPair(db, gameConfig, gameId, playerId, metric, nowSeconds) {
  const [allTime, h24] = await Promise.all([
    computeRank(db, gameConfig, gameId, playerId, metric, 0),
    computeRank(db, gameConfig, gameId, playerId, metric, nowSeconds - 24 * 3600)
  ]);
  return { all_time: allTime, '24h': h24 };
}

export async function handleSubmit(request, env, corsHeaders) {
  const clientIp = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

  const raw = await request.text();
  const byteLength = new TextEncoder().encode(raw).length;

  let body = null;
  let parseOk = false;
  if (byteLength <= 8192) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed;
        parseOk = true;
      }
    } catch {
      // parseOk stays false
    }
  }

  // Rate limit needs a key before we know whether the body is even valid.
  const gameIdForKey = parseOk && typeof body.game_id === 'string' ? body.game_id : 'unknown';
  const rl = await env.SUBMIT_LIMITER.limit({ key: `${clientIp}:${gameIdForKey}` });
  if (!rl.success) {
    return errorJson(429, 'RATE_LIMITED', 'Too many submissions, try again shortly', corsHeaders);
  }

  if (!parseOk) {
    return errorJson(400, 'INVALID_PAYLOAD', 'Body must be valid JSON, <= 8KB', corsHeaders);
  }

  const gameConfig = GAMES[body.game_id];
  if (!gameConfig) {
    return errorJson(400, 'INVALID_GAME', 'Unknown game_id', corsHeaders);
  }

  if (env.TURNSTILE_ENABLED === 'true') {
    if (!body.turnstile_token) {
      return errorJson(403, 'TURNSTILE_FAILED', 'Turnstile token required', corsHeaders);
    }
    const verified = await verifyTurnstile(body.turnstile_token, env, clientIp);
    if (!verified) {
      return errorJson(403, 'TURNSTILE_FAILED', 'Turnstile verification failed', corsHeaders);
    }
  }

  const shapeError = validatePayloadShape(body);
  if (shapeError) {
    return errorJson(400, 'INVALID_PAYLOAD', shapeError, corsHeaders);
  }

  if (!isUuidV4(body.run_id) || !isUuidV4(body.player_id)) {
    return errorJson(400, 'INVALID_PAYLOAD', 'run_id and player_id must be UUID v4', corsHeaders);
  }

  const nameResult = validateName(body.display_name);
  if (!nameResult.ok) {
    return errorJson(400, 'INVALID_NAME', 'Name must be 1-12 characters, A-Z 0-9 space - _', corsHeaders);
  }

  if (isProfane(nameResult.normalized)) {
    return errorJson(400, 'NAME_REJECTED', 'That name is not allowed', corsHeaders);
  }

  const metric = body.metric;
  const durationS = body.duration_s;

  const bounds = checkBounds(gameConfig, { metric, durationS });
  const statsCheck = checkUnknownStatsKeys(gameConfig, body.stats);

  const flagged = bounds.flagged || statsCheck.flagged;
  const flagReasons = [bounds.reason, statsCheck.reason].filter(Boolean);
  const flagReason = flagReasons.length ? flagReasons.join(';') : null;

  const publicId = generatePublicId();
  const nowSeconds = Math.floor(Date.now() / 1000);

  try {
    await env.coinless_scores.prepare(
      `INSERT INTO scores
         (run_id, public_id, game_id, player_id, display_name, metric, duration_s,
          outcome, game_version, stats, flagged, flag_reason, submitted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    )
      .bind(
        body.run_id,
        publicId,
        body.game_id,
        body.player_id,
        nameResult.normalized,
        metric,
        durationS,
        body.outcome,
        body.game_version,
        JSON.stringify(body.stats),
        flagged ? 1 : 0,
        flagReason,
        nowSeconds
      )
      .run();
  } catch (err) {
    const message = String(err && err.message);
    if (message.includes('run_id')) {
      const existing = await env.coinless_scores
        .prepare('SELECT public_id, metric, player_id, flagged FROM scores WHERE run_id = ?1')
        .bind(body.run_id)
        .first();
      if (existing) {
        const rank = await rankPair(env.coinless_scores, gameConfig, body.game_id, existing.player_id, existing.metric, nowSeconds);
        return json(
          200,
          { public_id: existing.public_id, flagged: !!existing.flagged, duplicate: true, rank },
          corsHeaders
        );
      }
    }
    console.error('submit insert failed', err);
    return errorJson(500, 'SERVER_ERROR', 'Something went wrong', corsHeaders);
  }

  const rank = await rankPair(env.coinless_scores, gameConfig, body.game_id, body.player_id, metric, nowSeconds);

  return json(200, { public_id: publicId, flagged, duplicate: false, rank }, corsHeaders);
}

async function verifyTurnstile(token, env, clientIp) {
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (clientIp) form.append('remoteip', clientIp);

  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form
  });
  const data = await resp.json();
  return data.success === true;
}
