/**
 * The attack. Injects a physically impossible movement.
 *
 *   node attack.js              cloned badge   - same credential, two distant doors
 *   node attack.js --steal      stolen/shared  - badge here, mobile key there
 *   node attack.js --pooled     control case   - visitor pass, must NOT alert
 *   node attack.js --gap=4      seconds between the two scans
 *   node attack.js --url=http://192.168.1.14:8000
 *
 * Lobby -> Server Room is a 110-second walk (lobby, elevator, 3rd floor hall,
 * server room). Doing it in 4 seconds is not a fast employee.
 */

import { minTravelSeconds, doorById } from '../backend/graph.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const BASE_URL = arg('url', 'http://localhost:8000');
const GAP_S = Number(arg('gap', 4));

const FROM = 'D-LOBBY';
const TO = 'D-SERVER';

const SCENARIOS = {
  clone: {
    title: 'CLONED BADGE - same credential at both doors',
    first: 'B-4471',
    second: 'B-4471',
    expect: 'ANOMALY / CLONED_CREDENTIAL'
  },
  steal: {
    title: 'STOLEN CREDENTIAL - badge here, mobile key there, same person',
    first: 'B-4471',
    second: 'M-9902',
    expect: 'ANOMALY / CREDENTIAL_SHARED_OR_STOLEN'
  },
  pooled: {
    title: 'CONTROL - pooled visitor pass, many bodies use it legitimately',
    first: 'V-0001',
    second: 'V-0001',
    expect: 'OK / POOLED_CREDENTIAL  (must NOT alert)'
  }
};

const mode = flag('steal') ? 'steal' : flag('pooled') ? 'pooled' : 'clone';
const scenario = SCENARIOS[mode];

async function scan(credentialId, doorId) {
  const res = await fetch(`${BASE_URL}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      credential_id: credentialId,
      door_id: doorId,
      reader_id: `R-${doorId.slice(-3)}`,
      result: 'GRANTED'
    })
  });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const required = minTravelSeconds(FROM, TO);

console.log('\n' + '='.repeat(64));
console.log(`  ${scenario.title}`);
console.log('='.repeat(64));
console.log(`  ${doorById[FROM].name} -> ${doorById[TO].name}`);
console.log(`  minimum walk: ${required}s     attack gap: ${GAP_S}s`);
console.log(`  expecting: ${scenario.expect}\n`);

try {
  console.log(`  [1] ${scenario.first} @ ${doorById[FROM].name}`);
  const a = await scan(scenario.first, FROM);
  console.log(`      -> ${a.decision} ${a.verdict ?? ''} ${a.reason ?? ''}`);

  if (a.decision === 'DENY') {
    console.log('\n  Credential already revoked. Nothing more to inject.');
    console.log('  That is the loop closing - the attack cannot proceed.\n');
    process.exit(0);
  }

  console.log(`\n  ... waiting ${GAP_S}s ...\n`);
  await sleep(GAP_S * 1000);

  console.log(`  [2] ${scenario.second} @ ${doorById[TO].name}`);
  const b = await scan(scenario.second, TO);
  console.log(`      -> ${b.decision} ${b.verdict} ${b.kind ?? b.reason ?? ''}`);

  if (b.verdict === 'ANOMALY') {
    console.log('\n' + '-'.repeat(64));
    console.log(`  ${b.person_name} (${b.person_id})`);
    console.log(`  observed ${b.observed_s}s vs required ${b.required_s}s`);
    console.log(`  ${b.severity}x faster than physically possible`);
    console.log('-'.repeat(64));
    console.log('\n  Check the phone.\n');
  } else if (mode === 'pooled') {
    console.log('\n  Correct - pooled credentials are exempt from person-level physics.\n');
  } else {
    console.log('\n  No anomaly raised. Something is wrong - check the backend console.\n');
    process.exit(1);
  }
} catch (err) {
  console.error(`\n  ! backend unreachable at ${BASE_URL}`);
  console.error('    start it with: node backend/server.js\n');
  process.exit(1);
}
