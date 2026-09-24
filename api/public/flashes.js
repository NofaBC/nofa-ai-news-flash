const { getFirestore, isConfigured } = require('../../lib/firebaseAdmin');
const {
  computePublicFeedPayload,
  CACHE_COLLECTION,
  PUBLIC_FEED_DOC_ID,
  isCacheFresh,
} = require('../../lib/cache');

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

  // Browsers still re-fetch every 60s (no visible behavior change), but
  // Vercel's edge collapses concurrent requests from multiple visitors
  // within this window into a single backend/Firestore hit.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=40');

  const requestedLimit = Number(req.query && req.query.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 50;

  try {
    const cacheSnap = await db.collection(CACHE_COLLECTION).doc(PUBLIC_FEED_DOC_ID).get();
    const cacheData = cacheSnap.exists ? cacheSnap.data() : null;

    // publicFeed has no time-based staleness check: it's only recomputed
    // when the underlying approved content actually changes (a new flash
    // or an admin moderation action), so "old but unchanged" is the
    // normal, correct state - only existence/schema are validated here.
    if (isCacheFresh(cacheData, null) && Array.isArray(cacheData.items)) {
      res.status(200).json({ configured: true, items: cacheData.items.slice(0, limit) });
      return;
    }

    // Cache missing/schema-mismatched (e.g. right after this deploy):
    // fall back to a live computation. Self-heals on the next flash-
    // creating cron tick or admin moderation action.
    const payload = await computePublicFeedPayload(db, limit);
    res.status(200).json({ configured: true, ...payload });
  } catch (err) {
    res.status(200).json({ configured: true, items: [], error: String((err && err.message) || err) });
  }
};
