const { ingestNews } = require('../../lib/newsIngest');
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
  if (!db) {
    res.status(200).json({ ok: false, error: 'Firestore initialization failed' });
    return;
  }

  try {
    const result = await ingestNews(db);
    // Safe to log: contains only counts/source name, never key material.
    console.log('[cron:ingest-news]', JSON.stringify(result));
    res.status(200).json({ ok: true, ranAt: new Date().toISOString(), ...result });
  } catch (err) {
    console.error('[cron:ingest-news] failed:', String((err && err.message) || err));
    res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
