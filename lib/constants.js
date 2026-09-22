// Normalized provider operational states. This is the only vocabulary
// providers/{id}.status is ever written with. Note that "recovered" is
// intentionally NOT in this list - a recovery is an event (a flash), not a
// resting provider state. Once a provider recovers its stored status
// settles back to "operational".
const STATUS = {
  OPERATIONAL: 'operational',
  DEGRADED: 'degraded',
  MONITORING: 'monitoring',
  PARTIAL_OUTAGE: 'partial_outage',
  MAJOR_OUTAGE: 'major_outage',
  UNKNOWN: 'unknown',
};

// Flash document "type" values. RECOVERY only ever appears here, never as a
// provider status.
const FLASH_TYPE = {
  OUTAGE: 'outage',
  DEGRADED: 'degraded',
  RECOVERY: 'recovery',
  UPDATE: 'update',
};

const SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

module.exports = { STATUS, FLASH_TYPE, SEVERITY };
