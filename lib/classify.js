const { STATUS, FLASH_TYPE, SEVERITY } = require('./constants');
const { recommendFallback } = require('./recommend');

function fingerprint(reading) {
  const services = [...(reading.affectedServices || [])].sort().join(',');
  return `${reading.status}|${services}`;
}

function severityForStatus(status) {
  switch (status) {
    case STATUS.MAJOR_OUTAGE:
      return SEVERITY.CRITICAL;
    case STATUS.PARTIAL_OUTAGE:
      return SEVERITY.HIGH;
    case STATUS.DEGRADED:
    case STATUS.MONITORING:
      return SEVERITY.MEDIUM;
    default:
      return SEVERITY.LOW;
  }
}

function flashTypeForStatus(status) {
  if (status === STATUS.MONITORING) return FLASH_TYPE.UPDATE;
  if (status === STATUS.PARTIAL_OUTAGE || status === STATUS.MAJOR_OUTAGE) return FLASH_TYPE.OUTAGE;
  return FLASH_TYPE.DEGRADED;
}

async function buildFlash(db, provider, reading, type, nowIso, incidentData) {
  const severity = severityForStatus(reading.status);
  const affected = (reading.affectedServices || []).join(', ') || 'core API services';
  let headline;
  let summary;
  let developerImpact;
  let recommendedAction;

  if (type === FLASH_TYPE.RECOVERY) {
    const priorStatus = (incidentData && incidentData.status) || 'service';
    headline = `${provider.name} recovered`;
    summary = `${provider.name} has returned to normal operation after a ${priorStatus.replace('_', ' ')} incident.`;
    developerImpact = `Requests to ${provider.name} should now succeed normally; retry any previously failing calls.`;
    recommendedAction = `Resume normal routing to ${provider.name}.`;
  } else if (type === FLASH_TYPE.OUTAGE) {
    headline = `${provider.name} experiencing ${reading.status === STATUS.MAJOR_OUTAGE ? 'a major outage' : 'a partial outage'}`;
    summary = `${provider.name} is reporting a ${reading.status.replace('_', ' ')} affecting ${affected}.`;
    developerImpact = `Requests to ${affected} on ${provider.name} may fail or time out.`;
    recommendedAction = await recommendFallback(db, provider.id, { soft: false });
  } else if (type === FLASH_TYPE.DEGRADED) {
    headline = `${provider.name} degraded performance`;
    summary = `${provider.name} is reporting degraded performance affecting ${affected}.`;
    developerImpact = `Requests to ${affected} on ${provider.name} may see elevated latency or intermittent errors.`;
    recommendedAction = await recommendFallback(db, provider.id, { soft: true });
  } else {
    headline = `${provider.name} status update: monitoring a fix`;
    summary = `${provider.name} has applied a fix for a recent incident and is monitoring for stability.`;
    developerImpact = 'Some requests may still intermittently fail while the fix is verified.';
    recommendedAction = `No action required yet; continue monitoring ${provider.name}.`;
  }

  return {
    type,
    provider: provider.name,
    providerId: provider.id,
    severity,
    headline,
    summary,
    developerImpact,
    recommendedAction,
    sourceName: `${provider.name} Status`,
    sourceUrl: reading.sourceUrl || provider.sourceUrl,
    publishedAt: nowIso,
    retrievedAt: nowIso,
    active: true,
    approved: true, // official-source provider events are auto-published
    pinned: false,
    historical: false,
    providerIncidentId: reading.incidentId ? `${provider.id}_${reading.incidentId}` : null,
  };
}

// Finds the currently OPEN incident doc for a provider, regardless of
// whether it was keyed by a native incident id or a synthesized one. Used
// both to collapse repeated polls of the same anomaly into one incident and
// to detect recoveries once the provider goes back to operational.
async function findOpenIncident(db, providerId) {
  const snap = await db
    .collection('incidents')
    .where('providerId', '==', providerId)
    .where('resolvedAt', '==', null)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

// Processes a single provider status reading: updates providers/{id}, and
// creates/updates incidents/{providerIncidentId} + writes a flashes/ doc
// only when a materially new event has occurred. Returns the array of
// flash payloads that were written (for logging).
async function processReading(db, provider, reading) {
  const providerRef = db.collection('providers').doc(provider.id);
  const nowIso = new Date().toISOString();
  const providerSnap = await providerRef.get();
  const prevProviderData = providerSnap.exists ? providerSnap.data() : null;

  // A failed/unavailable check must never overwrite a known-good status -
  // retain the last verified state and just flag staleness internally.
  if (reading.stale) {
    await providerRef.set(
      {
        provider: provider.name,
        status: prevProviderData ? prevProviderData.status : STATUS.UNKNOWN,
        affectedServices: prevProviderData ? prevProviderData.affectedServices || [] : [],
        region: 'global',
        lastChecked: nowIso,
        verifiedAt: prevProviderData && prevProviderData.verifiedAt ? prevProviderData.verifiedAt : nowIso,
        source: prevProviderData && prevProviderData.source ? prevProviderData.source : 'unavailable',
        sourceUrl: reading.sourceUrl || provider.sourceUrl,
        stale: true,
      },
      { merge: true }
    );
    return [];
  }

  const isOperational = reading.status === STATUS.OPERATIONAL;
  const fp = fingerprint(reading);
  const flashesToCreate = [];

  let incidentRef = null;
  let incidentDoc = null;

  if (!isOperational) {
    if (reading.incidentId) {
      incidentRef = db.collection('incidents').doc(`${provider.id}_${reading.incidentId}`);
      incidentDoc = await incidentRef.get();
    } else {
      const existing = await findOpenIncident(db, provider.id);
      if (existing) {
        incidentRef = existing.ref;
        incidentDoc = existing;
      } else {
        incidentRef = db.collection('incidents').doc(`${provider.id}_${Date.now()}`);
        incidentDoc = null;
      }
    }

    const incidentExists = Boolean(incidentDoc && incidentDoc.exists);
    const incidentData = incidentExists ? incidentDoc.data() : null;
    const materialChange = !incidentExists || incidentData.fingerprint !== fp;

    if (materialChange) {
      const flash = await buildFlash(db, provider, reading, flashTypeForStatus(reading.status), nowIso);
      flashesToCreate.push(flash);

      await incidentRef.set(
        {
          providerId: provider.id,
          providerIncidentId: reading.incidentId || null,
          status: reading.status,
          fingerprint: fp,
          affectedServices: reading.affectedServices || [],
          incidentName: reading.incidentName || null,
          sourceUrl: reading.sourceUrl || provider.sourceUrl,
          openedAt: incidentExists ? incidentData.openedAt : nowIso,
          updatedAt: nowIso,
          resolvedAt: null,
        },
        { merge: true }
      );
    }
  } else if (!prevProviderData || prevProviderData.status !== STATUS.OPERATIONAL) {
    // Operational reading, and the previously recorded status was NOT
    // already operational - there might be an open incident to resolve.
    // (If the prior status WAS already operational, no incident can still
    // be open: this branch always resolves it the first time status
    // flips back to operational, so every subsequent healthy check for an
    // already-healthy provider can safely skip this Firestore read - the
    // overwhelmingly common steady-state case.)
    const existing = await findOpenIncident(db, provider.id);
    if (existing) {
      const incidentData = existing.data();
      const flash = await buildFlash(db, provider, reading, FLASH_TYPE.RECOVERY, nowIso, incidentData);
      flashesToCreate.push(flash);
      await existing.ref.set({ resolvedAt: nowIso, updatedAt: nowIso }, { merge: true });
    }
  }

  await providerRef.set(
    {
      provider: provider.name,
      // Provider status always settles to the raw reading - "recovered" is
      // never persisted here, it only exists as the flash type above.
      status: reading.status,
      affectedServices: reading.affectedServices || [],
      region: 'global',
      lastChecked: nowIso,
      verifiedAt: nowIso,
      source: 'official',
      sourceUrl: reading.sourceUrl || provider.sourceUrl,
      stale: false,
    },
    { merge: true }
  );

  for (const flash of flashesToCreate) {
    await db.collection('flashes').add(flash);
  }

  return flashesToCreate;
}

module.exports = { processReading };
