const { getFirestore, isConfigured } = require('../../lib/firebaseAdmin');
const { isAuthenticated } = require('../../lib/adminAuth');

const ALLOWED_FIELDS = [
  'approved',
  'active',
  'pinned',
  'headline',
  'summary',
  'developerImpact',
  'recommendedAction',
];

module.exports = async (req, res) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!isConfigured()) {
    res.status(200).json({ configured: false, items: [] });
    return;
  }

  const db = getFirestore();
  if (!db) {
    res.status(200).json({ configured: true, items: [], error: 'Firestore initialization failed' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const [flashesSnap, newsSnap] = await Promise.all([
        db.collection('flashes').orderBy('publishedAt', 'desc').limit(200).get(),
        db.collection('news').orderBy('publishedAt', 'desc').limit(200).get(),
      ]);

      const items = [
        ...flashesSnap.docs.map((d) => ({ id: d.id, collection: 'flashes', ...d.data() })),
        ...newsSnap.docs.map((d) => ({ id: d.id, collection: 'news', ...d.data() })),
      ].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

      res.status(200).json({ configured: true, items });
    } catch (err) {
      // Never let a Firestore error (e.g. RESOURCE_EXHAUSTED) crash this
      // function - always return clean JSON so admin.html can show a
      // real error instead of silently rendering nothing.
      console.error('[admin:flashes] GET failed:', String((err && err.message) || err));
      res.status(200).json({ configured: true, items: [], error: String((err && err.message) || err) });
    }
    return;
  }

  if (req.method === 'PATCH') {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (err) {
        body = {};
      }
    }

    const { collection, id, updates } = body || {};
    if (!['flashes', 'news'].includes(collection) || !id || !updates || typeof updates !== 'object') {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const safeUpdates = {};
    Object.keys(updates).forEach((key) => {
      if (ALLOWED_FIELDS.includes(key)) safeUpdates[key] = updates[key];
    });

    if (!Object.keys(safeUpdates).length) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    try {
      await db.collection(collection).doc(id).set(safeUpdates, { merge: true });
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[admin:flashes] PATCH failed:', String((err && err.message) || err));
      res.status(200).json({ ok: false, error: String((err && err.message) || err) });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
