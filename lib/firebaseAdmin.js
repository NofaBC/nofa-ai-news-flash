// firebase-admin v12+ removed the old namespaced default export
// (admin.credential.cert / admin.firestore() / admin.apps). It now ships a
// modular API: import initializeApp/getApps/cert from 'firebase-admin/app'
// and getFirestore from 'firebase-admin/firestore'.
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore: getFirestoreInstance } = require('firebase-admin/firestore');

let cachedFirestore = null;
let lastInitError = null;

function isConfigured() {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  );
}

function normalizePrivateKey(raw) {
  let key = raw.trim();
  // Defensive: strip one layer of surrounding quotes if the value was
  // copy-pasted including the quote characters from the downloaded JSON
  // service account file (a common source of PEM parse failures).
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  // Vercel env vars store the private key with literal "\n" sequences;
  // convert them back into real newlines for the PEM to parse. Harmless if
  // the value already contains real newlines (no literal \n to replace).
  return key.replace(/\\n/g, '\n');
}

// Returns a Firestore instance, or null if Firebase credentials have not
// been configured yet OR initialization failed (e.g. a malformed private
// key). This function must NEVER throw - callers rely on a null return to
// degrade gracefully instead of crashing the serverless function.
function getFirestore() {
  if (!isConfigured()) return null;
  if (cachedFirestore) return cachedFirestore;

  try {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID.trim(),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL.trim(),
          privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
        }),
      });
    }
    cachedFirestore = getFirestoreInstance();
    lastInitError = null;
    return cachedFirestore;
  } catch (err) {
    lastInitError = err && err.message ? err.message : String(err);
    console.error('Firebase Admin initialization failed:', lastInitError);
    return null;
  }
}

// Returns only the error MESSAGE (never key material) from the last failed
// initialization attempt, so API routes can surface a diagnostic hint
// without ever exposing the private key or other credential values.
function getInitError() {
  return lastInitError;
}

module.exports = { isConfigured, getFirestore, getInitError };
