// One-off migration: loads the sample incident reports that used to be
// hardcoded in index.html into Firestore as historical flashes, so the
// history feed keeps context after the switch to live data.
//
// Usage (after setting FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
// FIREBASE_PRIVATE_KEY in your shell environment):
//   npm run seed:historical
//
// historical:true + active:false are set on every record so they never
// count toward "current active incidents" in the dashboard/ticker.

try {
  // Optional convenience: load a local .env file if the `dotenv` package
  // happens to be installed. Not a hard dependency of this project.
  require('dotenv').config();
} catch (err) {
  // dotenv not installed - assume env vars are already set in the shell.
}

const { getFirestore, isConfigured } = require('../lib/firebaseAdmin');
const PROVIDERS = require('../lib/providers.config');

const HISTORICAL_REPORTS = [
  { type: 'recovery', provider: 'Anthropic Claude', title: 'Claude service disruption recovered', summary: 'A model/service degradation was reported and later restored.', impact: 'Claude-backed coding and inference workflows can return to normal routing.', action: 'Keep Claude in normal rotation; retain OpenAI and Gemini as contingency providers.', time: 'Sep 21, 2026' },
  { type: 'recovery', provider: 'Moonshot Kimi', title: 'Kimi search error spike resolved', summary: 'Kimi reported a short-lived search-request error spike above normal levels.', impact: 'Search-dependent developer workflows may have failed briefly; core service later returned to normal.', action: 'No failover is needed now. Use OpenAI or Claude if similar Kimi search errors recur.', time: 'Sep 19, 2026' },
  { type: 'recovery', provider: 'OpenAI', title: 'OpenAI API-wide degradation cleared', summary: 'Elevated errors affected multiple API components before service returned to normal.', impact: 'NOFA apps using OpenAI may have experienced intermittent failures during the incident window.', action: 'Return OpenAI workloads to normal routing; keep Claude and Gemini on standby.', time: 'Sep 17, 2026' },
  { type: 'degraded', provider: 'OpenAI', title: 'APAC multi-service degradation', summary: 'ChatGPT, Work, image generation, file uploads, Voice and Codex Cloud saw elevated errors in APAC.', impact: 'Regional developer and user workflows could fail while U.S. traffic remained less affected.', action: 'Use regional health-aware failover rather than disabling OpenAI globally.', time: 'Sep 16, 2026' },
  { type: 'recovery', provider: 'Anthropic Claude', title: 'Claude model-specific degradation recovered', summary: 'Elevated errors affected selected Claude models and were later resolved.', impact: 'Model-pinned workflows may have experienced intermittent request failures.', action: 'Restore normal Claude routing; fail over only when model-specific errors recur.', time: 'Sep 15, 2026' },
  { type: 'recovery', provider: 'OpenAI', title: 'Image API incident resolved', summary: 'OpenAI image-generation/editing requests saw elevated errors before mitigation and recovery.', impact: 'Image-generation workflows may have failed during the incident.', action: 'Resume normal image routing and keep a compatible image fallback available.', time: 'Sep 15, 2026' },
  { type: 'recovery', provider: 'OpenAI', title: 'Agents API degradation recovered', summary: 'Managed agent sessions saw delays or failures starting turns before recovery.', impact: 'Agentic applications and session-based workflows were temporarily at risk.', action: 'Resume OpenAI agent workflows; maintain Claude or Gemini fallbacks.', time: 'Sep 15, 2026' },
  { type: 'recovery', provider: 'OpenAI', title: 'Codex and ChatGPT Work restored', summary: 'Elevated errors affecting Codex and Work were resolved.', impact: 'Coding, research and multi-step Work workflows can return to normal.', action: 'No failover required.', time: 'Sep 14, 2026' },
  { type: 'update', provider: 'GitHub / OpenAI', title: 'Codex workflow disruption tied to GitHub', summary: 'GitHub pull requests and related services degraded, impacting Codex review/PR workflows.', impact: 'Developer automation could fail even when model inference remained healthy.', action: 'Do not switch AI providers unnecessarily; wait for GitHub service recovery.', time: 'Sep 13, 2026' },
  { type: 'recovery', provider: 'OpenAI', title: 'GPT-5.6 Sol API incident recovered', summary: 'Elevated API errors were reported on a specific OpenAI model before full recovery.', impact: 'Pinned production workloads could have seen intermittent failures.', action: 'Return model traffic to normal and retain cross-provider fallbacks.', time: 'Sep 11, 2026' },
  { type: 'recovery', provider: 'Anthropic Claude', title: 'Claude API Midwest latency issue resolved', summary: 'Some U.S. Midwest traffic saw higher latency and timeouts before recovery.', impact: 'Latency-sensitive workloads may have required temporary rerouting.', action: 'Resume normal Claude routing.', time: 'Sep 10, 2026' },
  { type: 'recovery', provider: 'OpenAI', title: 'Image generation and file upload incidents recovered', summary: 'OpenAI resolved separate image-generation and file-upload disruptions.', impact: 'Document and image workflows returned to normal operation.', action: 'No active failover required.', time: 'Sep 8, 2026' },
  { type: 'update', provider: 'Multi-provider', title: 'Major AI platforms experienced overlapping outages', summary: 'OpenAI, Claude, Grok and other services reported overlapping disruptions.', impact: 'The event highlighted the operational risk of relying on a single AI provider.', action: 'Maintain multi-provider readiness and health-aware routing.', time: 'Sep 3, 2026' },
];

function findProviderId(name) {
  const match = PROVIDERS.find((p) => name.includes(p.name) || p.name.includes(name));
  return match ? match.id : null;
}

async function main() {
  if (!isConfigured()) {
    console.error(
      'Firebase env vars are not set. Export FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and ' +
        'FIREBASE_PRIVATE_KEY in your shell before running this script.'
    );
    process.exitCode = 1;
    return;
  }

  const db = getFirestore();
  let written = 0;

  for (const report of HISTORICAL_REPORTS) {
    const providerId = findProviderId(report.provider);
    const publishedAt = new Date(report.time);
    // eslint-disable-next-line no-await-in-loop
    await db.collection('flashes').add({
      type: report.type,
      provider: report.provider,
      providerId,
      severity: 'medium',
      headline: report.title,
      summary: report.summary,
      developerImpact: report.impact,
      recommendedAction: report.action,
      sourceName: `${report.provider} Status`,
      sourceUrl: null,
      publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date().toISOString() : publishedAt.toISOString(),
      retrievedAt: new Date().toISOString(),
      active: false,
      approved: true,
      pinned: false,
      historical: true,
    });
    written += 1;
  }

  console.log(`Seeded ${written} historical flashes (historical:true, active:false).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
