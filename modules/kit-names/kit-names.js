// kit-names — client module. Plain ES module, no build step, no dependencies.
// Contract: docs/kit-names.md. Pure functions and constants — no storage, no
// DOM, no network. Shared display-name rules for kit-profile and
// kit-leaderboard.

const ALLOWED_CHARS_RE = /^[A-Za-z0-9 _-]*$/;

export const MAX_NAME_LENGTH = 12;

export const NAME_CHANGE_NOTICE =
  "Scores you've already posted will keep the name you used at the time.\n" +
  'Only new scores will show your new name.';

export function validateName(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'empty', normalized: null };
  }

  const collapsed = raw.trim().replace(/\s+/g, ' ');

  // Charset check runs BEFORE uppercasing — see docs/kit-names.md §2.1.
  // Uppercasing can introduce characters that pass this check ('ß' -> 'SS',
  // 'ﬁ' -> 'FI'); checking the pre-uppercase string closes that hole.
  if (!ALLOWED_CHARS_RE.test(collapsed)) {
    return { ok: false, reason: 'illegal_character', normalized: null };
  }

  const upper = collapsed.toUpperCase();

  if (upper.length === 0) {
    return { ok: false, reason: 'empty', normalized: null };
  }

  if (upper.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: 'too_long', normalized: null };
  }

  return { ok: true, reason: null, normalized: upper };
}
