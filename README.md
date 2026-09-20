# Impossible-Travel Access Anomaly Engine

Badge readers ask one question: *is this credential valid?* A cloned badge passes
that at every door, producing two entirely normal-looking log entries.

This asks the second question: **could this person physically be here right now?**

Lobby at 10:00:00, Server Room at 10:00:04. That walk is 110 seconds minimum —
elevator, third floor hall, two corridors. Four seconds is not a fast employee.
It is two badges.

---

## Run it

No Firebase needed for the engine.

```bash
cd backend && npm install && node server.js
```

Open **http://localhost:8000** — operator console. Pick a credential, click a door,
that's a scan. Scripted attacks are buttons. Live feed over SSE, alert cards with
one-tap revoke. A judge can drive it.

Terminal route works too:

```bash
cd sim && node attack.js
```

Expect `ANOMALY / CLONED_CREDENTIAL`, ~27x impossible.

### Scenarios

| Command | What it proves |
|---|---|
| `node attack.js` | cloned badge — same credential, two distant doors |
| `node attack.js --steal` | badge here, mobile key there, **same person** — caught because state is keyed by person, not credential |
| `node attack.js --pooled` | control: visitor passes are exempt and must **not** alert |
| `node normal.js` | realistic background traffic — must produce **zero** anomalies |

State carries between runs, so reset positions between rehearsals:

```bash
curl -X POST http://localhost:8000/debug/reset
```

### Close the loop

```bash
curl -X POST http://localhost:8000/credentials/B-4471/revoke
```

Then replay the attack — the first scan returns `DENY / REVOKED`. The attack
cannot proceed.

---

## How it works

Per **person** (not per credential — physics applies to bodies), the engine keeps
one thing: last door and timestamp. On each scan it compares two numbers:

- `observed` — seconds actually elapsed
- `required` — minimum walk seconds between those two doors

`observed < required * 0.8` → nobody walked that.

`required` comes from a **door adjacency graph**, not straight-line distance.
Two doors 5m apart through a wall are a 90-second walk; geofencing math gets that
wrong and this does not. Floyd–Warshall runs once at boot, so every lookup is O(1).

**Only "too fast" ever flags.** Slower than the minimum is always fine — people
stop, chat, get coffee. So false positives can only come from bad graph data or
bad clocks, never from users behaving like users.

```
sim/normal.js  ─┐
sim/attack.js  ─┴─ POST /events ──►  backend
                                       ├─ graph.js     walk times, precomputed
                                       ├─ store.js     in-memory hot state
                                       ├─ engine.js    the velocity check
                                       └─ firestore.js anomalies out, revokes in
                                               │  ▲
                                               ▼  │
                                            Firestore
                                               │  ▲
                              realtime listener│  │ one-tap revoke
                                               ▼  │
                                     Android Compose app
```

The Android app talks **only to Firebase** — it never learns this backend's
address. That is why there is no WebSocket server, no LAN IP configuration, and
no dependency on the venue wifi.

---

## Firebase (optional — engine runs fully without it)

1. Firebase console → new project → enable Firestore
2. Project settings → Service accounts → generate private key
3. `cp backend/.env.example backend/.env`, set `GOOGLE_APPLICATION_CREDENTIALS`
4. `cd backend && npm run seed`

Without it the backend logs `running OFFLINE`, loads `credentials.json` from disk,
and every scenario above still works.

**Quota:** Firestore free tier is 20k writes/day. Only anomalies are written per
event; normal scans never touch it. Do not leave `normal.js` running overnight.

---

## Scope

| | |
|---|---|
| Built | velocity engine, door graph, person-level keying, pooled-credential exemption, revoke loop, both simulators, operator console |
| Not yet | Android Compose app, FCM, Azure pipeline, architecture diagram |

### Known boundaries

- **Locks do not call this API.** The real chain is lock → reader → door
  controller → access-control head-end → here. We subscribe to the event stream
  that already exists — no new hardware, no rewiring. `sim/` stands in for that feed.
- **Door coordinates come from our registry, not the lock.** Locks have no GPS.
- **Offline / scheduled-sync locks are not real-time.** The same engine runs
  against the audit trail at sync time, giving forensic rather than live detection.
- **We alert, we do not gate the door.** Revoke changes credential state in the
  system that decides — sub-second effect, without this service becoming a single
  point of failure for a fire exit.
- **This does not catch tailgating.** No second scan exists, so there is nothing
  to compare. One specific blind spot closed completely, not magic.
