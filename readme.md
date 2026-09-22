NOFA AI News Flash

NOFA AI News Flash is a standalone, developer-focused AI intelligence
platform. It monitors official status sources for major AI providers,
ingests AI industry news, and turns both into deduplicated, developer-impact
oriented reports - "flashes" - that are published to a live dashboard.

Phase 1 (this repository) is an internal NOFA tool. It is architected so a
Phase 2 (subscriptions, accounts, billing, custom domain) can be layered on
later without restructuring, but none of that is built yet.

Live app: https://nofa-ai-news-flash.vercel.app/

Architecture

Official provider status pages, GNews and Mediastack feed into a Vercel
serverless ingestion layer, which normalizes, deduplicates, classifies and
writes to Firestore. Vercel serverless API routes read from Firestore for
the public frontend and the internal admin panel.

Two Vercel Cron jobs drive ingestion:

- `/api/cron/check-providers` runs every 5 minutes and checks the 7
  monitored providers against their official status sources.
- `/api/cron/ingest-news` runs every 12 minutes and pulls AI industry news
  from GNews (falling back to Mediastack).

The frontend (`index.html`) polls two read-only public API routes roughly
every 60 seconds:

- `GET /api/public/dashboard` - provider cards, counts, ticker text, last
  update time.
- `GET /api/public/flashes` - the News Flash History feed (flashes + news).

Neither cron job nor the public routes ever call GNews/Mediastack/provider
status pages directly from a visitor's browser - all outbound calls happen
server-side in `/api` routes, and API keys only ever live in Vercel
environment variables.

Providers monitored

OpenAI, Anthropic Claude, Google Gemini, xAI Grok, Moonshot Kimi, Z.ai and
Qwen. See `lib/providers.config.js` for the exact source used per provider:

- OpenAI, Anthropic, xAI, Moonshot Kimi: official Atlassian Statuspage
  `/api/v2/summary.json` feeds.
- Google Gemini: Google Cloud's public `incidents.json` feed, filtered to
  Gemini/Vertex AI/Generative AI products.
- Z.ai and Qwen: no public machine-readable status source is currently
  known to exist. These two are always reported as `unknown` rather than
  guessed as operational or down - see "Provider status model" below. If a
  reliable source is found later, add it to `lib/providers.config.js` and
  `lib/statusCheckers.js`.

Provider status model

Every provider's stored status is one of: `operational`, `degraded`,
`monitoring`, `partial_outage`, `major_outage`, `unknown`. Note that
`recovered` is intentionally not in this list - a recovery is an event
(a `flashes` document with `type: "recovery"`), not a resting provider
state. Once a provider recovers, its stored status settles back to
`operational`.

If a provider's status source cannot be reached or parsed, the app never
guesses: it keeps the last verified status and sets an internal `stale`
flag on the `providers/{id}` document. The public UI shows the last known
status plus a small "awaiting fresh check" note rather than showing a false
outage or false "operational".

Data model (Firestore)

- `providers/{providerId}` - current status, affectedServices, region,
  lastChecked, verifiedAt, source, sourceUrl, stale.
- `incidents/{providerIncidentId}` - one document per distinct upstream
  incident, used for deduplication (see below). Keyed by
  `{providerId}_{nativeIncidentId}` when the source provides a stable
  incident id (Statuspage/Google Cloud), or `{providerId}_{timestamp}` when
  it doesn't. Stores status, a fingerprint, openedAt/resolvedAt.
- `flashes/{autoId}` - type (`outage`/`degraded`/`recovery`/`update`),
  provider, severity, headline, summary, developerImpact,
  recommendedAction, sourceName, sourceUrl, publishedAt, retrievedAt,
  active, approved, pinned, historical, providerIncidentId.
- `news/{urlHash}` - AI industry news, keyed by a hash of the article URL so
  duplicate cron runs can never double-insert the same story. Kept separate
  from `flashes` so the two feeds can be ranked/moderated independently.

Deduplication

A new Flash is only created on a materially new event - not on every 5
minute poll. `lib/classify.js` resolves the current incident id (native or
synthesized) and looks it up in `incidents/`. If the incident is new, or its
fingerprint (status + affected services) changed, a Flash is written and the
incident doc is updated. Using the incident id rather than only the status
shape prevents two distinct, same-shaped degradations from collapsing into
a single event. When a provider goes back to `operational` while an
incident was open, that incident is marked resolved and a `recovery` Flash
is written.

News relevance filtering

GNews's general AI search is noisy. `lib/newsIngest.js` scores every
candidate article (provider name mentions, infrastructure/developer
keywords such as API, SDK, outage, release, deprecation) and only writes
articles above a relevance threshold into `news/`. Mediastack is used only
when GNews errors or is rate-limited.

Approval defaults

Provider flashes (outages, degradations, recoveries) come from official
status pages and are auto-approved (`approved: true`) so the public feed
stays timely. News items default to `approved: false` and only appear on
the public site once approved in the admin panel, since third-party news
content is lower-trust and benefits from a human check.

Historical data

`scripts/seed-historical.js` migrates the sample incident reports that used
to be hardcoded in `index.html` into Firestore as `historical: true`,
`active: false` flashes. Every query that represents "current"/"active"
state (provider counts, report counts, the ticker) explicitly excludes
`historical: true` documents, so seeded sample data can never distort live
counts. The History feed can still display them for context.

Recommendations

`lib/recommend.js` never blindly names a fallback provider. It only
suggests providers whose currently stored Firestore status is
`operational` and not stale, so a recommendation is always checked against
live data before being shown.

Setup

1. Firebase project (required for live data)

   - Go to the Firebase console and create a new project (or reuse an
     existing GCP project).
   - Enable Firestore (Native mode) in that project.
   - Go to Project Settings -> Service Accounts -> Generate new private key.
     This downloads a JSON file containing `project_id`, `client_email` and
     `private_key`.
   - Set the following Vercel environment variables from that file:
     `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
     When pasting the private key into Vercel, keep the literal `\n`
     sequences - the code converts them back into real newlines.
   - Firestore composite indexes: the first time each query below runs,
     Firestore/the function logs will show a direct "create index" link.
     You can also create them ahead of time in the Firestore console under
     Indexes:
     - `flashes`: `historical` Asc, `approved` Asc, `publishedAt` Desc
     - `flashes`: `approved` Asc, `publishedAt` Desc
     - `news`: `approved` Asc, `publishedAt` Desc
     - `incidents`: `providerId` Asc, `resolvedAt` Asc

   Until these three env vars are set, the site still deploys and works -
   provider cards show `unknown`/stale and the ticker shows a "pending
   backend setup" message instead of erroring.

2. News ingestion (optional)

   - Get a free/paid API key from https://gnews.io and set `GNEWS_API_KEY`.
   - Optionally get a key from https://mediastack.com and set
     `MEDIASTACK_API_KEY` as a fallback.
   - Without either key, `/api/cron/ingest-news` simply no-ops
     (`{ skipped: true }`) - no errors, no news ingested.

3. Cron authentication

   - Generate a random string (16+ characters) and set it as `CRON_SECRET`
     in Vercel. This is Vercel's own documented cron security mechanism:
     once set, Vercel automatically sends it as
     `Authorization: Bearer <CRON_SECRET>` on every scheduled invocation of
     the two cron routes, which simply compare that header. There is no
     separate custom auth scheme to maintain.

4. Admin panel

   - Set `ADMIN_SECRET` in Vercel to a strong shared password.
   - Visit `/admin.html` (not linked from the public site) and sign in with
     that password to approve/hide/pin/edit flashes and news.

5. Historical data (optional, one-time)

   - After Firebase env vars are set, run `npm install` then
     `npm run seed:historical` locally (with the same three Firebase env
     vars exported in your shell) to load the old sample incidents into
     Firestore as historical records.

Deployment

This is a plain Vercel project (no framework build step) - `index.html` and
`admin.html` are served as static files, and everything under `/api` is
deployed as Vercel serverless functions automatically. Push to `main` (or
open a PR) and Vercel will build/deploy as usual. `vercel.json` registers
the two cron jobs; cron jobs only run against the current production
deployment.

Suggested environment variables (set in Vercel -> Project -> Settings ->
Environment Variables):

```
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
GNEWS_API_KEY=
MEDIASTACK_API_KEY=
CRON_SECRET=
ADMIN_SECRET=
```

Refresh frequency

- Frontend polls the two public API routes roughly every 60 seconds.
- Provider status checks run every 5 minutes (Vercel Cron).
- News ingestion runs every 12 minutes (Vercel Cron).
- No provider/news API is ever called directly from a visitor's browser or
  on every page load - only from the scheduled cron routes.

NOFA AI Factory integration

NOFA AI News Flash remains a standalone Vercel application. The
nofaaifactory.com site will only contain a clickable promotional banner
linking to the live app above - the full application is not embedded there.
This keeps the door open for Phase 2 to turn this into a paid subscription
product without re-architecting.

Future direction (Phase 2, not built yet)

Stripe subscriptions, user accounts/authentication, paid plans, customer
dashboards, customer-specific feeds, embeddable widgets, QR access,
white-label feeds, vertical editions and usage limits are all intentionally
out of scope for Phase 1. The data model (separate `flashes`/`news`
collections, admin approval workflow, standalone deployment) is designed so
these can be added later without restructuring, and the app is expected to
be reachable at a future custom domain such as
`newsflash.nofaaifactory.com` without code changes.

Status

Phase: Internal MVP / Phase 1 (live backend)
Owner: NOFA AI Factory
