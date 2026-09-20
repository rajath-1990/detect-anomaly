# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A physical-access-control anomaly engine for an Allegion hackathon. It detects *impossible travel*:
one person's credential appearing at two doors faster than the walk between them allows — a cloned
badge, or a credential handed off. Alert + revoke, never gate the door.

## Commands

```bash
cd backend && npm install        # only backend has dependencies
cd backend && node server.js     # ingest API + operator console on :8000
```

Then open **http://localhost:8000** — the operator console (pick a credential, click a door, scripted
attack buttons, live feed over SSE).

```bash
cd backend && node graph.js      # print the all-pairs walk-time matrix
cd backend && npm run seed       # push doors + credentials to Firestore (needs GOOGLE_APPLICATION_CREDENTIALS)

cd sim && node normal.js         # background traffic; must produce ZERO anomalies
cd sim && node attack.js         # cloned badge  -> ANOMALY / CLONED_CREDENTIAL
cd sim && node attack.js --steal # badge + mobile, same person -> CREDENTIAL_SHARED_OR_STOLEN
cd sim && node attack.js --pooled# visitor pass control -> must NOT alert
```

Both sims take `--url=` and `--gap=` / `--rate=`.

```bash
curl -X POST http://localhost:8000/debug/reset          # forget tracked positions, replay an attack
curl -X POST http://localhost:8000/credentials/B-4471/revoke
```

**Windows:** `pkill` and `kill` do not reliably stop node under Git Bash — a "restart" silently leaves
the old server bound and the new one dies on `EADDRINUSE`. Use:

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## No test framework

Verification is the simulators, in this order — steps 1–4 need no Firebase and no phone:

1. `node graph.js` — `D-LOBBY` → `D-SERVER` must be **110s** (25+55+30); matrix symmetric
2. `node attack.js` — `ANOMALY / CLONED_CREDENTIAL`, ~27× severity
3. `node attack.js --steal` — `CREDENTIAL_SHARED_OR_STOLEN` (proves person-level keying)
4. `node normal.js` for several minutes — **zero** anomalies. Any hit means a `doors.json` edge is
   overestimated, not that the engine is wrong
5. revoke → replay attack → first scan returns `{"decision":"DENY","reason":"REVOKED"}`

## Architecture

```
sim/*.js, operator console  ──POST /events──►  backend
                                                ├─ graph.js     Floyd–Warshall at boot, O(1) lookups
                                                ├─ store.js     in-memory hot state  ◄── only stateful module
                                                ├─ engine.js    the velocity check   ◄── the IP, ~40 lines
                                                └─ firestore.js anomalies out, revocations in
                                                        │  ▲
                                                     Firestore
                                                        │  ▲  realtime listener / one-tap revoke
                                                  Android app (not built yet)
```

Two npm packages, no workspace root. `sim/` has **no dependencies** — its `package.json` exists only to
set `"type": "module"`, and it imports `../backend/graph.js` directly.

### Decisions that are load-bearing

**Detection is keyed by `person_id`, not `credential_id`.** Physics applies to bodies. One employee with
a badge *and* a mobile key is one body, so a badge-here/mobile-there collision must be caught. The
registry (`credentials.json` or Firestore) maps credential → person. Changing this key breaks the
`--steal` scenario.

**`store.js` is the only stateful module.** Redis swap = reimplement its five functions, change nothing
else. Don't scatter state into other files.

**Only "too fast" ever flags.** `observed < required * 0.8`. Slower is always fine, so false positives
can only come from bad graph data or bad clocks — never from user behaviour. Preserve this property.

**`doors.json` edge weights are deliberately UNDERESTIMATED.** A generous floor means fast employees
never false-positive, while a clone is still 20–30× below it. When adding doors, underestimate.

**Timestamps are stamped server-side at ingest** (`server.js`), never taken from the reader. Reader
clocks drift; a reader 60s behind its neighbour would manufacture anomalies.

**Revoked credentials bypass the engine *and* do not update last-seen.** Deliberate: a killed badge must
not poison the tracked position of the employee still carrying their other credential.

**No WebSocket anywhere.** The operator console uses SSE (`/stream`); the Android app is meant to listen
to Firestore directly, so it never needs the backend's address. Don't reintroduce one.

**Firestore degrades to offline.** Missing `GOOGLE_APPLICATION_CREDENTIALS` is a supported mode, not an
error — the engine loads `credentials.json` from disk and every scenario still works. Keep it that way.

### Engine edge cases — each one breaks the demo if removed

- same door repeated → skip (fumbled badge taps would alert constantly)
- first-ever scan → no prior, store and return OK
- `observed <= 0` (out-of-order delivery) → not an anomaly
- `shared: true` credentials (visitor/contractor passes) → exempt from person-level physics
- `kind` distinguishes `CLONED_CREDENTIAL` (same credential — it was copied) from
  `CREDENTIAL_SHARED_OR_STOLEN` (different credentials, same person — revoking both locks out the real
  employee)

### Simulator invariants

`sim/normal.js` is the false-positive test, so it must **never** be able to produce an anomaly:

- every move waits ≥ 1.4× the edge's minimum walk time
- neighbour choice is weighted by `1/seconds`, or the 900s inter-building edge parks half the walkers
- `ATTACK_PERSON` (`E-1123`, Ravi Sharma) is excluded — the sim tracks its own idea of each walker's
  position, so simulating the attack subject fires a false anomaly right after the attack lands
- **two copies running at once generate false anomalies** — same reason

## Known boundaries (say these before judges ask)

- Locks don't call this API. Real chain: lock → reader → controller → head-end → a connector you write →
  here. `sim/` stands in for that feed.
- Door coordinates come from `doors.json`, not the lock. Locks have no GPS.
- The door already opened locally at the controller before the engine sees the scan — hence alert +
  revoke, not block.
- Offline/scheduled-sync locks give forensic detection at sync time, not live.
- Tailgating is not detectable: no second scan, nothing to compare.

## Not built yet

`android/` Compose app, FCM, `azure-pipelines.yml`, architecture diagram.
