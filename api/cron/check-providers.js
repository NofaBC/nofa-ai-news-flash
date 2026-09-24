const PROVIDERS = require('../../lib/providers.config');
const { checkProvider } = require('../../lib/statusCheckers');
const { processReading } = require('../../lib/classify');
const { getFirestore, isConfigured } = require('../../lib/firebaseAdmin');
const { recomputeDashboardCache, recomputePublicFeedCache } = require('../../lib/cache');

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!isConfigured()) {
    res.status(200).json({ skipped: true, reason: 'Firestore not configured yet' });
    return;
  }

  const db = getFirestore();
  if (!db) {
    res.status(200).json({ ok: false, error: 'Firestore initialization failed' });
    return;
  }

  const results = [];
  let anyFlashCreated = false;

  for (const provider of PROVIDERS) {
    try {
      const reading = await checkProvider(provider);
      const flashes = await processReading(db, provider, reading);
      if (flashes.length) anyFlashCreated = true;
      results.push({
        provider: provider.id,
        status: reading.status,
        stale: Boolean(reading.stale),
        flashesCreated: flashes.length,
      });
    } catch (err) {
      results.push({ provider: provider.id, error: String((err && err.message) || err) });
    }
  }

  // Keep the public dashboard cache fresh every cycle (this is what keeps
  // lastChecked accurate on the public site). Only recompute the heavier
  // public feed cache when this run actually created a new flash (rare -
  // only during real incidents/recoveries) to avoid wasted reads on
  // routine "nothing changed" ticks.
  await recomputeDashboardCache(db);
  if (anyFlashCreated) {
    await recomputePublicFeedCache(db);
  }

  res.status(200).json({ ok: true, checkedAt: new Date().toISOString(), results });
};
