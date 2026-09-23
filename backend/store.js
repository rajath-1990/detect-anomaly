/**
 * Hot-path state. Process-local, in-memory, sub-microsecond.
 *
 * This is the ONLY stateful module. Swapping to Redis for multi-instance
 * deployment means reimplementing these functions against ioredis and changing
 * nothing else. `persistence.js` serialises this module and nothing else.
 *
 * Note the detection key is person_id, not credential_id: physics applies to
 * bodies. One employee with a badge AND a mobile key is still one body, so a
 * badge-then-mobile collision at two distant doors must be caught too.
 */

/**
 * A presence session ends after this long without any scan. No exit readers
 * exist, so "left the building" has to be inferred from silence. Long enough to
 * cover a full shift plus lunch; short enough that yesterday's session does not
 * vouch for today's scan.
 */
const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;

/** Restored state older than this is dropped at boot - positions, not fossils. */
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** person_id -> { door_id, ts, via_cred } */
const lastSeen = new Map();

/** person_id -> { entry_door, entered_ts } - open when they badged in at a perimeter door */
const sessions = new Map();

/** person_id -> Set(door_id) ever used. Backs the first-use plausibility rule. */
const doorHistory = new Map();

/**
 * person_id -> Map(`door|RULE,RULE` -> ts) of amber findings already written out.
 *
 * Tier B does not deduplicate by design - NO_ENTRY_PATH honestly re-fires on
 * every sensitive-door scan until the session idles - and that is fine for the
 * console, where the flicker is the signal. It is NOT fine for Firestore: one
 * doc per scan buries the phone's queue and burns the free tier. Same 4h
 * lifetime as a session, so a genuinely new visit alerts again.
 */
const reviewsWritten = new Map();

/** credential_id -> { person_id, person_name, type, shared } */
const credentials = new Map();

/** credential_ids that have been killed */
const revoked = new Set();

/** Set by any mutation worth persisting; consumed by the snapshot timer. */
let dirty = false;

export const store = {
  getLastSeen: (personId) => lastSeen.get(personId),

  /**
   * Refuses to move a position backwards in time. Server-stamped events are
   * always monotonic, but batched or reader-stamped delivery is not, and a stale
   * event overwriting a fresh position would hide the very next real anomaly.
   */
  setLastSeen(personId, state) {
    const prev = lastSeen.get(personId);
    if (prev && state.ts < prev.ts) return false;
    lastSeen.set(personId, state);
    dirty = true;
    return true;
  },

  /**
   * The person's open presence session, or null. A session is only as alive as
   * the person's last scan - silence past SESSION_IDLE_MS closes it.
   */
  getSession(personId, now = Date.now()) {
    const s = sessions.get(personId);
    if (!s) return null;
    const reference = lastSeen.get(personId)?.ts ?? s.entered_ts;
    if (now - reference > SESSION_IDLE_MS) {
      sessions.delete(personId);
      return null;
    }
    return s;
  },

  /** Called when a perimeter door is scanned: the body is now accounted for inside. */
  openSession(personId, entryDoor, ts) {
    sessions.set(personId, { entry_door: entryDoor, entered_ts: ts });
    dirty = true;
  },

  hasUsedDoor: (personId, doorId) => doorHistory.get(personId)?.has(doorId) ?? false,

  markDoorUsed(personId, doorId) {
    let set = doorHistory.get(personId);
    if (!set) doorHistory.set(personId, (set = new Set()));
    if (!set.has(doorId)) {
      set.add(doorId);
      dirty = true;
    }
  },

  /**
   * True the FIRST time this person trips this exact finding set at this door
   * within a session's lifetime, false every repeat. Records as it answers, so
   * it is called once per scan and only on the write path.
   *
   * The findings are sorted into the key: OFF_HOURS+NO_ENTRY_PATH+FIRST_USE and
   * the same scan a second later without FIRST_USE are different situations and
   * each deserves one doc.
   */
  shouldWriteReview(personId, doorId, findings, now = Date.now()) {
    const key = `${doorId}|${findings.map((f) => f.rule).sort().join(',')}`;

    let seen = reviewsWritten.get(personId);
    if (!seen) reviewsWritten.set(personId, (seen = new Map()));

    const last = seen.get(key);
    if (last !== undefined && now - last <= SESSION_IDLE_MS) return false;

    seen.set(key, now);
    dirty = true;
    return true;
  },

  getCredential: (credId) => credentials.get(credId),

  /**
   * Replaces the whole registry. Called at boot and on any Firestore change.
   * An empty list is refused: a transient bad snapshot would otherwise turn every
   * credential UNKNOWN and silently drop every revocation.
   */
  loadCredentials(list) {
    if (!Array.isArray(list) || list.length === 0) {
      console.warn('[store] refused empty credential list - keeping current registry');
      return false;
    }
    credentials.clear();
    revoked.clear();
    for (const c of list) {
      credentials.set(c.credential_id, {
        person_id: c.person_id,
        person_name: c.person_name,
        type: c.type,
        shared: Boolean(c.shared)
      });
      if (c.revoked) revoked.add(c.credential_id);
    }
    return true;
  },

  isRevoked: (credId) => revoked.has(credId),

  /** Registry for the operator console. */
  listCredentials: () =>
    [...credentials.entries()].map(([credential_id, c]) => ({
      credential_id,
      ...c,
      revoked: revoked.has(credential_id)
    })),

  setRevoked(credId, value) {
    if (value) revoked.add(credId);
    else revoked.delete(credId);
  },

  stats: () => ({
    people_tracked: lastSeen.size,
    sessions_open: sessions.size,
    credentials: credentials.size,
    revoked: revoked.size
  }),

  /** True once since the last call. Drives the debounced snapshot. */
  consumeDirty() {
    const was = dirty;
    dirty = false;
    return was;
  },

  /**
   * Everything worth surviving a restart. Revocations are deliberately excluded:
   * they live in Firestore (or credentials.json), which is already the registry's
   * source of truth - persisting them here would give them two.
   */
  snapshot: () => ({
    saved_at: Date.now(),
    last_seen: [...lastSeen.entries()],
    sessions: [...sessions.entries()],
    door_history: [...doorHistory.entries()].map(([p, set]) => [p, [...set]]),
    // Without this a restart re-opens the amber floodgate: every suppressed
    // finding writes a fresh doc on the next scan.
    reviews_written: [...reviewsWritten.entries()].map(([p, m]) => [p, [...m]])
  }),

  /** Inverse of snapshot(). Returns how many people were restored. */
  restore(snap, now = Date.now()) {
    if (!snap || now - (snap.saved_at ?? 0) > STATE_TTL_MS) return 0;

    for (const [person, state] of snap.last_seen ?? []) {
      if (now - state.ts <= STATE_TTL_MS) lastSeen.set(person, state);
    }
    for (const [person, s] of snap.sessions ?? []) {
      if (now - s.entered_ts <= STATE_TTL_MS) sessions.set(person, s);
    }
    for (const [person, list] of snap.door_history ?? []) {
      doorHistory.set(person, new Set(list));
    }
    for (const [person, entries] of snap.reviews_written ?? []) {
      const fresh = entries.filter(([, ts]) => now - ts <= SESSION_IDLE_MS);
      if (fresh.length) reviewsWritten.set(person, new Map(fresh));
    }
    return lastSeen.size;
  },

  /**
   * Demo only. Forgets everything person-level so an attack can be replayed:
   * positions, sessions and door history all have to go, or the replay's first
   * scan is no longer that person's first scan.
   */
  clearLastSeen() {
    const n = lastSeen.size;
    lastSeen.clear();
    sessions.clear();
    doorHistory.clear();
    reviewsWritten.clear();
    dirty = true;
    return n;
  }
};
