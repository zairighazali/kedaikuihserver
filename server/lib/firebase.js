// backend/lib/firebase.js
// Firebase Admin SDK — used to verify ID tokens from the frontend


const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Replace escaped newlines when reading from env vars
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

/**
 * Verify a Firebase ID token string.
 * Returns the decoded token payload (uid, email, role custom claim, etc.)
 */
async function verifyToken(idToken) {
  return admin.auth().verifyIdToken(idToken);
}

/**
 * Set a custom claim (role) on a Firebase user.
 * Call this from admin endpoints when promoting a user to admin/affiliate.
 * @param {string} uid
 * @param {object} claims - e.g. { role: 'admin' }
 */
async function setCustomClaims(uid, claims) {
  return admin.auth().setCustomUserClaims(uid, claims);
}

/**
 * Get Firebase user by UID
 */
async function getUser(uid) {
  return admin.auth().getUser(uid);
}

module.exports = { admin, verifyToken, setCustomClaims, getUser };
