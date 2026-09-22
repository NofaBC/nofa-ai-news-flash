const PROVIDERS = require('../../lib/providers.config');
const { getFirestore, isConfigured } = require('../../lib/firebaseAdmin');

function iconForType(type) {
  if (type === 'recovery') return '\uD83D\uDFE2'; // green circle
  if (type === 'outage') return '\uD83D\uDD34'; // red circle
  if (type === 'degraded') return '\uD83D\uDFE0'; // orange circle
  return '\uD83D\uDD35'; // blue circle
}

// Builds the ticker string using the spec's priority order: major outage >
// severe degradation > recovery > API/model/platform change > major AI
// news. Falls back to news, then a static "all healthy" message, so the
// ticker is never empty.
function buildTicker(flashes, news) {
  const live = flashes.filter((f) => f.active && !f.historical);
  const outages = live.filter((f) => f.type === 'outage');
  const degraded = live.filter((f) => f.type === 'degraded');
  const recoveries = live.filter((f) => f.type === 'recovery');
  const updates = live.filter((f) => f.type === 'update');

  const ordered = [...outages, ...degraded, ...recoveries, ...updates];
  const parts = ordered.slice(0, 4).map((f) => `${iconForType(f.type)} ${f.provider}: ${f.headline}`);

  if (!parts.length) {
    news.slice(0, 4).forEach((n) => parts.push(`${iconForType('news')} ${n.provider || 'AI News'}: ${n.headline}`));
  }

  if (!parts.length) {
    parts.push(`${iconForType('recovery')} All monitored AI providers operational`);
  }

  return parts.join('   \u2022   ');
}

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
      error: 'Firestore initialization failed - check FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY',
      providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, note: p.note, status: 'unknown', stale: true })),
      providerCount: PROVIDERS.length,
      reportCount: 0,
      lastUpdate: null,
      ticker: 'Firestore connection failed - check server configuration.',
    });
    return;
  }

  try {
    const providerSnaps = await db.collection('providers').get();
    const providerMap = {};
    providerSnaps.forEach((doc) => {
      providerMap[doc.id] = doc.data();
    });

    const providers = PROVIDERS.map((p) => {
      const d = providerMap[p.id];
      return {
        id: p.id,
        name: p.name,
        note: p.note,
        status: d ? d.status : 'unknown',
        affectedServices: d ? d.affectedServices || [] : [],
        stale: d ? Boolean(d.stale) : true,
        lastChecked: d ? d.lastChecked : null,
        sourceUrl: d ? d.sourceUrl : p.sourceUrl,
      };
    });

    const [flashesSnap, newsSnap] = await Promise.all([
      db
        .collection('flashes')
        .where('historical', '==', false)
        .where('approved', '==', true)
        .orderBy('publishedAt', 'desc')
        .limit(30)
        .get(),
      db.collection('news').where('approved', '==', true).orderBy('publishedAt', 'desc').limit(10).get(),
    ]);

    const flashes = flashesSnap.docs.map((d) => d.data());
    const news = newsSnap.docs.map((d) => d.data());

    const activeCount = flashes.filter((f) => f.active).length + news.filter((n) => n.active).length;

    const lastUpdateCandidates = providers.map((p) => p.lastChecked).filter(Boolean).sort();
    const lastUpdate = lastUpdateCandidates.length ? lastUpdateCandidates[lastUpdateCandidates.length - 1] : null;

    res.status(200).json({
      configured: true,
      providers,
      providerCount: PROVIDERS.length,
      reportCount: activeCount,
      lastUpdate,
      ticker: buildTicker(flashes, news),
    });
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
