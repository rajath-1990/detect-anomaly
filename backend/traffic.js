/**
 * Background traffic, started from the operator console.
 *
 * This spawns the real sim/normal.js rather than reimplementing walkers in the
 * browser. normal.js IS the false-positive test - every walker waits at least
 * 1.4x the edge minimum, which is the property that makes "zero anomalies in
 * normal traffic" mean something. A second copy of those pacing rules living in
 * the frontend would drift from it, and the drift would be invisible.
 *
 * The one piece of state here is a child-process handle. That is process
 * lifecycle, not detection state, so it does not belong in store.js - but keep
 * this module to exactly that and nothing else.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SIM_PATH = join(here, '..', 'sim', 'normal.js');

let child = null;
let stopping = false;   // an intentional stop already told the console
let onChange = () => {};

/** Called when the sim exits on its own, so the console's button can catch up. */
export function onTrafficChange(fn) {
  onChange = fn;
}

export function isRunning() {
  return child !== null;
}

/**
 * Two copies of normal.js running at once DO generate false anomalies - each
 * keeps its own idea of where every walker is standing, so the two disagree and
 * the engine correctly reports the impossible move. Hence the guard.
 */
export function start(port, rate = 2000) {
  if (child) return { ok: false, error: 'ALREADY_RUNNING' };
  if (!existsSync(SIM_PATH)) return { ok: false, error: 'SIM_NOT_FOUND', detail: SIM_PATH };

  child = spawn(
    process.execPath,
    [SIM_PATH, `--url=http://localhost:${port}`, `--rate=${rate}`],
    { stdio: 'ignore' }
  );

  // Only announce an exit nobody asked for. A deliberate stop has already been
  // reported by the caller, and two notices read as two events.
  const gone = () => {
    child = null;
    if (!stopping) onChange(false);
    stopping = false;
  };
  child.on('exit', gone);
  child.on('error', gone);

  console.log(`  [traffic] background walkers started (${rate}ms)`);
  return { ok: true };
}

export function stop() {
  if (!child) return { ok: true, already: true };
  // A single node child with no grandchildren, so a plain kill is enough even
  // on Windows. The 'exit' handler above nulls the handle.
  stopping = true;
  child.kill();
  console.log('  [traffic] background walkers stopped');
  return { ok: true };
}

// A backend that dies must not leave walkers hammering a dead port.
process.on('exit', () => {
  if (child) child.kill();
});

// Registering a signal handler replaces node's default "just exit", so these
// have to exit by hand - otherwise Ctrl+C stops killing the server.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (child) child.kill();
    process.exit(0);
  });
}
