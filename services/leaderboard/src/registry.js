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
  },
  'vector-vortex': {
    displayName:   'Vector Vortex',
    sortDirection: 'desc',
    metricLabel:   'Score',

    maxMetricPerSecond: 1200,
    maxMetric:          10_000_000,
    minDurationS:       5,
    maxDurationS:       86_400,

    statsFields: [
      'level_reached',
      'mode',
      'start_depth',
      'wells_cleared',
      'purges_spent',
      'max_combo',
      'deaths'
    ]
  }
};
