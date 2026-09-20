/**
 * Pushes doors + credential registry into Firestore. Idempotent - safe to rerun.
 * Requires GOOGLE_APPLICATION_CREDENTIALS. Without it, run nothing: the backend
 * falls back to the same local JSON automatically.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { firestore } from './firestore.js';
import { doors } from './graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const credentials = JSON.parse(readFileSync(join(here, 'credentials.json'), 'utf8'));

const live = await firestore.init();
if (!live) {
  console.error('\nNo Firestore credentials configured - nothing to seed.');
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS in backend/.env first.\n');
  process.exit(1);
}

await firestore.seedDoors(doors);
console.log(`seeded ${doors.length} doors`);

await firestore.seedCredentials(credentials);
console.log(`seeded ${credentials.length} credentials`);

console.log('\ndone.');
process.exit(0);
