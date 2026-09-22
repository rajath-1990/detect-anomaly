/**
 * Ingest API.
 *
 * In production this endpoint is fed by the access-control head-end, which
 * already receives every scan from every door. Locks do not call us directly:
 *   lock -> reader -> door controller -> head-end -> here.
 * The simulators in sim/ stand in for that feed.
 */

import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { evaluate } from './engine.js';
import { store } from './store.js';
import { persistence } from './persistence.js';
import { doors, doorById, isKnownDoor, travelMatrix, edges } from './graph.js';
import { firestore, stats } from './firestore.js';
import * as traffic from './traffic.js';

const PORT = Number(process.env.PORT ?? 8000);

/**
 * Gates /debug/reset, which wipes every tracked position in one unauthenticated
 * call. Fine on a laptop in front of judges, a detection kill switch anywhere
 * else - so it is on by default in development and off in production.
 */
const DEMO_MODE = (process.env.DEMO_MODE ?? (process.env.NODE_ENV === 'production' ? '0' : '1')) !== '0';

/**
 * Pins the hour-of-day that rules.js's OFF_HOURS rule reads. 0-23, or null for
 * the real clock. Set by /debug/clock.
 *
 * OFF_HOURS is the one Tier B rule that cannot be demonstrated on demand - it
 * only fires outside a sensitive door's `hours` window, so a daytime demo can
 * never show it. This pins the hour it compares against, and nothing else.
 *
 * Not in store.js despite that being the only stateful module: store.js holds
 * DETECTION state, keyed by person and snapshotted by persistence.js so it
 * survives a restart. This is a demo knob that must do the opposite - a fresh
 * process reads the real clock. Same category as sseClients above or traffic.js's
 * child handle.
 *
 * /debug/reset deliberately does not clear it: resetting positions mid-demo
 * should not silently drop you back into daylight.
 */
let demoHour = null;

const app = express();
app.use(express.json());
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'public')));

/**
 * Server-sent events for the operator console. One-way push, no library, no
 * handshake - the browser reconnects on its own. The Android app does not use
 * this; it listens to Firestore.
 */
const sseClients = new Set();

app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function push(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

const EventSchema = z.object({
  credential_id: z.string().min(1),
  door_id: z.string().min(1),
  reader_id: z.string().optional(),
  result: z.enum(['GRANTED', 'DENIED']).default('GRANTED')
});

// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    firestore: firestore.enabled ? 'connected' : 'offline',
    doors: doors.length,
    traffic: traffic.isRunning(),
    demo_hour: demoHour,
    ...store.stats(),
    ...stats.snapshot()
  });
});

app.post('/events', async (req, res) => {
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_EVENT', detail: parsed.error.flatten() });
  }
  if (!isKnownDoor(parsed.data.door_id)) {
    return res.status(400).json({ error: 'UNKNOWN_DOOR', door_id: parsed.data.door_id });
  }

  // A revoked credential never reaches the engine - and never updates last-seen
  // state, so a killed badge cannot poison the position of a person who is still
  // walking around with their other credential.
  if (store.isRevoked(parsed.data.credential_id)) {
    console.log(`  DENY  ${parsed.data.credential_id} @ ${parsed.data.door_id}  (revoked)`);
    push({
      type: 'deny',
      credential_id: parsed.data.credential_id,
      door_id: parsed.data.door_id,
      door_name: doorById[parsed.data.door_id]?.name,
      person_name: store.getCredential(parsed.data.credential_id)?.person_name ?? '?',
      ts: Date.now()
    });
    return res.json({ decision: 'DENY', reason: 'REVOKED' });
  }

  // Timestamp server-side. Reader clocks drift, and a reader 60s behind its
  // neighbour would manufacture anomalies out of nothing.
  //
  // `demo_hour` rides alongside `ts`; it never replaces it. Faking `ts` here
  // would be one line shorter and would break four things at once: Tier A's
  // `observed`, setLastSeen's monotonic refusal, getSession's 4h window and the
  // console's clockMs() figure labels. A separate field touches none of them.
  // EventSchema is a plain z.object, so zod strips a client-supplied demo_hour;
  // the append after ...parsed.data makes the server win regardless.
  const evt = { ...parsed.data, ts: Date.now(), demo_hour: demoHour };

  const outcome = evaluate(evt);
  stats.bumpScan();

  const person = store.getCredential(evt.credential_id);

  if (outcome.verdict === 'ANOMALY') {
    stats.bumpAnomaly();
    logAnomaly(outcome);
    push({
      type: 'anomaly',
      ...outcome,
      from_name: doorById[outcome.from.door_id]?.name,
      to_name: doorById[outcome.to.door_id]?.name
    });
    // Fire-and-forget: the engine must not wait on the network.
    firestore.writeAnomaly(outcome).catch((e) =>
      console.error('[firestore] anomaly write failed:', e.message)
    );

  } else if (outcome.verdict === 'REVIEW') {
    // Amber. Heuristic, so it goes to a human queue and never revokes anything -
    // see the tier split in engine.js.
    stats.bumpReview();
    logReview(outcome);
    push({ type: 'review', ...outcome, door_name: doorById[outcome.door_id]?.name });
    firestore.writeReview(outcome).catch((e) =>
      console.error('[firestore] review write failed:', e.message)
    );

  } else {
    console.log(`  ok    ${evt.credential_id} @ ${evt.door_id.padEnd(12)} ${person?.person_name ?? '?'}`);
    push({
      type: 'scan',
      credential_id: evt.credential_id,
      door_id: evt.door_id,
      door_name: doorById[evt.door_id]?.name,
      person_name: person?.person_name ?? '?',
      reason: outcome.reason,
      // What the engine actually checked, and the numbers it used. Undefined
      // keys are dropped by JSON.stringify in push(), so a FIRST_SCAN or
      // SAME_DOOR frame carries no numbers and stays as small as it is today.
      // from_door_id, not a second name: the console has the door table.
      check: outcome.check,
      from_door_id: outcome.from_door_id,
      observed_s: outcome.observed_s,
      required_s: outcome.required_s,
      flags_under_s: outcome.flags_under_s,
      ts: evt.ts
    });
  }

  res.json({ decision: 'GRANT', ...outcome });
});

/**
 * HTTP revoke. The Android app does not use this - it writes straight to
 * Firestore and the watcher below picks it up, so the app never needs this
 * server's address. Kept for curl and for the offline demo path.
 */
app.post('/credentials/:id/revoke', async (req, res) => {
  const id = req.params.id;
  if (!store.getCredential(id)) {
    return res.status(404).json({ error: 'UNKNOWN_CREDENTIAL', credential_id: id });
  }

  store.setRevoked(id, true);
  console.log(`\n  REVOKED  ${id}\n`);
  push({ type: 'revoked', credential_id: id, ts: Date.now() });

  try {
    await firestore.setRevoked(id, true);
  } catch (err) {
    console.error('[firestore] revoke mirror failed:', err.message);
  }

  res.json({ ok: true, credential_id: id, revoked: true });
});

/**
 * Nodes and the raw corridor list. The console draws the graph, and a distance
 * matrix cannot tell it which doors are actually joined.
 */
app.get('/doors', (_req, res) => res.json({ nodes: doors, edges }));

/** Walk-time matrix, so the console can show the cost of a move before it happens. */
app.get('/graph', (_req, res) => res.json(travelMatrix()));

app.get('/credentials', (_req, res) => res.json(store.listCredentials()));

app.post('/credentials/:id/restore', (req, res) => {
  const id = req.params.id;
  if (!store.getCredential(id)) {
    return res.status(404).json({ error: 'UNKNOWN_CREDENTIAL', credential_id: id });
  }
  store.setRevoked(id, false);
  firestore.setRevoked(id, false).catch(() => {});
  push({ type: 'restored', credential_id: id, ts: Date.now() });
  res.json({ ok: true, credential_id: id, revoked: false });
});

/**
 * Demo only. Forgets everyone's last-seen position, session and door history so
 * the attack can be replayed without restarting. Does not clear revocations -
 * that would undo the part of the demo you are trying to show.
 *
 * Unauthenticated, and one call blinds the engine - hence DEMO_MODE.
 */
app.post('/debug/reset', (_req, res) => {
  if (!DEMO_MODE) {
    return res.status(403).json({ error: 'DISABLED', detail: 'set DEMO_MODE=1 to enable' });
  }
  const cleared = store.clearLastSeen();
  persistence.save();
  console.log(`\n  [reset] cleared ${cleared} tracked positions\n`);
  push({ type: 'reset', cleared, ts: Date.now() });
  res.json({ ok: true, cleared });
});

/**
 * Demo only. The destructive twin of /debug/reset: everything that one leaves
 * alone on purpose - revocations, the pinned hour, the Firestore alert feed and
 * the counters - is cleared here, returning the whole demo to boot state.
 *
 * Kept as a SEPARATE route rather than a flag on /debug/reset: the light reset is
 * the fast mid-demo "replay the attack" path and must stay one unguarded click.
 *
 * The order below is load-bearing. Traffic stops FIRST or its walkers refill the
 * positions being cleared. The Firestore half is wrapped so an offline or failed
 * call still leaves the local half done - a purge that half-runs is worse than
 * one that reports the error and finishes.
 */
app.post('/debug/purge', async (_req, res) => {
  if (!DEMO_MODE) {
    return res.status(403).json({ error: 'DISABLED', detail: 'set DEMO_MODE=1 to enable' });
  }

  traffic.stop();

  let remote = { anomalies: 0, reviews: 0, unrevoked: 0 };
  let remoteError = null;
  try {
    remote = await firestore.purge();
    await stats.reset();
  } catch (err) {
    remoteError = err.message;
    console.error('[firestore] purge failed:', err.message);
    // This branch runs precisely when Firestore is unhealthy, so the stats write
    // inside reset() will fail too. Its local half - zeroing `pending` - still
    // has to happen, but an unhandled rejection here would take the process down
    // over a blip. Swallow it; reset() resolves immediately when db is null.
    stats.reset().catch(() => {});
  }

  // Local mirror of the un-revoke. Runs even when Firestore failed, so the
  // offline demo path clears too.
  for (const c of store.listCredentials()) store.setRevoked(c.credential_id, false);

  const cleared = store.clearLastSeen();
  persistence.save();
  demoHour = null;

  console.log(
    `\n  [purge] ${cleared} positions, ${remote.anomalies} anomalies, ` +
      `${remote.reviews} reviews, ${remote.unrevoked} revocations lifted\n`
  );

  push({ type: 'purge', cleared, ...remote, ts: Date.now() });
  res.json({ ok: true, cleared, ...remote, firestore_error: remoteError });
});

/**
 * Demo only. Starts and stops sim/normal.js - the background walkers that prove
 * normal traffic never trips the engine. Same DEMO_MODE gate as /debug/reset:
 * an open endpoint that spawns processes has no business in production.
 */
app.post('/debug/traffic/start', (_req, res) => {
  if (!DEMO_MODE) {
    return res.status(403).json({ error: 'DISABLED', detail: 'set DEMO_MODE=1 to enable' });
  }
  const out = traffic.start(PORT);
  if (!out.ok) {
    // 409, not 500 - a second start is a click, not a fault.
    return res.status(out.error === 'ALREADY_RUNNING' ? 409 : 500).json(out);
  }
  push({ type: 'traffic', running: true, ts: Date.now() });
  res.json({ ok: true, running: true });
});

app.post('/debug/traffic/stop', (_req, res) => {
  if (!DEMO_MODE) {
    return res.status(403).json({ error: 'DISABLED', detail: 'set DEMO_MODE=1 to enable' });
  }
  traffic.stop();
  push({ type: 'traffic', running: false, ts: Date.now() });
  res.json({ ok: true, running: false });
});

const ClockSchema = z.object({
  hour: z.number().int().min(0).max(23).nullable()
});

/**
 * Demo only. Pins the hour OFF_HOURS reads so the rule can be shown in daylight.
 * `{ "hour": 3 }` to pin, `{ "hour": null }` to go back to the real clock.
 *
 * Same DEMO_MODE gate as the routes above: this changes what the engine flags,
 * which is not something an open endpoint should be able to do in production.
 */
app.post('/debug/clock', (req, res) => {
  if (!DEMO_MODE) {
    return res.status(403).json({ error: 'DISABLED', detail: 'set DEMO_MODE=1 to enable' });
  }
  const parsed = ClockSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_HOUR', detail: parsed.error.flatten() });
  }
  demoHour = parsed.data.hour;
  console.log(`  [clock] OFF_HOURS reads ${demoHour === null ? 'the real clock' : `${String(demoHour).padStart(2, '0')}:00`}`);
  push({ type: 'clock', demo_hour: demoHour, ts: Date.now() });
  res.json({ ok: true, demo_hour: demoHour });
});

// ---------------------------------------------------------------------------

function logAnomaly(a) {
  const from = doorById[a.from.door_id]?.name ?? a.from.door_id;
  const to = doorById[a.to.door_id]?.name ?? a.to.door_id;
  console.log('\n' + '='.repeat(64));
  console.log(`  ANOMALY  ${a.kind}`);
  console.log(`  ${a.person_name} (${a.person_id})`);
  console.log(`    from  ${from.padEnd(18)} via ${a.from.credential_id}`);
  console.log(`    to    ${to.padEnd(18)} via ${a.to.credential_id}`);
  console.log(`    observed ${a.observed_s}s   required ${a.required_s}s   ${a.severity}x impossible`);
  console.log('='.repeat(64) + '\n');
}

/** Amber. Deliberately quieter than logAnomaly - this is a queue item, not a page. */
function logReview(r) {
  const door = doorById[r.door_id]?.name ?? r.door_id;
  const rules = r.findings.map((f) => f.rule).join(', ');
  console.log(`  REVIEW  ${r.person_name} @ ${door.padEnd(16)} ${rules}`);
}

async function main() {
  await firestore.init();

  store.loadCredentials(await firestore.loadCredentials());
  console.log(`[boot] ${store.stats().credentials} credentials loaded`);

  // Before anything can be ingested: a restart must not hand everyone a free
  // first scan.
  persistence.load();
  persistence.startFlushing();

  // The app's one-tap revoke arrives here, not over HTTP.
  //
  // Updating the registry is enough for the ENGINE - the next scan is denied.
  // It is not enough for the operator console: every other state change on this
  // server pushes (revoke, restore, reset, traffic), so without this the phone
  // says REVOKED while the console's button sits there still enabled, side by
  // side on the same desk. Diff the revoked set and push the difference.
  const revokedIds = () =>
    new Set(store.listCredentials().filter((c) => c.revoked).map((c) => c.credential_id));

  firestore.watchCredentials((list) => {
    const before = revokedIds();

    // Refuses an empty list and keeps the current registry. Nothing changed, so
    // pushing a diff against the unchanged set would be a lie.
    if (!store.loadCredentials(list)) return;

    const after = revokedIds();
    const ts = Date.now();
    for (const id of after) if (!before.has(id)) push({ type: 'revoked', credential_id: id, ts });
    for (const id of before) if (!after.has(id)) push({ type: 'restored', credential_id: id, ts });

    console.log(`[sync] registry updated - ${store.stats().revoked} revoked`);
  });

  // The sim can die on its own (crash, killed by hand). Keep the button honest.
  traffic.onTrafficChange((running) => push({ type: 'traffic', running, ts: Date.now() }));

  stats.startFlushing();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[boot] ingest listening on http://localhost:${PORT}`);
    console.log(`[boot] ${doors.length} doors, firestore ${firestore.enabled ? 'ON' : 'OFF'}, demo mode ${DEMO_MODE ? 'ON' : 'OFF'}\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use - the backend is probably already running.`);
      console.error('  Reuse it, or free the port:');
      console.error(`    Windows   npx kill-port ${PORT}`);
      console.error(`    mac/linux lsof -ti:${PORT} | xargs kill\n`);
      process.exit(1);
    }
    throw err;
  });
}

main().catch((err) => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
