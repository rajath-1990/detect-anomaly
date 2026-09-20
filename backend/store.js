/**
 * Hot-path state. Process-local, in-memory, sub-microsecond.
 *
 * This is the ONLY stateful module. Swapping to Redis for multi-instance
 * deployment means reimplementing these five functions against ioredis and
 * changing nothing else.
 *
 * Note the detection key is person_id, not credential_id: physics applies to
 * bodies. One employee with a badge AND a mobile key is still one body, so a
 * badge-then-mobile collision at two distant doors must be caught too.
 */

/** person_id -> { door_id, ts, via_cred } */
const lastSeen = new Map();

/** credential_id -> { person_id, person_name, type, shared } */
const credentials = new Map();

/** credential_ids that have been killed */
const revoked = new Set();

export const store = {
  getLastSeen: (personId) => lastSeen.get(personId),

  setLastSeen: (personId, state) => lastSeen.set(personId, state),

  getCredential: (credId) => credentials.get(credId),

  /** Replaces the whole registry. Called at boot and on any Firestore change. */
  loadCredentials(list) {
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
    credentials: credentials.size,
    revoked: revoked.size
  }),

  /** Demo only. Clears tracked positions so the attack can be replayed. */
  clearLastSeen() {
    const n = lastSeen.size;
    lastSeen.clear();
    return n;
  }
};
