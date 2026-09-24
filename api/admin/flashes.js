const { getFirestore, isConfigured } = require('../../lib/firebaseAdmin');
const { isAuthenticated } = require('../../lib/adminAuth');
const { recomputeDashboardCache, recomputePublicFeedCache } = require('../../lib/cache');

const ALLOWED_FIELDS = [
  'approved',
  'active',
  'pinned',
  'headline',
  'summary',
  'developerImpact',
  'recommendedAction',
];

// Default page size for the moderation list. The admin UI has no explicit
// pagination controls, but supports a manual ?limit= override (capped at
// MAX_LIMIT) if a larger fetch is ever needed - this just avoids loading
// hundreds of records by default on every page load.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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
      const requestedLimit = Number(req.query && req.query.limit);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, MAX_LIMIT) : DEFAULT_LIMIT;

      const [flashesSnap, newsSnap] = await Promise.all([
        db.collection('flashes').orderBy('publishedAt', 'desc').limit(limit).get(),
        db.collection('news').orderBy('publishedAt', 'desc').limit(limit).get(),
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
      // Keep the public caches in sync immediately so moderation actions
      // (approve/hide/pin/edit) show up on the next 60s poll instead of
      // waiting for the next provider/news cron tick.
      await recomputeDashboardCache(db);
      await recomputePublicFeedCache(db);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[admin:flashes] PATCH failed:', String((err && err.message) || err));
      res.status(200).json({ ok: false, error: String((err && err.message) || err) });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
