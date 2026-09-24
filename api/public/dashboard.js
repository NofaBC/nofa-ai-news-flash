const PROVIDERS = require('../../lib/providers.config');
const { getFirestore, isConfigured, getInitError } = require('../../lib/firebaseAdmin');
const {
  computeDashboardPayload,
  CACHE_COLLECTION,
  DASHBOARD_DOC_ID,
  DASHBOARD_MAX_AGE_MS,
  isCacheFresh,
} = require('../../lib/cache');

module.exports = async (req, res) => {
  if (!isConfigured()) {
    res.status(200).json({
      configured: false,
      providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, note: p.note, status: 'unknown', stale: true })),
      providerCount: PROVIDERS.length,
      reportCount: 0,
      lastUpdate: null,
      ticker: 'Live data pending backend setup - connect Firestore to begin monitoring.',
    });
    return;
  }

  const db = getFirestore();
  if (!db) {
    res.status(200).json({
      configured: true,
      error: `Firestore initialization failed: ${getInitError() || 'unknown error - check FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY'}`,
      providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, note: p.note, status: 'unknown', stale: true })),
      providerCount: PROVIDERS.length,
      reportCount: 0,
      lastUpdate: null,
      ticker: 'Firestore connection failed - check server configuration.',
    });
    return;
  }

  // Browsers still re-fetch every 60s (no visible behavior change), but
  // Vercel's edge collapses concurrent requests from multiple visitors
  // within this window into a single backend/Firestore hit.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=40');

  try {
    const cacheSnap = await db.collection(CACHE_COLLECTION).doc(DASHBOARD_DOC_ID).get();
    const cacheData = cacheSnap.exists ? cacheSnap.data() : null;

    if (isCacheFresh(cacheData, DASHBOARD_MAX_AGE_MS)) {
      res.status(200).json({
        configured: true,
        providers: cacheData.providers,
        providerCount: cacheData.providerCount,
        reportCount: cacheData.reportCount,
        lastUpdate: cacheData.lastUpdate,
        ticker: cacheData.ticker,
      });
      return;
    }

    // Cache missing/stale/schema-mismatched (e.g. right after this
    // deploy, before the first cron tick): fall back to a live
    // computation so the public site never shows blank/broken data. The
    // cache self-heals on the next check-providers cron tick (<=5 min)
    // or the next admin moderation action.
    const payload = await computeDashboardPayload(db);
    res.status(200).json({ configured: true, ...payload });
  } catch (err) {
    res.status(200).json({
      configured: true,
      error: String((err && err.message) || err),
      providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, note: p.note, status: 'unknown', stale: true })),
      providerCount: PROVIDERS.length,
      reportCount: 0,
      lastUpdate: null,
      ticker: 'Temporarily unable to load live status - retrying shortly.',
    });
  }
};
