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
import { doorById } from './graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const localCredentials = JSON.parse(readFileSync(join(here, 'credentials.json'), 'utf8'));

let db = null;
let FieldValue = null;
let messaging = null;

/** Every phone with the app subscribes to this one topic. No device registry. */
const ALERT_TOPIC = 'anomalies';

/** Door name for the notification text. Falls back to the raw id, never blank. */
const doorName = (id) => doorById[id]?.name ?? id;

/**
 * Fire-and-forget push to every phone on the topic. Swallows its own errors:
 * a dead FCM must not make a successful anomaly write look failed.
 */
async function pushAnomaly(anomalyId, a) {
  if (!messaging) return;

  try {
    await messaging.send({
      topic: ALERT_TOPIC,
      notification: {
        title: `Impossible travel - ${a.person_name}`,
        body:
          `${doorName(a.from.door_id)} to ${doorName(a.to.door_id)} in ${a.observed_s}s ` +
          `(minimum ${a.required_s}s) - ${a.severity}x`
      },
      // FCM rejects non-string data values. Everything here must be a string.
      data: {
        anomaly_id: anomalyId,
        kind: String(a.kind),
        person_id: String(a.person_id)
      },
      android: { priority: 'high' }
    });
  } catch (err) {
    console.error('[fcm] push failed:', err.message);
  }
}

/**
 * Empties a collection in pages. Firestore caps a batch at 500 writes, and
 * recursiveDelete() is version-dependent - this form works on any admin SDK.
 */
async function emptyCollection(name) {
  let removed = 0;
  for (;;) {
    const snap = await db.collection(name).limit(300).get();
    if (snap.empty) return removed;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    removed += snap.size;
  }
}

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
      messaging = admin.default.messaging(app);
      console.log('[firestore] connected');
      return true;
    } catch (err) {
      console.error('[firestore] init failed, falling back to OFFLINE:', err.message);
      db = null;
      messaging = null;
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

    // Push is best-effort and must never fail the write. server.js catches only
    // the outer promise, so an FCM error escaping here would log a successful
    // anomaly as a failed one.
    await pushAnomaly(doc.id, anomaly);

    return doc.id;
  },

  /**
   * Amber findings, kept in their own collection so the app can show them in a
   * separate queue. A red alert wakes someone up; these do not.
   */
  async writeReview(item) {
    if (!db) return null;

    const doc = await db.collection('reviews').add({
      ...item,
      status: 'OPEN',
      created_at: FieldValue.serverTimestamp()
    });
    return doc.id;
  },

  async setRevoked(credentialId, revoked) {
    if (!db) return;
    await db.collection('credentials').doc(credentialId).set({ revoked }, { merge: true });
  },

  /**
   * Destructive demo reset. Empties the two output collections and lifts every
   * revocation, so a rehearsal leaves no trace in the phone's feed.
   *
   * Never touches `doors`, and never deletes a `credentials` document - only the
   * `revoked` field on one. Deleting the registry would turn every later scan
   * into UNKNOWN_CREDENTIAL and kill detection silently.
   *
   * Un-revoke iterates the Firestore collection rather than store.listCredentials(),
   * and uses update() rather than set({merge:true}) on purpose: a merge-set onto a
   * MISSING doc creates it, and the Admin SDK bypasses the `allow create: if false`
   * rule that normally blocks exactly that. update() fails NOT_FOUND instead.
   *
   * Offline is a supported mode, so this returns zeros rather than throwing.
   */
  async purge() {
    if (!db) return { anomalies: 0, reviews: 0, unrevoked: 0 };

    const anomalies = await emptyCollection('anomalies');
    const reviews = await emptyCollection('reviews');

    const snap = await db.collection('credentials').get();
    const stillRevoked = snap.docs.filter((d) => d.data().revoked === true);
    if (stillRevoked.length) {
      const batch = db.batch();
      stillRevoked.forEach((d) => batch.update(d.ref, { revoked: false }));
      await batch.commit();
    }

    return { anomalies, reviews, unrevoked: stillRevoked.length };
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
let pending = { scans: 0, anomalies: 0, reviews: 0 };
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
  bumpReview() {
    pending.reviews += 1;
    dirty = true;
  },
  snapshot: () => ({ ...pending }),

  /**
   * Zeroes the counters, both halves. The flush below writes ABSOLUTE totals from
   * `pending`, so clearing only the Firestore doc means the old numbers reappear
   * within FLUSH_MS of the next scan. Clearing `dirty` drops the flush already
   * queued for the pre-purge values.
   */
  reset() {
    pending = { scans: 0, anomalies: 0, reviews: 0 };
    dirty = false;
    if (!db) return Promise.resolve();
    return db.collection('stats').doc('live').set(
      {
        scans_total: 0,
        anomalies_total: 0,
        reviews_total: 0,
        updated_at: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  },

  startFlushing() {
    const timer = setInterval(async () => {
      if (!dirty || !db) return;
      dirty = false;
      try {
        await db.collection('stats').doc('live').set(
          {
            scans_total: pending.scans,
            anomalies_total: pending.anomalies,
            reviews_total: pending.reviews,
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
