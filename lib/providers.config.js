// Registry of monitored providers and where to check their official status.
//
// statusPageType:
//   'statuspage'   - Atlassian Statuspage-based page exposing /api/v2/summary.json
//   'google-cloud' - Google Cloud's incidents.json feed, filtered by product name
//   'none'         - No public machine-readable status source is known to exist.
//                    These providers are ALWAYS reported as 'unknown' by the
//                    checker (see lib/statusCheckers.js) - never defaulted to
//                    'operational'. If NOFA finds/builds a reliable source for
//                    these later, add a statusUrl and change the type here.
const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    note: 'API / ChatGPT / Codex',
    statusPageType: 'statuspage',
    statusUrl: 'https://status.openai.com/api/v2/summary.json',
    sourceUrl: 'https://status.openai.com',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    note: 'Claude API / Claude Code',
    statusPageType: 'statuspage',
    statusUrl: 'https://status.claude.com/api/v2/summary.json',
    sourceUrl: 'https://status.claude.com',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    note: 'Gemini API / platform',
    statusPageType: 'google-cloud',
    statusUrl: 'https://status.cloud.google.com/incidents.json',
    sourceUrl: 'https://status.cloud.google.com',
    productFilter: ['gemini', 'vertex ai', 'generative ai', 'ai platform'],
  },
  {
    id: 'grok',
    name: 'xAI Grok',
    note: 'Grok API regions',
    // status.x.ai does NOT run Atlassian Statuspage - all /api/v2/* paths
    // 404 (confirmed directly). It runs Instatus, which only exposes an
    // RSS incident feed. See lib/statusCheckers.js#checkInstatusRss.
    statusPageType: 'instatus-rss',
    statusUrl: 'https://status.x.ai/feed.xml',
    sourceUrl: 'https://status.x.ai',
  },
  {
    id: 'kimi',
    name: 'Moonshot Kimi',
    note: 'Kimi API / K2',
    statusPageType: 'statuspage',
    // status.moonshot.ai does not resolve (verified via DNS lookup - NXDOMAIN).
    // status.moonshot.cn is Moonshot's actual live Statuspage instance.
    statusUrl: 'https://status.moonshot.cn/api/v2/summary.json',
    sourceUrl: 'https://status.moonshot.cn',
  },
  {
    id: 'zai',
    name: 'Z.ai',
    note: 'GLM / API',
    statusPageType: 'none',
    statusUrl: null,
    sourceUrl: 'https://z.ai',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    note: 'Qwen / Model Studio',
    statusPageType: 'none',
    statusUrl: null,
    sourceUrl: 'https://qwen.ai',
  },
];

module.exports = PROVIDERS;
