# Handoff — operator console rebuild

**Date:** 2026-09-22
**Branch:** `main` (nothing committed this session — all work is in the working tree)

Read `CLAUDE.md` first. It is the architecture and the decision record, and it is still accurate.
This document only covers what changed in this session and what is left.

---

## Why this session happened

The backend was demo-ready. The UI was not — `backend/public/index.html` had been **deleted**, so
`http://localhost:8000` served nothing and CLAUDE.md verification steps 7 and 8 could not run.

The user confirmed the deletion was deliberate ("i dont want that file"), so nothing was recovered.
The console was rebuilt from scratch, plus a new phone panel showing what the Android app displays.

**The approved plan is at** `~/.claude/plans/the-project-and-android-soft-widget.md`.
It holds the full design, the `PLAN` geometry rationale, and the 22-step verification list.
Do not re-derive any of that here.

---

## What changed — two files

| File | Change |
|---|---|
| `backend/public/index.html` | **New**, ~1050 lines. Single file, no build step. Floor plan + anomaly scene + phone panel. |
| `backend/server.js` | ~15 lines in `main()`, at the `firestore.watchCredentials` callback. See below. |

Nothing else was touched. No new dependencies.

### The bug found while planning

`watchCredentials` updated the registry but **never called `push()`**. So a revoke from the phone
made the engine start denying, while the browser console's Revoke button sat there still enabled —
side by side on the projector.

Fix: diff the revoked set across the reload, push one `revoked` / `restored` SSE event per changed
id. Reuses event types the page already handles. Respects `loadCredentials`' empty-list refusal.

---

## Verification status

### Passing — proved with evidence, do not re-run

- All CLAUDE.md step-7 strings, checked against live `/doors`:
  `25s + 55s + 30s = 1m50s`, the three step lines, the `LIFT L0 → L3` badge.
- Geometry invariants: every corridor ends on the correct room's wall, no rooms overlap, no corridor
  cuts through a room it does not connect.
- All three scenarios over real SSE — correct `kind`, correct revoke-button count (1 clone / 2 steal
  / 0 pooled), `4.0s` at 1dp, severity ~27x, 3.7% red sliver.
- **Both** revoke directions, including the `server.js` fix, proved with a real Firestore write.
- Background traffic 5 min → **zero anomalies**. Double start → `ALREADY_RUNNING`. One stop notice.
- Restart survival → `[state] restored 1 tracked positions`, still flags.
- Full phone loop: console button → Firestore `anomalies` doc written (72 → 73, `created_at` present)
  → real FCM send accepted by the topic.

### NOT verified — this is the open gap

**The page has never rendered in a browser.** The Chrome extension was not connected, and a headless
Edge attempt was abandoned. Every check above was either the backend over HTTP, or the script's pure
functions lifted out with the DOM code sliced off.

So these have never executed even once: `renderPlan`, `drawLeaf`, `renderActors`, `drawScene`,
`phoneAlert`, `showAlert`, `connect`, `boot`, and the delegated click handler. A single null deref in
any of them is a blank screen.

**First job for the next session.** Open `http://localhost:8000` and check:

1. **Cloned badge** → two figures: one in the Lobby, a red one in the Server Room. Phone panel shows
   a tray push and a red card.
2. DevTools console: `document.getAnimations().length` must print **`0`**.
   (A `grep` for `@keyframes` is **not** this check — it cannot see a UA-supplied animation.)
3. **Next corridor** ×3 → the three step lines, bar reaching `1m50s / 1m50s` against a `4.0s` sliver.
4. Neither figure moves across those three clicks.
5. **Back** rewinds. **Show on plan** reopens at step 0.
6. Select `B-4471`, click **Lobby**, hover **Server Room** → `25s + 55s + 30s = 1m50s`.
7. Any red `[plan]` warnings? One means `PLAN` has drifted from `doors.json`.
8. Reload the page → traffic button shows the correct label (proves `/health.traffic` is read).
9. Before any run, the phone reads `No impossible movement detected.`

Steps 18–21 of the plan (emulator side by side) are also unrun.

---

## Traps that will cost you a demo

- **The AVD must use a Google Play or Google APIs system image.** A plain AOSP image has no Play
  services and FCM cannot deliver to it. The failure is confusing: Firestore is plain gRPC and works
  fine without them, so the card still appears in the feed and only the heads-up banner never fires.
  It reads as "push is broken" when it is the wrong AVD.
- **Test push before revoking anything.** Once `B-4471` is revoked, the scenario halts at scan 1 with
  `DENY` and never produces a second anomaly to push. Restore with
  `POST /credentials/B-4471/restore`.
- **Open the app at least once** and accept the notification prompt. `subscribeToTopic` runs in
  `MainActivity`, so a never-launched or force-stopped app receives nothing.
- **Windows restarts.** `pkill`/`kill` do not reliably stop node under Git Bash. Use the
  `Get-NetTCPConnection` one-liner in `CLAUDE.md`. Also: a node process started from a PowerShell
  tool call with `-NoNewWindow` **dies when that call times out** — start it detached.

---

## Known, deliberately not fixed

- Amber `review` cards render in the console but never reach Firestore. `engine.js` sets
  `reason: undefined`, `writeReview` throws on it. Pre-existing, documented in CLAUDE.md's
  "Known boundaries", out of scope here.
- The console still duplicates `sim/attack.js`'s scenario table. Tolerated, **not to be extended** —
  background traffic must keep spawning the real `sim/normal.js`.

## One deviation from what the user picked

The user chose the phone option whose description also mirrored Firestore into the browser mock.
That half was **dropped**, and the user was told in the plan and in chat. Reason: the emulator is
already the real-Firestore consumer, and a browser Firestore client would need a separate Firebase
*web* app config, add a CDN dependency, and break the supported no-Firebase demo path. The mock runs
off SSE. If the user asks for it back, that is a real change, not a bug fix.

---

## Suggested skills

| Skill | Use it for |
|---|---|
| `claude-in-chrome` | **Start here.** The nine browser checks above. Invoke the skill before any `mcp__claude-in-chrome__*` call. If the extension is still not connected, say so and hand the list to the user rather than burning turns on headless workarounds. |
| `run` | Launching and driving the backend to see a change working, instead of hand-rolling process management again. |
| `anthropic-skills:verification-before-completion` | Before claiming the console works. The trap this session hit was exactly this: syntax-checking a script is not evidence it renders. |
| `caveman:cavecrew-reviewer` | A diff review of `backend/public/index.html` and the `server.js` change before committing. |
| `caveman-commit` | Nothing is committed yet. The tree also carries unrelated pending work (`android/`, `rules.js`, `traffic.js`, `persistence.js`) — stage deliberately, do not blanket-add. |

---

## Environment

- Backend runs on `:8000`, `DEMO_MODE` on by default.
- Firebase is fully wired: `backend/serviceAccountKey.json`, `android/app/google-services.json`,
  and `backend/.env` all exist. All three are gitignored or shipped-by-design; **none belong in a
  commit diff.** The Firebase project id appears in those files — do not paste it into docs.
- `sim/` and the offline fallback still work with `GOOGLE_APPLICATION_CREDENTIALS` unset.
