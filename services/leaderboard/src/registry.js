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

    maxMetricPerSecond: 150_000, // F1: a strong Start Depth 81 run hit 100,078/s
    maxMetric:          10_000_000,
    minDurationS:       5,
    maxDurationS:       86_400,

    statsFields: [
      'level_reached', 'mode', 'start_depth', 'wells_cleared',
      'purges_spent', 'max_combo', 'deaths'
    ]
  },
  'vector-vortex-overdrive': {
    displayName:   'Vector Vortex Overdrive',
    sortDirection: 'desc',
    metricLabel:   'Score',

    maxMetricPerSecond: 150_000, // O4's measured worst 103,111/s × ~1.5
    maxMetric:          10_000_000,
    minDurationS:       5,
    maxDurationS:       86_400,

    statsFields: [
      'level_reached', 'mode', 'start_depth', 'wells_cleared',
      'purges_spent', 'max_combo', 'deaths'
    ]
  }
};
