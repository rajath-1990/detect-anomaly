# Handoff — making the console legible to a judge

**Date:** 2026-09-22
**Branch:** `main`. **Nothing committed.** All work is in the working tree.

Read `CLAUDE.md` first — it is the architecture and the decision record, and it was updated this
session. `HANDOFF.md` (earlier session, same day) still holds the Android/AVD traps and is not
superseded by this file.

The approved plan for the second half of this session is at
`~/.claude/plans/cant-we-have-this-foamy-wirth.md`. It holds the full rationale, the rejected
alternatives and the verification list. **Do not re-derive any of it here.**

---

## Why this session happened

The console was correct but not self-explaining. The proof: the user pasted a screenshot of his own
demo and asked what scenario it showed. He had built it. He could not read it cold.

Diagnosis, in his words, in order:

1. *"i do not understand the simulated scenario in the screenshot"*
2. *"is demo ui hard to understand?"*
3. *"ui for this scenario is quite confusing"* — about the **legal walk**, not the anomaly

So the work split into two passes: make the **anomaly** readable, then make the **legal walk**
readable. Both are done.

---

## What changed

Five files. Every change is additive text, static markup, or a class swap.

| File | What |
|---|---|
| `backend/public/index.html` | All UI work — both passes |
| `backend/engine.js` | Keeps the numbers it already computed; new `check` field |
| `backend/server.js` | Forwards those numbers on the `scan` SSE frame |
| `CLAUDE.md` | Step 7 contract extended; one known-boundary note added |
| `cheatsheet.md` | Two factual corrections (see below) |

### Pass 1 — the anomaly

`#headline`, `#claim`, `CLONE` / `2ND BODY` banner, a wall-clock timestamp under each figure, a
green `LOOP CLOSED · DENIED AT THE DOOR` card, and three explainer sections (**What you are looking
at**, **Two tiers**, **What happens next**).

### Pass 2 — the legal walk

A **Last check** panel at the top of the right column. It **replaces** on every scan, never
accumulates, and is fed by all four paths: cleared, impossible, queued for review, denied.

Plus the REVIEW desync fix, the figure-movement note, and two dead CSS rules.

---

## Five findings worth keeping

These are the non-obvious things this session uncovered. Each cost real digging.

**1. A wider screen makes the floor plan TALLER.** `#plan` is `width:100%;height:auto` inside a
`230px minmax(0,1fr) 300px` grid. On the user's ~1610px screen the Annex level is already below the
fold. **Anything placed under — or permanently above — the plan is invisible on a projector.** This
killed two proposed placements. The legend went to the left column, the Last check panel to the
right.

**2. The engine computed the numbers and threw them away.** `engine.js` derived `observed` and
`required` on every legal walk inside a block-scoped `if`, then let them fall out of scope. The
console could never re-derive them — only the engine knows `prev`. Keeping them was ~5 lines.

**3. `required_s` alone renders a self-contradiction.** `required_s` is the *walk* time; the flag
threshold is `required_s * 0.8`. So `took 22.0s · minimum 25.0s · legal` is a sentence the panel
would have printed. The fix is three numbers, never two — and `flags_under_s` ships from the engine
so the browser never learns `TOLERANCE`.

**4. The Firestore trap, avoided by naming.** `CLAUDE.md` documents that the `reviews` collection is
always empty because `writeReview` throws on `reason: undefined`. The REVIEW object copies `reason`
and nothing else. **Had the new data reused `reason`, that collection would have started filling for
the first time ever — mid-demo, untested, with no dedupe.** It rides on a new `check` key instead.
The throw is now a *pass condition*, not a bug to fix in passing.

**5. Every room is a live badge reader.** Selecting a credential turns every room into a scan
trigger. The user fired three real anomalies by clicking rooms while explaining the map, and did not
know why. `#selHint` now says so explicitly. **Warn judges before handing over the mouse.**

---

## Verified — with evidence, do not re-run

**Backend, live over HTTP:**

| Case | Result |
|---|---|
| First scan | `check: FIRST_SCAN`, no numbers |
| Same door | `check: SAME_DOOR`, no numbers |
| Legal walk | `check: LEGAL_WALK`, `required_s: 25`, `flags_under_s: 20`, `from_door_id: D-LAB` |
| Anomaly | still fires — `14.04s` against `30s` |
| Pooled | `reason` **and** `check` both `POOLED_CREDENTIAL` |
| Unknown | `check: UNKNOWN_CREDENTIAL` |

**The load-bearing predicate did not move:**

- `attack.js` → `4.03s vs 110s`, **`27.3x`**, `CLONED_CREDENTIAL`
- `attack.js --steal` → `CREDENTIAL_SHARED_OR_STOLEN`
- `attack.js --pooled` → correctly silent
- `normal.js`, 75s / 17 scans → **zero** anomalies

**Firestore behaviour unchanged.** A `REVIEW` still produces, on stderr:

```
[firestore] review write failed: Cannot use "undefined" as a Firestore value (found in field "reason")
```

**That line is the pass condition.** It proves `check` did not leak onto `reason`. If it ever stops
appearing, the `reviews` collection has started filling and something reused `reason`.

**Static checks on `index.html`:** JS parses; zero `transition:`, zero `animation:`, zero
`requestAnimationFrame`; tags balanced. The only `@keyframes` hit is the comment declaring the rule.

---

## NOT verified — this is the open gap

**None of the UI has been rendered in a browser this session.** Everything above is HTTP responses
and static analysis. `HANDOFF.md:66` flagged the same gap before, and it is still the first job.

**Start here.** Server is already running on `:8000` and state is reset.

1. `document.getAnimations().length` must be `0` with the scene open, the panel updating and
   background traffic running. This is the rule the whole screen is built on.
2. **The Last check panel must not change height** as it replaces itself. Watch the top edge of the
   Alerts card during background traffic. Two lines are reserved per row for exactly this reason; if
   it still swings, the reserved heights are wrong for the rendered font.
3. Select `B-4471`, click **R&D Lab**, wait, click **3rd Floor Hall**. Expect:
   ```
   ✓ CLEARED                          hh:mm:ss
   Ravi Sharma · R&D Lab → 3rd Floor Hall
   took 25.Ns · walk is 25s · flags under 20.0s
   ```
   The ampersand must render as `R&D Lab`, not `R&amp;D Lab`.
4. **Cloned badge** → panel flips red, `#headline` and `#claim` byte-identical to the step-7
   contract, both figures stay put, both carry timestamps to tenths.
5. Three new left/right-column sections must not crowd the `230px` / `300px` columns.
6. Revoke `B-4471`, replay → green DENY card **and** the panel must read `⛔ NOT CHECKED`, not a
   stale `✗ IMPOSSIBLE`.
7. Browser console free of `[plan]` warnings.

The full list is in the plan file's **Verification** section.

---

## Two things deliberately left

- **`normal.js` has not run for "several minutes"** as `CLAUDE.md` step 4 requires — only 75
  seconds. The `attack.js` numbers are stronger evidence the predicate is intact, so this is a
  contract gap, not a suspected bug. The user stopped a 4-minute soak as not worth the wait.
- **The `reviews` Firestore bug is not fixed.** Fixing it means `ignoreUndefinedProperties`, after
  which that collection fills for the first time with no dedupe and no reader. A separate,
  deliberate change with its own verification. Never bundle it with UI work.

---

## Corrections made to the demo script

`cheatsheet.md` said Tier A **auto-revokes**, in two places. It does not. `server.js`'s anomaly path
never calls `store.setRevoked` — only the explicit `/revoke` and `/restore` routes do. A human taps
it. Both lines are fixed, because a judge who reads the API would have caught it.

`detection-flow.md` was already correct on this point.

---

## Environment

- Backend on `:8000`, `DEMO_MODE` on, Firestore connected, state reset, background traffic off.
- Server was started detached. Logs are in the session scratchpad as `server.log` / `server.err`.
- **Windows:** `pkill` and `kill` do not stop node reliably under Git Bash. Use the
  `Get-NetTCPConnection` one-liner in `CLAUDE.md`. Also: **a node process started from a PowerShell
  tool call dies when that call times out** — this bit once this session, killing the server
  mid-test. Start detached and keep each call short.
- Credentials files (`serviceAccountKey.json`, `google-services.json`, `.env`) all exist, are
  gitignored or shipped by design, and **belong in no commit diff**. The Firebase project id lives
  in them; keep it out of docs.

---

## Suggested skills

| Skill | Use it for |
|---|---|
| `claude-in-chrome` | **Start here.** The seven browser checks above. Invoke the skill before any `mcp__claude-in-chrome__*` call. If the extension is not connected, say so and hand the list to the user rather than burning turns on headless workarounds. |
| `anthropic-skills:verification-before-completion` | Before claiming the console works. This session's repeated trap was exactly this: parsing a script and curling an endpoint is not evidence anything renders. |
| `run` | Driving the backend, instead of hand-rolling process management again. Note the PowerShell-timeout trap above. |
| `caveman:cavecrew-reviewer` | A diff review of `index.html`, `engine.js` and `server.js` before committing. |
| `caveman-commit` | Nothing is committed. The tree also carries unrelated pending work (`android/`, `rules.js`, `traffic.js`, `persistence.js`) — **stage deliberately, do not blanket-add.** |

---

## If the next request is "more UI polish"

Re-read the plan file's **Deliberately NOT done** section first. Several obvious-looking ideas were
considered and rejected with reasons: capping the alerts list, auto-hiding the phone tray, guarding
room double-clicks, and a clean-slate reset. Rejecting them again from scratch wastes a turn.

The one genuinely open comprehension gap: **a second demo run starts dirty.** `/debug/reset` clears
tracked positions only — header counters, alert cards, phone cards and the event log all survive.
Restarting the server is the current workaround.
