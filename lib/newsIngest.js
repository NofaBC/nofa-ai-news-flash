const crypto = require('crypto');
const PROVIDERS = require('./providers.config');

const FETCH_TIMEOUT_MS = 8000;

const INFRA_KEYWORDS = [
  'api', 'sdk', 'outage', 'down', 'downtime', 'degraded', 'disruption',
  'incident', 'recover', 'release', 'launch', 'model', 'update', 'upgrade',
  'deprecat', 'rate limit', 'pricing', 'context window', 'benchmark',
  'infrastructure', 'developer',
];

// Minimum score for an article to be considered high-value enough to
// publish. GNews's general "AI" search is noisy (opinion pieces, funding
// rounds, unrelated mentions) so this filters aggressively.
const RELEVANCE_THRESHOLD = 3;

function scoreArticle(article) {
  const text = `${article.title || ''} ${article.description || ''}`.toLowerCase();
  let score = 0;
  const mentionedProvider = PROVIDERS.find(
    (p) => text.includes(p.name.toLowerCase()) || text.includes(p.id)
  );
  if (mentionedProvider) score += 3;
  INFRA_KEYWORDS.forEach((keyword) => {
    if (text.includes(keyword)) score += 1;
  });
  return { score, mentionedProvider };
}

function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
}

// Strips API key query params before a URL is ever used in a log/error
// message, so a fetch failure can never leak key material into logs.
function sanitizeUrlForLogging(url) {
  return url.replace(/([?&](?:apikey|access_key)=)[^&]+/i, '$1REDACTED');
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    const safeUrl = sanitizeUrlForLogging(url);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${safeUrl}: ${text.slice(0, 300)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Invalid JSON from ${safeUrl}: ${text.slice(0, 300)}`);
    }

    // Some news APIs (e.g. Mediastack on restricted plans) return HTTP 200
    // with an error payload instead of a non-2xx status - treat that as a
    // failure too so it doesn't silently look like "zero articles found".
    if (data && data.error) {
      throw new Error(`API error from ${safeUrl}: ${JSON.stringify(data.error).slice(0, 300)}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGNews(apiKey) {
  const query = encodeURIComponent(
    'OpenAI OR Anthropic OR Claude OR Gemini OR "xAI" OR Grok OR Kimi OR "Z.ai" OR Qwen OR "AI API" OR "AI infrastructure"'
  );
  const url = `https://gnews.io/api/v4/search?q=${query}&lang=en&max=25&sortby=publishedAt&apikey=${apiKey}`;
  const data = await fetchWithTimeout(url);
  return (data.articles || []).map((a) => ({
    title: a.title,
    description: a.description,
    url: a.url,
    source: a.source && a.source.name,
    publishedAt: a.publishedAt,
  }));
}

async function fetchMediastack(apiKey) {
  const keywords = encodeURIComponent('OpenAI,Anthropic,Gemini,xAI,Grok,Kimi,Qwen,Z.ai');
  const url = `https://api.mediastack.com/v1/news?access_key=${apiKey}&keywords=${keywords}&languages=en&limit=25`;
  const data = await fetchWithTimeout(url);
  return (data.data || []).map((a) => ({
    title: a.title,
    description: a.description,
    url: a.url,
    source: a.source,
    publishedAt: a.published_at,
  }));
}

// Ingests AI industry news from GNews (primary) with Mediastack as a
// fallback when GNews errors/is rate-limited, scores each article for
// developer/infrastructure relevance, and writes only high-value stories
// into news/{urlHash} (idempotent id so overlapping cron runs can't
// double-insert). News defaults to approved:false pending admin review,
// unlike official-source provider flashes which auto-publish.
async function ingestNews(db) {
  const gnewsKey = process.env.GNEWS_API_KEY;
  const mediastackKey = process.env.MEDIASTACK_API_KEY;

  if (!gnewsKey && !mediastackKey) {
    return { skipped: true, reason: 'no news API keys configured' };
  }

  let articles = [];
  let usedSource = null;

  if (gnewsKey) {
    try {
      articles = await fetchGNews(gnewsKey);
      usedSource = 'GNews';
    } catch (err) {
      // Safe to log: fetchWithTimeout already redacts apikey from the URL.
      console.error('[newsIngest] GNews fetch failed, will try Mediastack fallback:', String((err && err.message) || err));
      articles = [];
    }
  }

  if (!articles.length && mediastackKey) {
    try {
      articles = await fetchMediastack(mediastackKey);
      usedSource = 'Mediastack';
    } catch (err) {
      console.error('[newsIngest] Mediastack fetch also failed:', String((err && err.message) || err));
      articles = [];
    }
  }

  if (!articles.length) {
    return { skipped: true, reason: 'no articles returned from any news source', usedSource };
  }

  let written = 0;
  let filtered = 0;

  for (const article of articles) {
    if (!article.url || !article.title) continue;
    const { score, mentionedProvider } = scoreArticle(article);
    if (score < RELEVANCE_THRESHOLD) {
      filtered += 1;
      continue;
    }

    const id = hashUrl(article.url);
    const ref = db.collection('news').doc(id);
    const existing = await ref.get();
    if (existing.exists) continue;

    await ref.set({
      headline: article.title,
      summary: article.description || '',
      provider: mentionedProvider ? mentionedProvider.name : 'Multi-provider',
      sourceName: article.source || usedSource,
      sourceUrl: article.url,
      publishedAt: article.publishedAt || new Date().toISOString(),
      retrievedAt: new Date().toISOString(),
      relevanceScore: score,
      approved: false,
      active: true,
      historical: false,
    });
    written += 1;
  }

  return { skipped: false, usedSource, fetched: articles.length, filtered, written };
}

module.exports = { ingestNews };
