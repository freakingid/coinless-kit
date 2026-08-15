export const GAMES = {
  'orbital-overhaul': {
    displayName:   'Orbital Overhaul',
    sortDirection: 'desc',          // 'desc' = higher is better; 'asc' for time-based games
    metricLabel:   'Score',

    // --- bounds (spec §4) ---
    maxMetricPerSecond: 550,        // measured best rate x4; catches absurdity only
    maxMetric:          10_000_000, // typo-level ceiling
    minDurationS:       5,
    maxDurationS:       86_400,

    // Display-only stats keys. Unknown keys are stored as-sent but flag the row,
    // purely so client/server version drift is visible rather than silent.
    statsFields: [
      'wave_reached',
      'canisters_delivered',
      'hunter_kills',
      'saucer_kills',
      'debris_destroyed'
    ]
  }
};
