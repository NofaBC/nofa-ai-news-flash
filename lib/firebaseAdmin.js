const admin = require('firebase-admin');

let cachedFirestore = null;

function isConfigured() {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  );
}

// Returns a Firestore instance, or null if Firebase credentials have not
// been configured yet. Callers MUST check isConfigured()/handle a null
// return so the app keeps working (per Phase 1 requirement) before a
// Firebase project is created.
function getFirestore() {
  if (!isConfigured()) return null;
  if (cachedFirestore) return cachedFirestore;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Vercel env vars store the private key with literal "\n" sequences;
        // convert them back into real newlines for the PEM to parse.
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  }

  cachedFirestore = admin.firestore();
  return cachedFirestore;
}

module.exports = { isConfigured, getFirestore };
