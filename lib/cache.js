const PROVIDERS = require('./providers.config');

// Bump this whenever the shape of a cache document changes. Public routes
// treat a mismatched (or missing) schemaVersion as "no usable cache" and
// fall back to a live computation, so old/rolled-back deployments can never
// misinterpret a newer cache shape (or vice versa).
const SCHEMA_VERSION = 1;

const CACHE_COLLECTION = 'cache';
const DASHBOARD_DOC_ID = 'dashboard';
const PUBLIC_FEED_DOC_ID = 'publicFeed';

// cache/dashboard is recomputed on every check-providers cron tick (every
// 5 minutes), so anything older than a few cycles means the recompute step
// itself is failing (the underlying provider data may still be fine) -
// treat it as stale and fall back to a live read rather than serve
// indefinitely-old data.
const DASHBOARD_MAX_AGE_MS = 15 * 60 * 1000; // 3x the 5-minute cadence

// cache/publicFeed is only recomputed when approved public content
// actually changes (a new flash, or an admin moderation action). "Old but
// unchanged" is the normal, correct state - there is deliberately no
// time-based staleness check for it, only existence/schema validation.
const MAX_FEED_ITEMS = 100;

// Safety margin under Firestore's 1 MiB document limit. Only ever kicks in
// if item text fields are pathologically long across many items at once;
// under normal conditions the feed cache is well under this.
const MAX_CACHE_DOC_BYTES = 900 * 1024;

function iconForType(type) {
  if (type === 'recovery') return '\uD83D\uDFE2'; // green circle
  if (type === 'outage') return '\uD83D\uDD34'; // red circle
  if (type === 'degraded') return '\uD83D\uDFE0'; // orange circle
  if (type === 'unknown') return '\u26AA'; // white circle - status unavailable, NOT a health signal
  return '\uD83D\uDD35'; // blue circle
}

// Builds the ticker string using the spec's priority order: major outage >
// severe degradation > recovery > API/model/platform change > major AI
// news. Falls back to news, then a provider-health summary, so the ticker
// is never empty. The fallback NEVER claims "all operational" unless every
// monitored provider is actually verified operational (not stale/unknown).
function buildTicker(flashes, news, providers) {
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
    const operational = providers.filter((p) => p.status === 'operational' && !p.stale);
    const unavailable = providers.filter((p) => p.status === 'unknown' || p.stale);

    if (!unavailable.length) {
      parts.push(`${iconForType('recovery')} All monitored AI providers operational`);
    } else {
      if (operational.length) {
        parts.push(`${iconForType('recovery')} ${operational.map((p) => p.name).join(', ')} verified operational`);
      }
      parts.push(`${iconForType('unknown')} ${unavailable.map((p) => p.name).join(', ')} status unavailable`);
    }
  }

  return parts.join('   \u2022   ');
}

// Computes the exact payload /api/public/dashboard returns, live from
// Firestore (providers + flashes + news queries). Used both by the cache
// recompute (cron/admin-triggered) and by the public route's fallback when
// the cache is missing/stale - kept as one function so both paths can
// never drift apart in behavior.
async function computeDashboardPayload(db) {
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

  return {
    providers,
    providerCount: PROVIDERS.length,
    reportCount: activeCount,
    lastUpdate,
    ticker: buildTicker(flashes, news, providers),
  };
}

// Computes the exact payload /api/public/flashes returns, live from
// Firestore. Shared by the cache recompute (always fetches MAX_FEED_ITEMS)
// and the public route's fallback (fetches exactly the requested limit).
async function computePublicFeedPayload(db, limit) {
  const [flashesSnap, newsSnap] = await Promise.all([
    db.collection('flashes').where('approved', '==', true).orderBy('publishedAt', 'desc').limit(limit).get(),
    db.collection('news').where('approved', '==', true).orderBy('publishedAt', 'desc').limit(limit).get(),
  ]);

  const flashItems = flashesSnap.docs.map((d) => ({ id: d.id, kind: 'flash', ...d.data() }));
  const newsItems = newsSnap.docs.map((d) => ({ id: d.id, ...d.data(), kind: 'news', type: 'update' }));

  const items = [...flashItems, ...newsItems]
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, limit);

  return { items };
}

function trimToByteBudget(items, maxBytes) {
  let trimmed = items;
  while (trimmed.length > 1 && Buffer.byteLength(JSON.stringify(trimmed)) > maxBytes) {
    // Items are sorted newest-first; drop from the end (oldest) first.
    trimmed = trimmed.slice(0, trimmed.length - 1);
  }
  return trimmed;
}

// Recomputes and writes cache/dashboard. Never throws - failures are
// logged and swallowed so a cache-write hiccup can never fail the parent
// cron run or admin request; the public route's live-query fallback and
// the next successful recompute both self-heal it.
async function recomputeDashboardCache(db) {
  const startedAt = Date.now();
  try {
    const payload = await computeDashboardPayload(db);
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      ...payload,
    };
    await db.collection(CACHE_COLLECTION).doc(DASHBOARD_DOC_ID).set(doc);
    console.log(
      '[cache] dashboard recomputed',
      JSON.stringify({
        providerCount: payload.providerCount,
        reportCount: payload.reportCount,
        durationMs: Date.now() - startedAt,
      })
    );
    return doc;
  } catch (err) {
    console.error('[cache] dashboard recompute failed:', String((err && err.message) || err));
    return null;
  }
}

// Recomputes and writes cache/publicFeed, applying the byte-size safety
// trim if needed. Never throws, for the same reason as above.
async function recomputePublicFeedCache(db) {
  const startedAt = Date.now();
  try {
    const { items } = await computePublicFeedPayload(db, MAX_FEED_ITEMS);

    let finalItems = items;
    let sizeBytes = Buffer.byteLength(JSON.stringify(finalItems));
    let trimmedCount = 0;
    if (sizeBytes > MAX_CACHE_DOC_BYTES) {
      finalItems = trimToByteBudget(finalItems, MAX_CACHE_DOC_BYTES);
      trimmedCount = items.length - finalItems.length;
      sizeBytes = Buffer.byteLength(JSON.stringify(finalItems));
    }

    const doc = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      items: finalItems,
    };
    await db.collection(CACHE_COLLECTION).doc(PUBLIC_FEED_DOC_ID).set(doc);

    console.log(
      '[cache] publicFeed recomputed',
      JSON.stringify({
        itemCount: finalItems.length,
        sizeBytes,
        trimmedCount,
        durationMs: Date.now() - startedAt,
      })
    );
    if (trimmedCount > 0) {
      console.warn(
        `[cache] publicFeed trimmed ${trimmedCount} oldest item(s) to stay under the ${MAX_CACHE_DOC_BYTES}-byte safety budget`
      );
    }
    return doc;
  } catch (err) {
    console.error('[cache] publicFeed recompute failed:', String((err && err.message) || err));
    return null;
  }
}

// Returns true if cacheData is usable: right schema version and, when
// maxAgeMs is given, not older than that. Pass maxAgeMs=null to skip the
// time-based check entirely (used for publicFeed, where "old but
// unchanged" is expected and correct).
function isCacheFresh(cacheData, maxAgeMs) {
  if (!cacheData) return false;
  if (cacheData.schemaVersion !== SCHEMA_VERSION) return false;
  if (maxAgeMs == null) return true;
  if (!cacheData.generatedAt) return false;
  const age = Date.now() - new Date(cacheData.generatedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

module.exports = {
  SCHEMA_VERSION,
  CACHE_COLLECTION,
  DASHBOARD_DOC_ID,
  PUBLIC_FEED_DOC_ID,
  DASHBOARD_MAX_AGE_MS,
  MAX_FEED_ITEMS,
  computeDashboardPayload,
  computePublicFeedPayload,
  recomputeDashboardCache,
  recomputePublicFeedCache,
  isCacheFresh,
};
