const { STATUS } = require('./constants');

const FETCH_TIMEOUT_MS = 8000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'NofaAINewsFlash/1.0 (+https://nofa-ai-news-flash.vercel.app)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const STATUSPAGE_INDICATOR_MAP = {
  none: STATUS.OPERATIONAL,
  minor: STATUS.DEGRADED,
  major: STATUS.PARTIAL_OUTAGE,
  critical: STATUS.MAJOR_OUTAGE,
};

// Parses an Atlassian Statuspage /api/v2/summary.json response.
async function checkStatuspage(provider) {
  const data = await fetchJson(provider.statusUrl);
  const indicator = (data && data.status && data.status.indicator) || 'none';
  let status = STATUSPAGE_INDICATOR_MAP[indicator] || STATUS.UNKNOWN;

  const unresolvedIncidents = Array.isArray(data.incidents) ? data.incidents : [];
  // Most recently created unresolved incident represents "the" current event.
  const primary = unresolvedIncidents[0] || null;

  // A fix has been applied and the provider is watching for stability -
  // surface this distinctly from an active degraded/outage state.
  if (primary && primary.status === 'monitoring') {
    status = STATUS.MONITORING;
  }

  const affectedServices = (Array.isArray(data.components) ? data.components : [])
    .filter((c) => c && c.status && c.status !== 'operational')
    .map((c) => c.name)
    .filter(Boolean);

  return {
    status,
    affectedServices,
    incidentId: primary ? primary.id : null,
    incidentName: primary ? primary.name : null,
    sourceUrl: provider.sourceUrl,
    stale: false,
  };
}

// Parses Google Cloud's public incidents.json feed, filtered to the
// products relevant to this provider entry (e.g. Gemini / Vertex AI).
async function checkGoogleCloud(provider) {
  const data = await fetchJson(provider.statusUrl);
  const allIncidents = Array.isArray(data) ? data : [];
  const filters = (provider.productFilter || []).map((f) => f.toLowerCase());

  const relevant = allIncidents.filter((incident) => {
    const products = Array.isArray(incident.affected_products)
      ? incident.affected_products.map((p) => (p && p.title ? p.title.toLowerCase() : ''))
      : [];
    return products.some((title) => filters.some((f) => title.includes(f)));
  });

  const ongoing = relevant.filter((incident) => !incident.end);

  if (!ongoing.length) {
    return {
      status: STATUS.OPERATIONAL,
      affectedServices: [],
      incidentId: null,
      incidentName: null,
      sourceUrl: provider.sourceUrl,
      stale: false,
    };
  }

  const primary = ongoing[0];
  const severityText = `${primary.status_impact || ''} ${primary.severity || ''}`.toLowerCase();
  const status = /outage|disruption|down/.test(severityText) ? STATUS.MAJOR_OUTAGE : STATUS.PARTIAL_OUTAGE;

  return {
    status,
    affectedServices: (Array.isArray(primary.affected_products) ? primary.affected_products : [])
      .map((p) => p && p.title)
      .filter(Boolean),
    incidentId: primary.id || primary.number || null,
    incidentName: primary.external_desc || primary.id || 'Google Cloud incident',
    sourceUrl: primary.uri || provider.sourceUrl,
    stale: false,
  };
}

// No known machine-readable status source for this provider. Always report
// unknown rather than guessing - per the spec, a provider that cannot be
// checked must never be automatically labeled as down (or up).
async function checkNone(provider) {
  return {
    status: STATUS.UNKNOWN,
    affectedServices: [],
    incidentId: null,
    incidentName: null,
    sourceUrl: provider.sourceUrl,
    stale: true,
  };
}

async function checkProvider(provider) {
  try {
    if (provider.statusPageType === 'statuspage') return await checkStatuspage(provider);
    if (provider.statusPageType === 'google-cloud') return await checkGoogleCloud(provider);
    return await checkNone(provider);
  } catch (err) {
    // Network error, timeout, or unexpected response shape: never guess a
    // status, just mark the reading stale/unknown.
    return {
      status: STATUS.UNKNOWN,
      affectedServices: [],
      incidentId: null,
      incidentName: null,
      sourceUrl: provider.sourceUrl,
      stale: true,
      error: String((err && err.message) || err),
    };
  }
}

module.exports = { checkProvider };
