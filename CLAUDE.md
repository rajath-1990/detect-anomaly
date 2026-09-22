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

Then open **http://localhost:8000** — the operator console: a dark ops screen built around an **office
floor plan**. Rooms are the click targets and corridors carry their real walk seconds. Hovering a room
spells the walk out (`25s + 55s + 30s = 1m50s`). An anomaly puts a red **second body** of the same
person in the room it just opened, and you then **step through the route one corridor per click** at
whatever pace you are talking. Plus scripted attack buttons, a background-traffic toggle and an event
log folded away behind a disclosure.

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
curl -X POST http://localhost:8000/debug/reset          # forget positions/sessions/door history
curl -X POST http://localhost:8000/debug/purge          # destructive twin: the above PLUS Firestore
                                                        # anomalies+reviews deleted, stats zeroed,
                                                        # every revocation lifted, hour unpinned,
                                                        # traffic stopped. Never deletes a doors or
                                                        # credentials DOCUMENT - only the revoked field
curl -X POST http://localhost:8000/debug/traffic/start  # spawn sim/normal.js server-side
curl -X POST http://localhost:8000/debug/traffic/stop
curl -X POST http://localhost:8000/credentials/B-4471/revoke

# pin the hour OFF_HOURS reads, so the rule can be demonstrated in daylight
curl -X POST http://localhost:8000/debug/clock -H 'Content-Type: application/json' -d '{"hour":3}'
curl -X POST http://localhost:8000/debug/clock -H 'Content-Type: application/json' -d '{"hour":null}'
```

`/debug/reset` blinds the engine in one unauthenticated call, `/debug/traffic/*` spawns a process,
`/debug/clock` changes what the engine flags and `/debug/purge` deletes Firestore data outright, so
all four are gated by `DEMO_MODE` — on by default, off when `NODE_ENV=production` or `DEMO_MODE=0`.

**`/debug/reset` and `/debug/purge` are deliberately separate routes, not one route with a flag.**
Reset is the fast mid-demo "replay the attack" path and must stay one unguarded click that leaves
revocations, the pinned hour and the alert history alone. Purge is the pre-demo clean slate. The
console mirrors that split: `#reset` fires immediately, `#purge` needs two clicks (`data-armed`,
a colour change — never `confirm()`, which blocks the page). The SSE handler duplicates the clearing
lines on purpose; folding `case 'purge'` and `case 'reset'` into a shared helper would silently make
the light reset start eating the alert history.

Inside `purge()`, un-revoke iterates the **Firestore** `credentials` collection and uses
`update({revoked:false})`, never `set(..., {merge:true})` — a merge-set onto a missing doc *creates*
it, and the Admin SDK bypasses the `allow create: if false` rule that normally blocks exactly that
registry-poisoning path. `stats.reset()` must zero the in-process `pending` counters **and** the
`stats/live` doc: the flush writes absolute totals, so clearing only the doc brings the old numbers
back within `FLUSH_MS` of the next scan.

**Windows:** `pkill` and `kill` do not reliably stop node under Git Bash — a "restart" silently leaves
the old server bound and the new one dies on `EADDRINUSE`. Use:

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### Android

```bash
cd android && ./gradlew installDebug    # build + install on a connected phone
cd android && ./gradlew assembleDebug   # APK only -> app/build/outputs/apk/debug/
```

Toolchain: JDK 21 / AGP 8.7.3 / Kotlin 2.0.21 / Gradle 8.10. `local.properties` (gitignored) holds
`sdk.dir`. The build fails without `android/app/google-services.json`.

Two credential files, and they are **not** interchangeable:

| File | Lives | Secret? |
|---|---|---|
| `backend/serviceAccountKey.json` | laptop only — Admin SDK, **bypasses every security rule** | yes, genuinely |
| `android/app/google-services.json` | shipped inside every APK | no — the rules are what protect the data |

`android/firestore.rules` is a **reference copy**. It is pasted into the Firebase console by hand
(Firestore → Rules → Publish), never deployed by CLI, so the repo copy can silently drift from what
is live. Verify with the REST probes in the verification list rather than trusting the file.

## No test framework

Verification is the simulators, in this order — steps 1–4 need no Firebase and no phone:

1. `node graph.js` — `D-LOBBY` → `D-SERVER` must be **110s** (25+55+30); matrix symmetric
2. `node attack.js` — `ANOMALY / CLONED_CREDENTIAL`, ~27× severity
3. `node attack.js --steal` — `CREDENTIAL_SHARED_OR_STOLEN` (proves person-level keying)
4. `node normal.js` for several minutes — **zero** anomalies. Any hit means a `doors.json` edge is
   overestimated, not that the engine is wrong. A handful of amber `REVIEW` lines is expected and
   correct: the sim starts walkers at random doors, so most never badge a perimeter door
5. revoke → replay attack → first scan returns `{"decision":"DENY","reason":"REVOKED"}`
6. Tier B branches — the 4h session expiry is still untestable in wall-clock time, but **off-hours is
   not: `POST /debug/clock {"hour":3}` (or the console's **Night mode · 03:00** button) pins the hour
   `rules.js` compares against.** It pins the HOUR only — `evt.ts` stays the real ingest stamp,
   because that same stamp is Tier A's `observed`, `setLastSeen`'s monotonic guard and `getSession`'s
   4h window. Faking `ts` instead would break all three at once; don't collapse the two fields.
   Two beats, both real scans through the console:
   - **stacked** — `/debug/reset`, night mode on, select `B-4472`, click **Server Room** →
     `OFF_HOURS + NO_ENTRY_PATH + FIRST_USE`. Click again → `OFF_HOURS + NO_ENTRY_PATH`, which
     proves findings are recomputed per scan, not cached
   - **`OFF_HOURS` alone** — select `V-0001`, click **Server Room**. `rules.js` pushes `OFF_HOURS`
     *before* the `if (cred.shared) return findings` early-return, so both person-level rules are
     skipped; `engine.js`'s `prev = cred.shared ? null : …` means Tier A can never fire, so this is
     repeatable at any click speed with no waiting
   **There is no click path that isolates `OFF_HOURS` on a personal credential.** Badging a perimeter
   door first to clear `NO_ENTRY_PATH` does not work: `D-GATE` → `D-SERVER` is 150s, so two clicks
   seconds apart are a Tier A `ANOMALY` and `engine.js` short-circuits Tier B entirely. The
   "perimeter entry first leaves only `FIRST_USE`" case below is **synthetic-timestamp only**.
   Still drive `evaluate()` directly for: perimeter entry first → only `FIRST_USE`; an impossible
   arrival at the same door → still `ANOMALY`. Verify red outranks amber live by running
   `attack.js` with night mode ON — scan 2 lands on `D-SERVER` at 03:00 and must return
   `ANOMALY / CLONED_CREDENTIAL` at 27.3×, with no `OFF_HOURS` anywhere
7. the console — select `B-4471`, click the **Lobby** room, hover **Server Room**: the read-out must
   say `25s + 55s + 30s = 1m50s`. **Cloned badge** must walk the figure while a red ghost stands
   *inside* the Server Room, offset from the door so the two bodies never overlap, and **nothing may
   move**: `document.getAnimations().length` must be `0`. Clicking through must give
   `1/3 Lobby to Elevator Lobby — 25s`, `2/3 lift up to Level 3 — 55s` (badge reads `LIFT L0 → L3`),
   `3/3 3rd Floor Hall to Server Room — 30s` plus the verdict, with the bar reaching `1m50s / 1m50s`
   against a `4.0s` red sliver. **Both figures must stay exactly where they started through every
   step** — the person in the Lobby, the clone in the Server Room — and the red reach mark must sit
   just outside the Lobby, labelled `a real person / gets here in 4.0s`. `#headline` above the plan
   must read `Badge B-4471 opened two doors 1m50s apart — in 4.0s.` and `#claim` directly under it
   must read `A body needs 1m50s to cross that. This took 4.0s. So the person standing in Lobby did
   not open Server Room — a second copy of this badge did. The card has been cloned.` (`--steal`
   ends `— a second person carrying Ravi Sharma's access did.`). Both use `dur()`, never raw
   seconds — **one time format on the whole screen**, matching the bars. The headline states the two
   facts; `#claim` states the inference, which never landed on its own. The red figure must carry a
   `CLONE` banner above its head (`2ND BODY` on `--steal`), and **both figures must print the
   wall-clock time of the scan that put them there**, to tenths (`11:43:43.1` / `11:43:47.1`) via
   `clockMs()` — whole seconds render a 4s gap as two times that look one apart, hiding the point. The
   phone card keeps whole seconds, matching the Android app. Two bodies, two clock times, side by side
   is the argument with no narration. Only the scene's subject is timed; every other tracked figure is
   just a position. All of these exist because the screen was
   unreadable without them — an insider could not identify his own scenario from a screenshot.
   **Back** must rewind the highlight and the bar. **Show on plan** on the
   card re-opens at step 0. **Visitor pass · control** must open no scene at all — with night mode on
   it does raise an amber card, which is still not a scene and still not an `ANOMALY`. Revoke and **Clear
   tracked positions** must tear the scene down mid-step, clear `#headline` **and `#claim`**, and
   leave the tracked figure on the plan.
   A **Last check** panel sits at the top of the right column and **replaces on every scan** rather
   than accumulating — the flicker under background traffic is the point, it is what proves the
   engine clears every scan. Select `B-4472`, click **R&D Lab** → `✓ CLEARED / Priya Nair · R&D Lab /
   first scan on record — nothing to compare yet`; click it again → `same door again — no travel to
   check`; wait 25s and click **3rd Floor Hall** → `took 25.Ns · walk is 25s · flags under 20.0s`.
   **Three numbers on that line, never two:** `required_s` is the *walk* time and the flag threshold
   is `required_s * 0.8`, so printing the walk time alone renders `took 22.0s · minimum 25.0s ·
   legal`, which contradicts itself. `flags_under_s` is computed in `engine.js` so `TOLERANCE` never
   reaches the browser. A shared pass reads `shared pass — belongs to a role, not a body` **with night
   mode off**; with it on the same scan is a REVIEW and the panel reads `⚑ QUEUED FOR REVIEW`. An
   unrecognised credential turns the panel amber, and an anomaly turns it red: `✗ IMPOSSIBLE … 27.3x
   too fast`. An amber `REVIEW` must now bump the **Scans** lamp, flash the room and move the tracked
   figure — `engine.js` updated `lastSeen` for that scan, so before this the browser figure and
   `hoverWalk()`'s "at" door silently disagreed with the engine after every amber event.
   A `deny` event must raise a green `LOOP CLOSED · DENIED AT THE DOOR` card in `#alerts` — before
   that, the third beat of the loop was a 900ms flash plus one line inside the collapsed event log.
   The explainer sections (**What you are looking at**, **Two tiers**, **What happens next**) live in
   the side columns, never over or under the plan: `#plan` is `width:100%;height:auto`, so a wider
   screen makes it *taller* and anything below it is off-screen on a projector. `getAnimations()
   .length` must still be `0` with the scene open and all of the above on screen.
   Browser console must be free of `[plan]` warnings — one means `PLAN` has drifted from `doors.json`
8. background traffic — click **Start background traffic**, leave it several minutes: the `Impossible`
   lamp must stay at **0**. Clicking Start twice must not raise the node process count (`Get-Process
   node`); the second call returns `409 ALREADY_RUNNING`. Stopping must log **one** notice, not two.
   A page reload must show the right button label for **both** toggles, which proves `/health.traffic`
   and `/health.demo_hour`. Run the soak with **night mode off** — it does not touch the `Impossible`
   lamp either way, but every walker reaching `D-SERVER` would trip `OFF_HOURS` and bury the amber
   signal. Pooled credentials are excluded from the walker pool (`sim/normal.js`'s `if (c.shared …)
   continue`), so background traffic can never reach the pooled-review branch
8b. `/debug/purge` — dirty the demo first (scan, revoke something, night mode on, traffic running),
   then `POST /debug/purge`. `/health` must read `people_tracked: 0`, `sessions_open: 0`, `revoked: 0`,
   `scans/anomalies/reviews: 0`, `demo_hour: null`, `traffic: false`, and **`credentials: 15`** — the
   registry must survive, so re-run `node attack.js` afterwards and confirm it still fires
   `CLONED_CREDENTIAL` at ~27x. Wait past `FLUSH_MS` (10s) and re-read `/health`: counters that come
   back mean `stats.reset()` zeroed the doc but not `pending`. **Purge twice** — the second call must
   report only what happened since the first, and a third must return all zeros; that is the proof the
   Firestore deletes actually landed, without needing REST probes. Offline (`GOOGLE_APPLICATION_CREDENTIALS`
   pointing at a missing file) must still return `200` with zeros and do the local half

9. restart survival — scan at `D-LOBBY`, restart the process, scan at `D-SERVER`: must still flag.
   Boot log says `[state] restored N tracked positions`. Before this existed, the restart was an
   amnesty for everyone. `demoHour` deliberately does **not** survive — a fresh process reads the real
   clock, which is why it lives in `server.js` and not in `store.js`

Steps 10–12 need Firebase. They verify the whole phone loop **without a phone**, so run them first:

10. rules probes — unauthenticated REST is exactly what the phone is. Substitute the project id:

```bash
BASE="https://firestore.googleapis.com/v1/projects/<project-id>/databases/(default)/documents"
curl -s -o /dev/null -w "anomalies %{http_code}\n" "$BASE/anomalies?pageSize=1"   # 200
curl -s -o /dev/null -w "reviews   %{http_code}\n" "$BASE/reviews?pageSize=1"     # 403
curl -s -o /dev/null -w "revoke    %{http_code}\n" -X PATCH -H "Content-Type: application/json" \
  -d '{"fields":{"revoked":{"booleanValue":true}}}' \
  "$BASE/credentials/B-4471?updateMask.fieldPaths=revoked"                        # 200
curl -s -o /dev/null -w "un-revoke %{http_code}\n" -X PATCH -H "Content-Type: application/json" \
  -d '{"fields":{"revoked":{"booleanValue":false}}}' \
  "$BASE/credentials/B-4471?updateMask.fieldPaths=revoked"                        # 403
```

   A `200` on `reviews` means the console is still in test mode, not that the rules work.

11. the loop, closed over the internet — the `revoke 200` above must make the backend log
   `[sync] registry updated - 1 revoked` with no local call, and the replayed `attack.js` must then
   `DENY` at scan 1. Restore with `POST /credentials/B-4471/restore` (the Admin SDK bypasses the
   rule that stops the phone un-revoking); `/debug/reset` deliberately does not clear revocations
12. on the phone — install, accept the notification prompt, `node attack.js`, expect a card within
    ~1s with door **names** resolved. **Test push before revoking anything:** once `B-4471` is dead
    `attack.js` halts at scan 1 and never produces a second anomaly to push

## Architecture

```
sim/*.js, operator console  ──POST /events──►  backend
                                                ├─ graph.js       Floyd–Warshall at boot, O(1) lookups
                                                ├─ store.js       in-memory hot state  ◄── only stateful module
                                                ├─ persistence.js snapshots store.js to .state.json
                                                ├─ engine.js      the velocity check   ◄── the IP, ~40 lines
                                                ├─ rules.js       Tier B plausibility  ◄── amber, never revokes
                                                ├─ traffic.js     spawns sim/normal.js ◄── one child handle
                                                └─ firestore.js   anomalies out, revocations in
                                                                  + FCM push, sent from writeAnomaly
                                                        │  ▲
                                                  Firestore / FCM
                                                        │  ▲  realtime listener / one-tap revoke
                                                  android/  Compose app
```

The app is two features only: a live red-alert feed and one-tap revoke. No amber queue, no stats
header, no door map, **no login**. It reads `anomalies` + `doors`, writes one field on `credentials`,
and subscribes to the FCM topic `anomalies`. Six flat Kotlin files, no layering — `AnomalyRepository`
is the only Firestore contact.

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

**Two tiers, and nothing heuristic may return `ANOMALY`.** Velocity is Tier A: a proof, so it
auto-revokes. `rules.js` is Tier B: plausibility checks for attackers patient enough to leave no
velocity signature at all (a clone used an hour later is a legal walk; a badge used at 3am while its
owner sleeps never collides with anything). Those return `REVIEW`, land in an amber queue, and never
revoke. That split is what keeps "a revoked badge was provably impossible" true. Red outranks amber —
when a scan matches both, only the anomaly is emitted.

**Tier B watches only `sensitivity: high` doors.** Currently just `D-SERVER`. These rules are
heuristics — `NO_ENTRY_PATH` fires honestly on a tailgating employee — so every door added to that
list costs amber volume, and amber nobody reads is worth less than none. Keep the list short.

**Presence sessions are inferred from silence.** No exit readers exist, so a session opens at a
`perimeter: true` door and is considered closed after 4h without a scan (`SESSION_IDLE_MS`). Hard
anti-passback is the production answer and needs egress readers.

**`lastSeen` survives restart.** It used to be RAM-only, so every restart handed the whole population
one unchecked scan each — the first scan after boot has no prior position and can never be impossible.
`persistence.js` write-behinds `store.snapshot()` to `.state.json` (gitignored). This is the
single-instance fix; two processes still mean two Maps and silently halved detection.

**`setLastSeen` refuses older timestamps.** Server-stamping keeps events monotonic today, so this is
inert — but a stale event overwriting a fresh position would hide the very next real anomaly, and any
future reader-timestamp or batch path reintroduces that ordering.

**`loadCredentials` refuses an empty list.** A transient bad Firestore snapshot would otherwise clear
the registry, turn every credential `UNKNOWN_CREDENTIAL`, and silently drop every revocation.

**…but it only refuses a ZERO-length list, and that gap is a live trap.** `store.js` replaces the
whole registry from every snapshot. If `credentials` was never seeded and the phone writes
`{revoked:true}` with merge, Firestore *creates* the document, the watcher fires with a one-element
list, and the registry becomes one garbage credential — every later scan is `UNKNOWN_CREDENTIAL` and
detection dies silently, mid-demo. Two guards, both required, neither in `store.js`: run
`npm run seed` before the phone ever writes, and keep `allow create: if false` on `credentials` in
the rules. A merge-set onto a missing doc counts as a *create*, so the rule blocks it at the source.

**`doors.json` edge weights are deliberately UNDERESTIMATED.** A generous floor means fast employees
never false-positive, while a clone is still 20–30× below it. When adding doors, underestimate.

**Timestamps are stamped server-side at ingest** (`server.js`), never taken from the reader. Reader
clocks drift; a reader 60s behind its neighbour would manufacture anomalies.

**The demo clock pins an HOUR, never the timestamp.** `OFF_HOURS` is the one Tier B rule a daytime
demo cannot reach, so `POST /debug/clock` sets a `demoHour` that rides to `rules.js` as a separate
`evt.demo_hour` field. The one-line-shorter version — faking `evt.ts` at ingest — breaks four things
at once: Tier A's `observed`, `setLastSeen`'s monotonic refusal, `getSession`'s 4h window and the
console's `clockMs()` figure labels. Keep the two fields apart. `demoHour` lives in `server.js`, not
`store.js`, because it must *not* survive a restart — the opposite of everything `store.js` holds —
and `EventSchema` is a plain `z.object`, so a client cannot POST `demo_hour` and forge it.

**Revoked credentials bypass the engine *and* do not update last-seen.** Deliberate: a killed badge must
not poison the tracked position of the employee still carrying their other credential.

**The console spawns the real `sim/normal.js`; it does not reimplement walkers.** `normal.js` IS the
false-positive test — every walker waits at least 1.4x the edge minimum — so a second copy of those
pacing rules living in the browser would drift from it invisibly. `traffic.js` holds one child handle
and refuses a second start, because two copies each keep their own idea of where every walker stands,
disagree, and manufacture anomalies. (The frontend does still duplicate `sim/attack.js` in its
`SCENARIOS` table. Don't extend that pattern.)

**The console map reconstructs routes client-side.** `GET /graph` returns totals only, and the engine
never needs more — but a map has to draw which corridors a walk passes through, so `index.html` runs a
small Dijkstra over the edge list from `GET /doors`. That route response is `{nodes, edges}`, not the
bare array it used to be; `graph.js` exports `edges` for it. The Android app reads doors from
Firestore, so it is unaffected.

**The floor plan is hand-drawn, and `doors.json` cannot describe it.** `doors.json` carries walk
seconds and lat/lon; neither describes a room, so an office cannot be derived from the graph. The
`PLAN` block at the top of `index.html`'s script holds the room rectangles, door positions and one
corridor polyline per edge — presentation only, never a walk time. **Adding a door to `doors.json`
means adding it to `PLAN.doors` and `PLAN.corridors` too.** The renderer does not fail silently: a
door with no position and an edge with no corridor each `console.warn`, and the missing corridor
falls back to a straight line that will look obviously wrong.

A plan is not a scale drawing of time — stairs, lifts and floors are what make 20s and 70s differ —
so every corridor is labelled with its seconds, and a clashing label slides along its own polyline
rather than drifting off it.

**The room is the click target, not the door leaf.** Corridors, routes and labels paint over the
rooms to stay legible, which also puts them in front of the pointer — so `#gPlates, #gCorridors,
#gRoutes, #gLabels` are `pointer-events:none`. Without that, the corridor drawn across the Lobby
swallows every click on it.

**Nothing on this screen moves, and that is the design.** It was animated once — swinging legs, a lift
car riding up the shaft, a pulsing corridor, an auto-playing walk — and motion was the single thing
people said made it unreadable. Figures are placed and stay placed; `poseActor()` only sets a
translate. There are **zero CSS keyframes and zero `requestAnimationFrame` loops** left in the file;
`document.getAnimations().length` is `0` on a live anomaly, which is worth re-checking after any
change here. Room and door flashes on a scan are colour changes, not transitions.

**The anomaly is a scene you click through, and NEITHER FIGURE EVER MOVES.** `scene = { a, legs, i }`.
The engine knows exactly two facts: the person's credential was at `from`, and `observed_s` later
their credential opened `to`. It does not know that anybody walked anywhere. An earlier version
marched the real body up to the far door as the steps advanced, and it read as *"they both went
there"* — the exact opposite of the claim. Both bodies now stay where they were actually seen, for
the whole scene, because two places at one moment IS the anomaly.

What advances is the corridor **highlight**: one `doors.json` edge per click on **Next corridor**,
named in the read-out (`2/3 lift up to Level 3 — 55s`), with its real seconds added to the bar. It is
a trace of the route a body *would* have had to cover, not a replay of anything. The last step prints
the verdict; **Back** steps in reverse and rewinds the bar.

**The reach mark answers "so what".** A red dot sits on the route at the point a body actually gets
to in `observed_s` — computed in walk seconds (`pointAtSeconds`), not drawn distance, because the plan
is not to scale and the graph is. On this demo that is 4s of a 110s walk, so the dot lands just
outside the Lobby, a few metres from the person standing there. That single dot is the argument.

Figures stand *beside* their door (`placeActor` insets into the room and steps along the wall), never
in the doorway — the doorway is where the corridor highlight and the reach mark are drawn. Every
figure carries its floor in the label (`RAVI · L0`, `M-9902 · L3`), and `floorPhrase()` derives
"3 floors up" from `doors.json` rather than hardcoding it.

**A floor change gets a badge, because a flat plan cannot draw one.** `PLAN.via` marks which corridors
are `lift`, `stairs` or `outside`. On such a leg a static `LIFT L0 → L3` badge is placed at the
midpoint of that corridor.

**The time bar is the timing argument in one graphic.** Two bars to one scale: the amber one reaches
`required_s` as you step, the red one is what the badge actually took. At 110s against 4s the red bar
is a 3.7% sliver, which is the entire point.

`clearGhost()` tears the scene down but deliberately **keeps** the tracked figure and re-syncs it —
revoking a credential does not move the body. Alert cards carry **Show on plan** (`anomalyLog` keeps
the payload) to re-open the scene at step 0.

**No WebSocket anywhere.** The operator console uses SSE (`/stream`); the Android app is meant to listen
to Firestore directly, so it never needs the backend's address. Don't reintroduce one.

**Firestore degrades to offline.** Missing `GOOGLE_APPLICATION_CREDENTIALS` is a supported mode, not an
error — the engine loads `credentials.json` from disk and every scenario still works. Keep it that way.
`messaging` is nulled alongside `db`, so push no-ops offline for the same reason.

**Push is sent from `writeAnomaly`, not a Cloud Function.** Cloud Functions need the Blaze plan — a
credit card, Cloud Build, IAM, multi-minute deploys. `firebase-admin` was already a dependency, so
`admin.messaging()` costs ~15 lines and zero setup. The send sits in its own try/catch: `server.js`
catches only the outer promise, so an escaping FCM error would log a *successful* anomaly write as a
failure. This does not violate "no WebSocket" — the backend gained an **outbound** call to Google,
not an inbound one from the phone, and the phone still never learns this backend's address.

**Push goes to a topic, not device tokens.** One `subscribeToTopic("anomalies")` on the phone
replaces a `devices` collection, token upload and a fan-out loop. Cost: anyone holding the APK
receives every alert. `ALERT_TOPIC` in `firestore.js` and the constant in `MainActivity.kt` must
match — nothing enforces that.

**The security rules are the only thing protecting the data.** The `api_key` inside
`google-services.json` is an identifier, not a password; it ships in every APK by design. The rules
grant the phone exactly one write: flip `revoked` to `true` on an existing credential. No create, no
delete, no un-revoke, no field injection. Leaving the console in "test mode" is the real exposure —
and those rules also carry a 30-day `request.time` expiry that silently empties the feed later.

**The Android app maps Firestore documents by hand.** Node serialises `27.4` as a double but an
integral `27` as an int64. `toObject<Anomaly>()` throws exactly once on that boundary — on stage.
`Models.kt` reads every number through `as? Number` and returns null for a malformed document, so
one bad record cannot blank the whole feed.

**The FCM notification channel must be `IMPORTANCE_HIGH`.** FCM auto-creates a *default*-importance
channel, which renders a silent tray entry and never a heads-up banner — the backend's
`priority: 'high'` does nothing on its own. The manifest's
`default_notification_channel_id` meta-data and `ensureNotificationChannel()` must agree on the id
`anomalies`.

### Engine edge cases — each one breaks the demo if removed

- same door repeated → skip (fumbled badge taps would alert constantly)
- first-ever scan → no prior, store and return OK
- `observed <= 0` (out-of-order delivery) → not an anomaly
- `shared: true` credentials (visitor/contractor passes) → exempt from person-level physics, and from
  the two person-level Tier B rules for the same reason. `OFF_HOURS` still applies to them — a room has
  hours even when nobody owns the badge. That is not trivia: it is the *only* way to show `OFF_HOURS`
  on its own, because `rules.js` pushes it before the `if (cred.shared) return findings` early-return.
  See step 6.
- `kind` distinguishes `CLONED_CREDENTIAL` (same credential — it was copied) from
  `CREDENTIAL_SHARED_OR_STOLEN` (different credentials, same person — revoking both locks out the real
  employee)
- Tier B runs *before* the store is updated — `FIRST_USE` and `NO_ENTRY_PATH` both ask what was true
  immediately before the scan

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
- Offline/scheduled-sync locks do **not** work today: `server.js` stamps `Date.now()` at ingest, so a
  batch of 40 queued scans lands milliseconds apart and every consecutive pair reads as instantaneous —
  a false-positive storm, not forensics. The fix is a per-reader EWMA clock offset plus a forensic path
  that reports without revoking. Not built.
- Tailgating is not detectable as an intrusion: no second scan, nothing to compare. Tier B's
  `NO_ENTRY_PATH` sees its *trace* later, if the tailgater then opens a sensitive door.
- Tier B does not deduplicate: a person with no perimeter entry re-trips `NO_ENTRY_PATH` on every
  sensitive-door scan until their session idles out.
- Nothing is authenticated. `POST /events` accepts injected scans (poison a position, or flood the
  feed until the real alert is buried) and `POST /credentials/:id/revoke` is open — loop it and the
  whole building is locked out. First thing to fix before this is deployed anywhere real.
- A patient attacker still beats Tier A entirely, and Tier B is heuristic by construction. Coverage is
  layered, not complete.
- **The `reviews` collection is no longer always empty, and the underlying bug is unfixed.** Night mode
  makes the pooled path reachable on demand: `V-0001` at `D-SERVER` carries `reason:
  'POOLED_CREDENTIAL'` (defined), so `writeReview` succeeds and a doc lands. That path had never
  executed before; it was exercised deliberately with Firestore connected, and `/health.reviews` went
  to 1 with no `review write failed` in the log. Everything below still holds for every **non-pooled**
  REVIEW, which is all of them under background traffic:
  `reason: undefined` for every non-pooled credential, `firestore.js` never sets
  `ignoreUndefinedProperties`, so `writeReview` throws and `server.js` swallows it. Only pooled-
  credential reviews ever land. Harmless today because the app has no amber queue — fix before
  adding one. **Deliberately preserved:** the Last-check data rides on a new `check` key, never on
  `reason`, because the REVIEW object copies `reason` and nothing else. Had it reused `reason`,
  `writeReview` would have stopped throwing and this collection would have started filling for the
  first time ever — mid-demo, untested, with no dedupe and background traffic writing a doc per
  sensitive-door scan.
- The app is admin **by intent**, not **by enforcement**. No login, no Firebase Auth: anyone with the
  APK is an operator, and reads are unauthenticated. The rules cap the blast radius at flipping one
  boolean; they cannot tell one person from another. Real fix is Auth with an `operator` claim plus
  revoke behind a privileged function, so the phone never writes the registry at all.
- Push depends on the backend process being alive — already true of the whole demo.
- A force-stopped Android app receives no pushes until relaunched by hand.

## Firebase setup gotcha

Creating a Firebase project does **not** create the database. `npm run seed` then fails with
`7 PERMISSION_DENIED … SERVICE_DISABLED`, which reads like a credentials problem and is not — the
`[firestore] connected` line above it proves the key is fine. Fix: console → Build → Firestore
Database → Create database, **production mode** (the Admin SDK bypasses rules, so seeding works
immediately while the phone stays locked out until `firestore.rules` is published — which is the
order you want). The location choice is permanent.

## Not built yet

`azure-pipelines.yml`, architecture diagram.
