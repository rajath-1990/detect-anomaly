# Demo cheatsheet

Quick reference for standing in front of judges. Scannable, not prose.

---

## 10-second pitch

> A badge reader asks "is this card valid?" A cloned card passes that every time.
> We ask the second question: **"could this person's body actually be here right now?"**
> Badge at the lobby, same badge at the server room four seconds later — that walk takes
> 110 seconds. Nobody did that. The card was copied. Alert and revoke.

---

## Run it

```bash
cd backend && npm install && node server.js
```

Open **http://localhost:8000** — operator console. Pick a credential, click doors, or hit the
scripted attack buttons. Live feed over SSE.

| Command | Shows |
|---|---|
| `cd backend && node graph.js` | the walk-time matrix — `D-LOBBY`→`D-SERVER` must be **110** |
| `cd sim && node attack.js` | `ANOMALY / CLONED_CREDENTIAL`, ~27× severity |
| `cd sim && node attack.js --steal` | `CREDENTIAL_SHARED_OR_STOLEN` — proves person-level keying |
| `cd sim && node attack.js --pooled` | visitor pass — must **NOT** alert |
| `cd sim && node normal.js` | background traffic — must produce **zero** anomalies |

```bash
curl -X POST http://localhost:8000/debug/reset
curl -X POST http://localhost:8000/credentials/B-4471/revoke
```

**Windows — killing the server** (`pkill`/`kill` silently leave it bound, next start dies on `EADDRINUSE`):

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

---

## Numbers to quote

| Value | Where |
|---|---|
| `D-LOBBY` → `D-SERVER` = **110s** | 25 + 55 + 30, via elevator (stairs route is 120s, loses) |
| Tolerance = **0.8** | must be 20% faster than minimum before flagging |
| Clone severity ≈ **27×** | `required / observed` |
| **10** doors, **11** edges | `doors.json` |
| HQ ↔ Annex = **900s** | the only link between buildings |
| Session idle = **4h** | `SESSION_IDLE_MS` |
| Engine = **~40 lines** | `engine.js` — the actual IP |

---

## The algorithm

**Floyd–Warshall** — all-pairs shortest path. [`backend/graph.js:47-55`](backend/graph.js#L47)

```js
for (const k of ids) {          // stepping-stone door
  for (const i of ids) {        // start
    for (const j of ids) {      // end
      const viaK = dist[i][k] + dist[k][j];
      if (viaK < dist[i][j]) dist[i][j] = viaK;
    }
  }
}
```

One idea: **add two known walks to discover an unknown one.** Each round writes into the same
table the next round reads, so multi-hop routes fall out even though the code only ever adds two
numbers.

**"Why not Dijkstra / A\*?"**
- We need *every* pair, not one route. Dijkstra is single-source — 10 runs instead of 1.
- 10 doors → 1000 ops, **once at boot**. Every badge scan after that is an O(1) table read, never a
  pathfinder.
- 6 lines, no priority queue.

**"Why not GPS distance?"** Indoors, straight lines lie. Lobby and server room are metres apart on a
map, three floors and two minutes apart in reality. Walk seconds come from a human with a stopwatch.

---

## The detection, in full

[`backend/engine.js:75-81`](backend/engine.js#L75)

```js
const observed = (evt.ts - prev.ts) / 1000;
const required = minTravelSeconds(prev.door_id, evt.door_id);
if (observed > 0 && observed < required * 0.8) { /* ANOMALY */ }
```

One subtraction, one table lookup, one comparison.

**Only "too fast" ever flags.** Slower is always fine — people stop for coffee. So a false positive
can only come from bad graph data or bad clocks, never from a user behaving like a user.

---

## Three things that will get asked

**"Why key on person, not credential?"**
Physics applies to bodies. One employee with a badge *and* a mobile key is one body — badge here,
phone there is a real collision. Key it by credential and `--steal` goes undetected.

**"Why doesn't it block the door?"**
The controller already opened it locally before we saw the scan. So: alert + revoke, never gate.

**"What about a patient attacker?"**
Tier A (velocity) only catches attackers in a hurry. A clone used an hour later is a legal walk.
That's Tier B — [`rules.js`](backend/rules.js): `NO_ENTRY_PATH`, `OFF_HOURS`, `FIRST_USE`. Those are
**heuristics**, so they emit `REVIEW` (amber) and **never revoke**. That split is what keeps "a
revoked badge was provably impossible" true.

---

## Two tiers — say this clearly

| | Tier A — red | Tier B — amber |
|---|---|---|
| File | `engine.js` | `rules.js` |
| Basis | physics, a proof | plausibility, a guess |
| Verdict | `ANOMALY` | `REVIEW` |
| Action | **safe to revoke on** — a human taps it | queue only, never revokes |
| Catches | attacker in a hurry | patient attacker |
| Scope | all doors | `sensitivity: high` only (`D-SERVER`) |

Red outranks amber — when a scan matches both, only the anomaly is emitted.

---

## Architecture, one breath

```
sim / console ──POST /events──► server.js (stamps time server-side)
                                  ├─ graph.js       Floyd–Warshall at boot, O(1) lookups
                                  ├─ store.js       hot state ◄── only stateful module
                                  ├─ persistence.js snapshots to .state.json
                                  ├─ engine.js      the velocity check ◄── the IP
                                  ├─ rules.js       Tier B plausibility
                                  └─ firestore.js   anomalies out, revocations in
                                          │ ▲
                                      Firestore ──► Android app (realtime listen, one-tap revoke)
```

No WebSocket anywhere — SSE to the console, Firestore direct to the phone.
Firestore missing is a **supported mode**: falls back to `credentials.json` on disk, every scenario
still works.

---

## Say these before judges find them

- Locks don't call this API. Real chain: lock → reader → controller → head-end → a connector you
  write → here. `sim/` stands in for that feed.
- Door coordinates come from `doors.json`. Locks have no GPS.
- Offline / scheduled-sync locks **don't work today** — 40 queued scans land milliseconds apart at
  ingest and every pair reads as instantaneous. Fix is a per-reader EWMA clock offset plus a
  forensic path that reports without revoking. Not built.
- Tailgating isn't detectable as an intrusion — no second scan, nothing to compare. Tier B sees its
  *trace* later, if the tailgater then opens a sensitive door.
- Tier B doesn't deduplicate: re-trips `NO_ENTRY_PATH` on every sensitive-door scan until the
  session idles out.
- **Nothing is authenticated.** `POST /events` accepts injected scans; `POST /credentials/:id/revoke`
  is open — loop it and the building is locked out. First thing to fix before real deployment.
- A patient attacker still beats Tier A entirely. Coverage is layered, not complete.

---

## Demo order that works

1. `node graph.js` — show the matrix. "Nobody measured lobby→server. It's derived."
2. Console: walk a credential around normally. Green.
3. **Attack button** — red alert, ~27× severity. Tap **Revoke** on the phone card yourself; the
   engine never revokes on its own, and the console says so.
4. Replay the attack — first scan now returns `{"decision":"DENY","reason":"REVOKED"}`.
5. `--steal` — different credential, same person. `CREDENTIAL_SHARED_OR_STOLEN`.
6. `--pooled` — visitor pass moving impossibly fast. **No alert.** Explain why that's correct.
7. Restart the server mid-demo, scan again — still flags. `[state] restored N tracked positions`.

---

## If something breaks

| Symptom | Cause |
|---|---|
| `EADDRINUSE` | old node still bound — use the PowerShell kill above |
| `normal.js` throws anomalies | a `doors.json` edge is **overestimated**, or two copies of the sim are running |
| amber `REVIEW` lines during `normal.js` | **expected** — walkers start at random doors, most never badge a perimeter door |
| everything `UNKNOWN_CREDENTIAL` | credential registry failed to load |
| nothing detected after restart | `.state.json` missing or two server processes running |
