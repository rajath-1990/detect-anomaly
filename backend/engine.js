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
 */

import { minTravelSeconds } from './graph.js';
import { store } from './store.js';

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
    return { verdict: 'UNKNOWN_CREDENTIAL' };
  }

  // Pooled credentials - visitor passes, contractor badges, the one kept on a
  // hook at the loading dock - belong to a role, not a person. Many bodies use
  // them legitimately every day, so person-level physics does not apply.
  if (cred.shared) {
    return { verdict: 'OK', reason: 'POOLED_CREDENTIAL' };
  }

  const prev = store.getLastSeen(cred.person_id);
  let result = { verdict: 'OK' };

  // No previous scan: nothing to compare against.
  // Same door twice: a fumbled badge tap, not movement. Skip both.
  if (prev && prev.door_id !== evt.door_id) {
    const observed = (evt.ts - prev.ts) / 1000;
    const required = minTravelSeconds(prev.door_id, evt.door_id);

    // observed <= 0 means events arrived out of order. Do not treat network
    // jitter as an attack.
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

  store.setLastSeen(cred.person_id, {
    door_id: evt.door_id,
    ts: evt.ts,
    via_cred: evt.credential_id
  });

  return result;
}
