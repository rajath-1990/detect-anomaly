/**
 * Tier B - plausibility rules.
 *
 * The velocity check in engine.js is Tier A: a proof. It only ever fires on
 * "too fast to walk", so a red alert is physics and can safely auto-revoke.
 *
 * But physics only catches attackers who are in a hurry. A cloned badge used
 * hours after the real holder's last scan is a legal walk. A badge used at 3am
 * while its owner is asleep never collides with anything at all. Neither leaves
 * a velocity signature, and no amount of tuning the threshold will find them.
 *
 * These rules find that second class. They are NOT proofs - a tailgating
 * employee trips the first one honestly - so they emit REVIEW, land in an amber
 * queue, and never revoke a credential on their own. That division is the point:
 * it buys coverage without spending the zero-false-positive claim that makes the
 * red path worth trusting.
 *
 * Scope is deliberately narrow. Only doors marked `sensitivity: high` in
 * doors.json opt in, because amber that nobody reads is worth less than no amber
 * at all.
 */

export const REVIEW = {
  /** Interior scan with no perimeter entry on record - the body got in unbadged. */
  NO_ENTRY_PATH: 'NO_ENTRY_PATH',
  /** Sensitive door opened outside its expected hours. */
  OFF_HOURS: 'OFF_HOURS',
  /** This person has never opened this sensitive door before. */
  FIRST_USE: 'FIRST_USE'
};

/**
 * Must be called BEFORE the store is updated for this event - both FIRST_USE and
 * NO_ENTRY_PATH ask what was true immediately before the scan.
 *
 * @param {{ door_id: string, ts: number }} evt
 * @param {{ person_id: string, person_name: string, shared: boolean }} cred
 * @param {object} door           node from doors.json
 * @param {object} store
 * @returns {Array<{ rule: string, detail: string }>}
 */
export function review(evt, cred, door, store) {
  if (!door || door.sensitivity !== 'high') return [];

  const findings = [];

  if (Array.isArray(door.hours)) {
    const [open, close] = door.hours;
    // `demo_hour` is server.js's demo clock (POST /debug/clock, DEMO_MODE only).
    // It exists because this is the one rule a daytime demo cannot reach. It
    // pins the HOUR only - `evt.ts` stays the real ingest stamp, because that
    // stamp is also Tier A's `observed`, store.setLastSeen's monotonic guard and
    // store.getSession's 4h window. Faking `ts` instead would break all three.
    const hour = Number.isInteger(evt.demo_hour) ? evt.demo_hour : new Date(evt.ts).getHours();
    if (hour < open || hour >= close) {
      findings.push({
        rule: REVIEW.OFF_HOURS,
        detail: `opened at ${String(hour).padStart(2, '0')}:00, expected ` +
                `${String(open).padStart(2, '0')}:00-${String(close).padStart(2, '0')}:00`
      });
    }
  }

  // The remaining rules are person-level. Pooled credentials belong to a role,
  // not a body: many people legitimately use them and none of them has a
  // personal history, so both rules would be noise. Same exemption the physics
  // check makes, for the same reason.
  if (cred.shared) return findings;

  if (!store.getSession(cred.person_id, evt.ts)) {
    findings.push({
      rule: REVIEW.NO_ENTRY_PATH,
      detail: 'no perimeter entry on record for this session'
    });
  }

  if (!store.hasUsedDoor(cred.person_id, evt.door_id)) {
    findings.push({
      rule: REVIEW.FIRST_USE,
      detail: 'first time this person has opened this door'
    });
  }

  return findings;
}
