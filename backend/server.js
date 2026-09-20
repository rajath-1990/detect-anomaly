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
import { doors, doorById, isKnownDoor, travelMatrix } from './graph.js';
import { firestore, stats } from './firestore.js';

const PORT = Number(process.env.PORT ?? 8000);

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
  const evt = { ...parsed.data, ts: Date.now() };

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
  } else {
    console.log(`  ok    ${evt.credential_id} @ ${evt.door_id.padEnd(12)} ${person?.person_name ?? '?'}`);
    push({
      type: 'scan',
      credential_id: evt.credential_id,
      door_id: evt.door_id,
      door_name: doorById[evt.door_id]?.name,
      person_name: person?.person_name ?? '?',
      reason: outcome.reason,
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

app.get('/doors', (_req, res) => res.json(doors));

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
 * Demo only. Forgets everyone's last-seen position so the attack can be replayed
 * without restarting. Does not clear revocations - that would undo the part of
 * the demo you are trying to show.
 */
app.post('/debug/reset', (_req, res) => {
  const cleared = store.clearLastSeen();
  console.log(`\n  [reset] cleared ${cleared} tracked positions\n`);
  push({ type: 'reset', cleared, ts: Date.now() });
  res.json({ ok: true, cleared });
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

async function main() {
  await firestore.init();

  store.loadCredentials(await firestore.loadCredentials());
  console.log(`[boot] ${store.stats().credentials} credentials loaded`);

  // The app's one-tap revoke arrives here, not over HTTP.
  firestore.watchCredentials((list) => {
    store.loadCredentials(list);
    console.log(`[sync] registry updated - ${store.stats().revoked} revoked`);
  });

  stats.startFlushing();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[boot] ingest listening on http://localhost:${PORT}`);
    console.log(`[boot] ${doors.length} doors, firestore ${firestore.enabled ? 'ON' : 'OFF'}\n`);
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
