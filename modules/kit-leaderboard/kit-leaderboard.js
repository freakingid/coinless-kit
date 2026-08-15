// kit-leaderboard — client module. Plain ES module, no build step, no dependencies.
// Contract: docs/kit-leaderboard-client-api.md. Talks to the Worker in
// services/leaderboard/. Never touches the DOM, never renders anything.

const NAME_CHARS_RE = /^[A-Z0-9 \-_]*$/;

const RETRY_DELAYS_MS = [2000, 8000, 30000];
const QUEUE_CAP = 20;
const QUEUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Codes that will never succeed on retry with the same payload — never queued.
const PERMANENT_REJECT_CODES = new Set([
  'INVALID_NAME',
  'NAME_REJECTED',
  'INVALID_PAYLOAD',
  'INVALID_GAME',
  'ORIGIN_NOT_ALLOWED',
  'TURNSTILE_FAILED'
]);

export const NAME_CHANGE_NOTICE =
  "Scores you've already posted will keep the name you used at the time.\n" +
  'Only new scores will show your new name.';

export function validateName(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'invalid_type', normalized: null };
  }

  const collapsed = raw.trim().replace(/\s+/g, ' ');
  const upper = collapsed.toUpperCase();

  if (!NAME_CHARS_RE.test(upper)) {
    return { ok: false, reason: 'illegal_character', normalized: null };
  }

  if (upper.length < 1 || upper.length > 12) {
    return { ok: false, reason: 'invalid_length', normalized: null };
  }

  return { ok: true, reason: null, normalized: upper };
}

function detectLocalStorage() {
  try {
    const probeKey = '__kit_leaderboard_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

class SubmitQueue {
  constructor(storageKey, emit) {
    this.storageKey = storageKey;
    this.emit = emit;
    this.available = detectLocalStorage();
    this.entries = this.available ? this._load() : [];
    this.failureStreak = 0;
    this.timerId = null;
    this.flushing = false;
    this.sendFn = null;
  }

  setSender(sendFn) {
    this.sendFn = sendFn;
  }

  length() {
    return this.entries.length;
  }

  _load() {
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      const cutoff = Date.now() - QUEUE_MAX_AGE_MS;
      const fresh = parsed.filter((e) => e && typeof e.queuedAt === 'number' && e.queuedAt >= cutoff);
      if (fresh.length !== parsed.length) this._persist(fresh);
      return fresh;
    } catch {
      return [];
    }
  }

  _persist(entries) {
    if (!this.available) return;
    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(entries));
    } catch {
      this.available = false;
    }
  }

  push(payload, metric) {
    if (!this.available) return;

    this.entries.push({ payload, metric, queuedAt: Date.now() });

    if (this.entries.length > QUEUE_CAP) {
      let minIndex = 0;
      for (let i = 1; i < this.entries.length; i++) {
        if (this.entries[i].metric < this.entries[minIndex].metric) minIndex = i;
      }
      this.entries.splice(minIndex, 1);
    }

    this._persist(this.entries);
    this._scheduleRetry();
  }

  async flush() {
    if (this.flushing || !this.sendFn) return { sent: 0, failed: 0, dropped: 0 };
    if (this.entries.length === 0) return { sent: 0, failed: 0, dropped: 0 };

    this.flushing = true;
    this._clearTimer();

    let sent = 0;
    let failed = 0;
    let dropped = 0;
    const remaining = [];

    for (const entry of this.entries) {
      const result = await this.sendFn(entry.payload);
      if (result.status === 'submitted') {
        sent++;
      } else if (result.status === 'rejected') {
        dropped++;
      } else {
        remaining.push(entry);
        failed++;
      }
    }

    this.entries = remaining;
    this._persist(this.entries);
    this.flushing = false;

    if (failed > 0) {
      this.failureStreak++;
      this._scheduleRetry();
    } else {
      this.failureStreak = 0;
    }

    this.emit('flushed', { sent, failed, dropped });
    return { sent, failed, dropped };
  }

  // 2s / 8s / 30s, then no further automatic timer this session — later
  // delivery relies on the online event, a subsequent successful submit,
  // or a manual flushQueue() call.
  _scheduleRetry() {
    if (this.timerId) return;
    if (this.entries.length === 0) return;
    if (this.failureStreak >= RETRY_DELAYS_MS.length) return;

    const delay = RETRY_DELAYS_MS[this.failureStreak];
    this.timerId = setTimeout(() => {
      this.timerId = null;
      this.flush();
    }, delay);
  }

  _clearTimer() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}

export function create(config) {
  const {
    endpoint,
    gameId,
    gameVersion,
    getPlayer,
    storageKey,
    timeoutMs = 8000,
    turnstileToken = null,
    onEvent = () => {}
  } = config;

  const resolvedStorageKey = storageKey || `coinless.lb.${gameId}.v1`;

  function emit(name, detail) {
    try {
      onEvent(name, detail);
    } catch {
      // the game's handler misbehaving must not break the module
    }
  }

  let currentRunId = null;

  async function rawFetch(path, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${endpoint}${path}`, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function resolveTurnstileToken() {
    return typeof turnstileToken === 'function' ? turnstileToken() : turnstileToken;
  }

  async function sendSubmit(payload) {
    let response;
    try {
      response = await rawFetch('/v1/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, turnstile_token: resolveTurnstileToken() })
      });
    } catch (err) {
      const reason = err && err.name === 'AbortError' ? 'timeout' : 'offline';
      return { status: 'queued', reason };
    }

    let body;
    try {
      body = await response.json();
    } catch {
      return { status: 'queued', reason: 'server_error' };
    }

    if (response.ok) {
      return {
        status: 'submitted',
        publicId: body.public_id,
        flagged: body.flagged,
        duplicate: body.duplicate,
        rank: { allTime: body.rank.all_time, h24: body.rank['24h'] }
      };
    }

    const code = body && body.error && body.error.code;
    const message = body && body.error && body.error.message;

    if (PERMANENT_REJECT_CODES.has(code)) {
      return { status: 'rejected', code, message };
    }
    if (code === 'RATE_LIMITED') {
      return { status: 'queued', reason: 'rate_limited' };
    }
    return { status: 'queued', reason: 'server_error' };
  }

  const queue = new SubmitQueue(resolvedStorageKey, emit);
  queue.setSender(sendSubmit);
  queue.flush();

  window.addEventListener('online', () => queue.flush());

  function beginRun() {
    currentRunId = crypto.randomUUID();
    return currentRunId;
  }

  async function submit(result) {
    const player = getPlayer();
    const payload = {
      game_id: gameId,
      game_version: gameVersion,
      run_id: currentRunId,
      player_id: player.playerId,
      display_name: player.displayName,
      metric: result.metric,
      duration_s: result.durationS,
      outcome: result.outcome,
      stats: result.stats || {}
    };

    const outcome = await sendSubmit(payload);

    if (outcome.status === 'submitted') {
      emit('submitted', outcome);
      queue.flush();
    } else if (outcome.status === 'queued') {
      queue.push(payload, result.metric);
      emit('queued', { reason: outcome.reason });
    } else {
      emit('rejected', outcome);
    }

    return outcome;
  }

  async function fetchBoard({ window: windowParam = 'all', limit = 25 } = {}) {
    const clampedLimit = Math.min(Math.max(1, limit || 25), 100);
    const params = new URLSearchParams({ game: gameId, window: windowParam, limit: String(clampedLimit) });

    let response;
    try {
      response = await rawFetch(`/v1/scores?${params.toString()}`, { method: 'GET' });
    } catch (err) {
      emit('error', { source: 'fetchBoard', error: err });
      throw err;
    }

    if (!response.ok) {
      const err = new Error(`fetchBoard failed with status ${response.status}`);
      emit('error', { source: 'fetchBoard', error: err });
      throw err;
    }

    const body = await response.json();
    const board = {
      gameId: body.game_id,
      window: body.window,
      metricLabel: body.metric_label,
      generatedAt: body.generated_at,
      entries: body.entries.map((e) => ({
        rank: e.rank,
        publicId: e.public_id,
        displayName: e.display_name,
        metric: e.metric,
        durationS: e.duration_s,
        outcome: e.outcome,
        stats: e.stats,
        submittedAt: e.submitted_at,
        flagged: e.flagged
      }))
    };

    emit('board_loaded', board);
    return board;
  }

  function queueLength() {
    return queue.length();
  }

  function flushQueue() {
    return queue.flush();
  }

  return { beginRun, submit, fetchBoard, queueLength, flushQueue };
}
