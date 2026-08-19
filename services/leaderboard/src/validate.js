// Name validation, profanity filter, UUID check, and the bounds check
// (the whole anti-cheat story — see docs/kit-leaderboard-worker-spec.md §4-6).

// Display-name rules live in kit-names and are imported, not reimplemented —
// see docs/kit-names.md §1.2. There is deliberately no inline fallback copy:
// if this import breaks, the deploy should fail loudly rather than silently
// serve stale rules. wrangler deploy's esbuild bundling resolves this.
export { validateName } from '../../../modules/kit-names/kit-names.js';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LEET_MAP = {
  '4': 'A', '3': 'E', '1': 'I', '0': 'O', '5': 'S', '7': 'T', '8': 'B',
  '@': 'A', '$': 'S'
};

// Short and obvious on purpose — a decency filter, not content moderation.
const PROFANITY_WORDLIST = [
  'FUCK', 'SHIT', 'BITCH', 'CUNT', 'ASSHOLE', 'NIGGER', 'NIGGA',
  'FAGGOT', 'RETARD', 'WHORE', 'RAPE', 'DICK', 'PUSSY', 'COCK'
];

// Expects an already-normalized (uppercase) name. Server-side only —
// keeping the wordlist out of shipped game source is the point.
export function isProfane(normalizedName) {
  let s = normalizedName
    .split('')
    .map((ch) => LEET_MAP[ch] || ch)
    .join('');

  s = s.replace(/(.)\1+/g, '$1');
  s = s.replace(/[^A-Z0-9]/g, '');

  return PROFANITY_WORDLIST.some((word) => s.includes(word));
}

export function isUuidV4(value) {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

// Multiple reasons join with ';'. Nothing here rejects a submission —
// it only flags, per spec principle #3.
export function checkBounds(gameConfig, { metric, durationS }) {
  const reasons = [];

  if (durationS < gameConfig.minDurationS) reasons.push('duration_too_short');
  if (durationS > gameConfig.maxDurationS) reasons.push('duration_too_long');
  if (metric < 0 || metric > gameConfig.maxMetric) reasons.push('metric_out_of_range');
  if (metric > gameConfig.maxMetricPerSecond * durationS) reasons.push('rate_implausible');

  return { flagged: reasons.length > 0, reason: reasons.length ? reasons.join(';') : null };
}

export function checkUnknownStatsKeys(gameConfig, stats) {
  const known = new Set(gameConfig.statsFields);
  const unknown = Object.keys(stats).filter((k) => !known.has(k));
  return { flagged: unknown.length > 0, reason: unknown.length ? 'unknown_stats_keys' : null };
}
