const PROVIDERS = require('./providers.config');
const { STATUS } = require('./constants');

// Never recommends a fallback provider blindly - only ever names providers
// whose CURRENTLY STORED Firestore status is operational and not stale.
async function recommendFallback(db, downProviderId, { soft = false } = {}) {
  if (!db) {
    return 'Monitor the situation; no live fallback data is available yet.';
  }

  const candidates = PROVIDERS.filter(
    (p) => p.id !== downProviderId && p.statusPageType !== 'none'
  );

  const snapshots = await Promise.all(
    candidates.map((p) => db.collection('providers').doc(p.id).get())
  );

  const healthy = [];
  snapshots.forEach((snap, i) => {
    if (!snap.exists) return;
    const data = snap.data();
    if (data.status === STATUS.OPERATIONAL && !data.stale) {
      healthy.push(candidates[i].name);
    }
  });

  if (!healthy.length) {
    return 'No verified healthy fallback provider at this time; monitor and retry.';
  }

  const verb = soft ? 'Consider routing new requests to' : 'Route compatible requests to';
  return `${verb} ${healthy.join(' or ')} until recovery, after verifying compatibility with your use case.`;
}

module.exports = { recommendFallback };
