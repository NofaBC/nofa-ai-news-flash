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

  try {
    const result = await ingestNews(db);
    res.status(200).json({ ok: true, ranAt: new Date().toISOString(), ...result });
  } catch (err) {
    res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
