const { getFirestore, isConfigured } = require('../../lib/firebaseAdmin');

module.exports = async (req, res) => {
  if (!isConfigured()) {
    res.status(200).json({ configured: false, items: [] });
    return;
  }

  const db = getFirestore();
  if (!db) {
    res.status(200).json({ configured: true, items: [], error: 'Firestore initialization failed' });
    return;
  }

  const requestedLimit = Number(req.query && req.query.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 50;

  try {
    const [flashesSnap, newsSnap] = await Promise.all([
      db.collection('flashes').where('approved', '==', true).orderBy('publishedAt', 'desc').limit(limit).get(),
      db.collection('news').where('approved', '==', true).orderBy('publishedAt', 'desc').limit(limit).get(),
    ]);

    const flashItems = flashesSnap.docs.map((d) => ({ id: d.id, kind: 'flash', ...d.data() }));
    const newsItems = newsSnap.docs.map((d) => ({ id: d.id, ...d.data(), kind: 'news', type: 'update' }));

    const items = [...flashItems, ...newsItems]
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, limit);

    res.status(200).json({ configured: true, items });
  } catch (err) {
    res.status(200).json({ configured: true, items: [], error: String((err && err.message) || err) });
  }
};
