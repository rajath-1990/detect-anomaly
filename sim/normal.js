/**
 * Normal traffic generator.
 *
 * Walks virtual employees along real graph edges at realistic speeds, so the
 * dashboard has calm background traffic for the attack to tear through.
 *
 * By construction this can NEVER produce an anomaly: every move waits at least
 * 1.4x the minimum walk time for the edge being crossed, well above the 0.8
 * threshold. If this script ever triggers an alert, a graph edge is overestimated
 * in doors.json - that is exactly what verification step 4 is checking.
 *
 *   node normal.js                 default 1 event / 2s
 *   node normal.js --rate=1000     faster
 *   node normal.js --url=http://192.168.1.14:8000
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { minTravelSeconds, neighbors, doors } from '../backend/graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const allCredentials = JSON.parse(
  readFileSync(join(here, '..', 'backend', 'credentials.json'), 'utf8')
);

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const BASE_URL = arg('url', 'http://localhost:8000');
const RATE_MS = Number(arg('rate', 2000));

// Scatter people across the building rather than queueing them all at the gate.
// Starting everyone at one door means two minutes of dead air followed by ten
// identical arrivals at the same place - on a projector that reads as a bug.
const startDoors = doors.map((d) => d.door_id);

/**
 * The attack subject is NOT simulated.
 *
 * This script tracks its own idea of where each walker is. The attack moves the
 * same person server-side, so if both drove Ravi, the next normal move would be
 * computed from a stale position and fire a false anomaly seconds after the
 * demo's big moment. Leave him to attack.js.
 */
const ATTACK_PERSON = 'E-1123';

// One walker per person. Sneha holds two credentials; the walker carries her
// badge, leaving the mobile key unused.
const walkers = [];
const seen = new Set();
for (const c of allCredentials) {
  if (c.shared || c.person_id === ATTACK_PERSON || seen.has(c.person_id)) continue;
  seen.add(c.person_id);

  const start = startDoors[Math.floor(Math.random() * startDoors.length)];
  walkers.push({
    credential_id: c.credential_id,
    name: c.person_name,
    at: start,
    // Arriving at their own start door produces each walker's first scan within
    // the opening seconds, seeding position without any travel wait.
    movingTo: start,
    arriveAt: Date.now() + Math.random() * 12_000
  });
}

const rand = (min, max) => min + Math.random() * (max - min);

function planMove(w, now) {
  const options = neighbors(w.at);

  // Weight by 1/seconds so short hops dominate, like real movement does.
  // Without this the 900s inter-building edge gets picked as often as a 20s
  // corridor and half the population parks itself for 20 minutes.
  const weights = options.map((d) => 1 / minTravelSeconds(w.at, d));
  const total = weights.reduce((a, b) => a + b, 0);

  let roll = Math.random() * total;
  let dest = options[options.length - 1];
  for (let i = 0; i < options.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) {
      dest = options[i];
      break;
    }
  }

  const need = minTravelSeconds(w.at, dest);

  // 1.4x to 3x the minimum: a brisk walker through to someone who stopped to chat.
  w.movingTo = dest;
  w.arriveAt = now + need * rand(1.4, 3.0) * 1000;
}

async function post(event) {
  try {
    const res = await fetch(`${BASE_URL}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event)
    });
    return await res.json();
  } catch (err) {
    console.error(`  ! backend unreachable at ${BASE_URL} - is it running?`);
    return null;
  }
}

let emitted = 0;

async function tick() {
  const now = Date.now();

  for (const w of walkers) {
    if (w.movingTo === null && now >= w.arriveAt) planMove(w, now);
  }

  // At most one event per tick. A walker who has to wait their turn only ends up
  // with a LONGER elapsed time, which can never create a false anomaly.
  const arrived = walkers.find((w) => w.movingTo !== null && now >= w.arriveAt);
  if (!arrived) return;

  const door = arrived.movingTo;
  arrived.at = door;
  arrived.movingTo = null;
  arrived.arriveAt = now + rand(5, 30) * 1000; // dwell before setting off again

  const result = await post({
    credential_id: arrived.credential_id,
    door_id: door,
    reader_id: `R-${door.slice(-3)}`,
    result: 'GRANTED'
  });

  emitted += 1;
  if (result && result.verdict === 'ANOMALY') {
    console.error(`\n  FALSE POSITIVE - ${arrived.name} at ${door}`);
    console.error('  A doors.json edge is overestimated.\n', result, '\n');
  } else {
    process.stdout.write(
      `\r  ${emitted} events sent   last: ${arrived.name} -> ${door}          `
    );
  }
}

console.log(`normal traffic -> ${BASE_URL}`);
console.log(`${walkers.length} employees, 1 event / ${RATE_MS}ms`);
console.log('expect ZERO anomalies. ctrl-c to stop.\n');
console.log('Firestore free tier is 20k writes/day - do not leave this running overnight.\n');

setInterval(tick, RATE_MS);
