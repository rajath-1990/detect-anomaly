/**
 * Firestore bridge.
 *
 * Firestore is NOT on the hot path - the engine never waits on it. It holds
 * only what the Android app must see:
 *   anomalies/   written by us, the app listens
 *   credentials/ the registry; the app writes `revoked`, we listen
 *   stats/live   throttled counters for the dashboard header
 *
 * Its realtime listener is what replaces a WebSocket server: the app subscribes
 * to a collection and never needs to know this backend's address at all.
 *
 * Degrades gracefully. With no service-account credentials configured the whole
 * module no-ops and the engine still runs from local JSON, so the algorithm can
 * be verified from a terminal before any Firebase project exists.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const localCredentials = JSON.parse(readFileSync(join(here, 'credentials.json'), 'utf8'));

let db = null;
let FieldValue = null;

export const firestore = {
  get enabled() {
    return db !== null;
  },

  /**
   * Returns true if Firestore is live, false if running offline.
   * Never throws - a missing key file is a supported mode, not an error.
   */
  async init() {
    const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!keyPath) {
      console.log('[firestore] GOOGLE_APPLICATION_CREDENTIALS not set - running OFFLINE');
      console.log('[firestore] engine works fully; only app sync is disabled');
      return false;
    }

    try {
      const admin = await import('firebase-admin');
      const app = admin.default.initializeApp({
        credential: admin.default.credential.cert(JSON.parse(readFileSync(keyPath, 'utf8')))
      });
      db = admin.default.firestore(app);
      FieldValue = admin.default.firestore.FieldValue;
      console.log('[firestore] connected');
      return true;
    } catch (err) {
      console.error('[firestore] init failed, falling back to OFFLINE:', err.message);
      db = null;
      return false;
    }
  },

  /**
   * Credential registry. Reads Firestore when connected, local JSON otherwise.
   */
  async loadCredentials() {
    if (!db) return localCredentials;

    const snap = await db.collection('credentials').get();
    if (snap.empty) {
      console.warn('[firestore] credentials collection empty - run `npm run seed`');
      return localCredentials;
    }
    return snap.docs.map((d) => ({ credential_id: d.id, ...d.data() }));
  },

  /**
   * Watch the registry for changes. This is how the app's one-tap revoke reaches
   * the engine: app writes credentials/{id}.revoked = true, we hear it here.
   */
  watchCredentials(onChange) {
    if (!db) return () => {};

    return db.collection('credentials').onSnapshot(
      (snap) => {
        onChange(snap.docs.map((d) => ({ credential_id: d.id, ...d.data() })));
      },
      (err) => console.error('[firestore] credential watch error:', err.message)
    );
  },

  /** Only anomalies are written per-event. Normal scans never touch Firestore. */
  async writeAnomaly(anomaly) {
    if (!db) return null;

    const doc = await db.collection('anomalies').add({
      ...anomaly,
      status: 'OPEN',
      created_at: FieldValue.serverTimestamp()
    });
    return doc.id;
  },

  async setRevoked(credentialId, revoked) {
    if (!db) return;
    await db.collection('credentials').doc(credentialId).set({ revoked }, { merge: true });
  },

  async seedDoors(doors) {
    if (!db) throw new Error('Firestore not configured');
    const batch = db.batch();
    for (const d of doors) {
      batch.set(db.collection('doors').doc(d.door_id), d, { merge: true });
    }
    await batch.commit();
  },

  async seedCredentials(list) {
    if (!db) throw new Error('Firestore not configured');
    const batch = db.batch();
    for (const c of list) {
      const { credential_id, ...rest } = c;
      batch.set(db.collection('credentials').doc(credential_id), rest, { merge: true });
    }
    await batch.commit();
  }
};

/**
 * Counters for the dashboard header, flushed on a timer rather than per-event.
 * The Firestore free tier allows 20k writes/day; writing every scan would burn
 * it in hours, and the counters only need to look live to a human.
 */
const FLUSH_MS = 10_000;
let pending = { scans: 0, anomalies: 0 };
let dirty = false;

export const stats = {
  bumpScan() {
    pending.scans += 1;
    dirty = true;
  },
  bumpAnomaly() {
    pending.anomalies += 1;
    dirty = true;
  },
  snapshot: () => ({ ...pending }),

  startFlushing() {
    const timer = setInterval(async () => {
      if (!dirty || !db) return;
      dirty = false;
      try {
        await db.collection('stats').doc('live').set(
          {
            scans_total: pending.scans,
            anomalies_total: pending.anomalies,
            updated_at: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      } catch (err) {
        console.error('[firestore] stats flush failed:', err.message);
      }
    }, FLUSH_MS);
    timer.unref();
    return timer;
  }
};
