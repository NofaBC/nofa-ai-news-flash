const PROVIDERS = require('../../lib/providers.config');
const { checkProvider } = require('../../lib/statusCheckers');
const { processReading } = require('../../lib/classify');
const { getFirestore, isConfigured } = require('../../lib/firebaseAdmin');

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
  const results = [];

  for (const provider of PROVIDERS) {
    try {
      const reading = await checkProvider(provider);
      const flashes = await processReading(db, provider, reading);
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

  res.status(200).json({ ok: true, checkedAt: new Date().toISOString(), results });
};
