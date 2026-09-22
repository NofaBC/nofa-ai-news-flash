const { STATUS } = require('./constants');

const FETCH_TIMEOUT_MS = 8000;

const REQUEST_HEADERS = { 'User-Agent': 'NofaAINewsFlash/1.0 (+https://nofa-ai-news-flash.vercel.app)' };

async function fetchRaw(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: REQUEST_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const res = await fetchRaw(url);
  return res.json();
}

async function fetchText(url) {
  const res = await fetchRaw(url);
  return res.text();
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

function extractTag(block, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
  return match ? match[1].trim() : null;
}

function extractAllTags(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let match = re.exec(block);
  while (match) {
    out.push(match[1].trim());
    match = re.exec(block);
  }
  return out;
}

// xAI's status page (status.x.ai) does NOT run Atlassian Statuspage - all
// /api/v2/* paths 404. It runs Instatus, which only publishes an RSS
// incident feed (feed.xml), not a JSON "current status" endpoint. Each
// <item> is one incident; its GUID (e.g. "INC578e0bc8") is a stable native
// incident id we can use directly for dedup. An incident is considered
// active (not resolved) when its description's "Status: X" is not
// RESOLVED and the "resolved" category tag is absent - confirmed against
// the live feed's actual resolved-incident structure. Verified working
// with our standard request User-Agent (no Cloudflare block observed);
// the default curl/no-UA request DOES get a 403, so a UA header is
// required.
async function checkInstatusRss(provider) {
  const xml = await fetchText(provider.statusUrl);
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

  const items = itemBlocks.map((block) => {
    const title = extractTag(block, 'title') || '';
    const guid = extractTag(block, 'guid') || '';
    const link = extractTag(block, 'link') || '';
    const categories = extractAllTags(block, 'category').map((c) => c.toLowerCase());
    let description = extractTag(block, 'description') || '';
    description = description.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    const statusMatch = /Status:\s*([A-Z]+)/i.exec(description);
    const statusLabel = statusMatch ? statusMatch[1].toUpperCase() : null;
    const resolved = statusLabel === 'RESOLVED' || categories.includes('resolved');
    return { title, guid, link, categories, resolved, statusLabel };
  });

  // Feed is ordered newest-first; the first non-resolved item is the
  // current active incident, if any.
  const active = items.find((item) => !item.resolved);

  if (!active) {
    return {
      status: STATUS.OPERATIONAL,
      affectedServices: [],
      incidentId: null,
      incidentName: null,
      sourceUrl: provider.sourceUrl,
      stale: false,
    };
  }

  const componentMatch = /^\[(.+?)\]/.exec(active.title);
  const affectedServices = componentMatch ? [componentMatch[1]] : [];
  const incidentName = active.title.replace(/^\[.+?\]\s*/, '') || active.title;

  let status;
  if (active.statusLabel === 'MONITORING') {
    status = STATUS.MONITORING;
  } else if (/major|outage/i.test(active.title)) {
    status = STATUS.MAJOR_OUTAGE;
  } else if (/degrad|partial/i.test(active.title)) {
    status = STATUS.PARTIAL_OUTAGE;
  } else {
    // Conservative default for an active incident whose exact severity
    // can't be confidently classified from the title text.
    status = STATUS.DEGRADED;
  }

  return {
    status,
    affectedServices,
    incidentId: active.guid || null,
    incidentName,
    sourceUrl: active.link || provider.sourceUrl,
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
    if (provider.statusPageType === 'instatus-rss') return await checkInstatusRss(provider);
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
