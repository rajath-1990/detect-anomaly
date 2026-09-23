/**
 * The velocity anomaly engine.
 *
 * A badge reader asks one question: "is this credential valid?" A cloned badge
 * passes that at every door. This asks the second question: "could this person
 * physically be here right now?"
 *
 * Two numbers decide it:
 *   observed  - seconds actually elapsed since this person's last scan
 *   required  - minimum seconds the walk between those two doors takes
 *
 * observed < required means nobody walked that. Either the credential was
 * copied, or it was handed off. Both are what we are hunting.
 *
 * Only "too fast" ever flags. Slower than the minimum is always fine - people
 * stop, chat, get coffee. So false positives can only come from bad graph data
 * or bad clocks, never from users behaving like users.
 *
 * TWO TIERS, and the split is load-bearing:
 *
 *   ANOMALY (Tier A, below)  the velocity check. A proof. Auto-revokes.
 *   REVIEW  (Tier B, rules.js) plausibility heuristics for attackers patient
 *                              enough to leave no velocity signature. Amber
 *                              queue, never revokes.
 *
 * Nothing heuristic may ever return ANOMALY. That is what keeps "a revoked
 * badge is always provably impossible" true.
 */

import { minTravelSeconds, doorById } from './graph.js';
import { store } from './store.js';
import { review } from './rules.js';

/**
 * Required travel time is multiplied by this before comparing. 0.8 means a scan
 * must be 20% faster than the theoretical minimum before we call it impossible,
 * absorbing reader latency and generous graph estimates.
 *
 * The margin is free: a cloned badge is not 10% faster than a human, it is 20-30x
 * faster. There is an enormous gap to sit in.
 */
const TOLERANCE = 0.8;

export const KIND = {
  CLONED: 'CLONED_CREDENTIAL',
  SHARED: 'CREDENTIAL_SHARED_OR_STOLEN'
};

/**
 * @param {{ credential_id: string, door_id: string, ts: number }} evt
 *        `ts` is stamped server-side at ingest, never taken from the reader.
 */
export function evaluate(evt) {
  const cred = store.getCredential(evt.credential_id);

  if (!cred) {
    return { verdict: 'UNKNOWN_CREDENTIAL', check: 'UNKNOWN_CREDENTIAL' };
  }

  const door = doorById[evt.door_id];

  // --- Tier A: physics ------------------------------------------------------

  // Pooled credentials - visitor passes, contractor badges, the one kept on a
  // hook at the loading dock - belong to a role, not a person. Many bodies use
  // them legitimately every day, so person-level physics does not apply.
  // `check` says WHICH of the OK cases this is, and rides on its own key. It is
  // deliberately NOT folded onto `reason`: the REVIEW object below copies
  // `reason`, and that field now has to stay a short, stable enum value because
  // it is what the phone's amber card reads. `check` is console detail.
  let result = cred.shared
    ? { verdict: 'OK', reason: 'POOLED_CREDENTIAL', check: 'POOLED_CREDENTIAL' }
    : { verdict: 'OK', check: 'FIRST_SCAN' };

  const prev = cred.shared ? null : store.getLastSeen(cred.person_id);

  // No previous scan: nothing to compare against.
  // Same door twice: a fumbled badge tap, not movement. Skip both.
  if (prev && prev.door_id === evt.door_id) {
    result.check = 'SAME_DOOR';
  } else if (prev) {
    const observed = (evt.ts - prev.ts) / 1000;
    const required = minTravelSeconds(prev.door_id, evt.door_id);

    // These two were computed on every legal walk and thrown away. The console
    // cannot re-derive them - only the engine knows `prev` - and a second copy
    // of the physics in the browser is exactly what CLAUDE.md forbids.
    // `flags_under_s` ships the threshold so TOLERANCE never leaves this file:
    // showing required_s alone renders "took 22.0s, minimum 25.0s, legal",
    // which contradicts itself.
    result.check        = observed > 0 ? 'LEGAL_WALK' : 'OUT_OF_ORDER';
    result.from_door_id = prev.door_id;
    result.observed_s   = +observed.toFixed(2);
    result.required_s   = required;
    result.flags_under_s = +(required * TOLERANCE).toFixed(1);

    // observed <= 0 means events arrived out of order. Do not treat network
    // jitter as an attack. `observed` is the RAW float here on purpose -
    // rounding before this comparison would change which scans flag.
    if (observed > 0 && observed < required * TOLERANCE) {
      result = {
        verdict: 'ANOMALY',

        // Same credential at both doors -> it was copied, and the real holder
        // still has theirs. Different credentials, same person -> one of the
        // two is in the wrong hands. Different remediation, so the alert has
        // to distinguish them.
        kind: prev.via_cred === evt.credential_id ? KIND.CLONED : KIND.SHARED,

        person_id: cred.person_id,
        person_name: cred.person_name,
        from: { door_id: prev.door_id, credential_id: prev.via_cred, ts: prev.ts },
        to: { door_id: evt.door_id, credential_id: evt.credential_id, ts: evt.ts },
        observed_s: +observed.toFixed(2),
        required_s: required,
        severity: +(required / Math.max(observed, 0.001)).toFixed(1)
      };
    }
  }

  // --- Tier B: plausibility -------------------------------------------------

  // Only when physics has not already spoken. Red outranks amber: an alert that
  // says both "impossible" and "unusual" buries the half that matters.
  // Evaluated before the state updates below, because both rules ask what was
  // true immediately BEFORE this scan.
  if (result.verdict !== 'ANOMALY') {
    const findings = review(evt, cred, door, store);
    if (findings.length > 0) {
      result = {
        verdict: 'REVIEW',
        // Never undefined. Firestore rejects an undefined field, so writeReview
        // used to throw on every non-pooled review and server.js swallowed it -
        // the `reviews` collection could only ever hold pooled-pass docs. The
        // dedupe in server.js is what replaces that accidental volume guard.
        reason: result.reason ?? 'TIER_B_REVIEW',
        person_id: cred.person_id,
        person_name: cred.person_name,
        credential_id: evt.credential_id,
        door_id: evt.door_id,
        ts: evt.ts,
        findings
      };
    }
  }

  // --- state ----------------------------------------------------------------

  // Pooled credentials never update position: they are not a body to track, and
  // writing one would corrupt the next real holder's physics.
  if (!cred.shared) {
    // A perimeter scan is the body entering the boundary. Everything inside is
    // vouched for by it until the session goes idle.
    if (door?.perimeter) store.openSession(cred.person_id, evt.door_id, evt.ts);

    store.setLastSeen(cred.person_id, {
      door_id: evt.door_id,
      ts: evt.ts,
      via_cred: evt.credential_id
    });
    store.markDoorUsed(cred.person_id, evt.door_id);
  }

  return result;
}
