/**
 * Survives a restart.
 *
 * lastSeen used to live only in RAM, which meant every deploy, crash or scale
 * event handed the whole population one unchecked scan each: the first scan
 * after a restart has no prior position, so it can never be impossible. That is
 * a detection hole you can open on demand by killing the process.
 *
 * This serialises store.js and nothing else - store stays the single source of
 * truth for live state, this is only a reader and writer of it.
 *
 * A local file is the SINGLE-INSTANCE fix. Multi-instance needs the Redis swap
 * store.js was shaped for, because two processes with two Maps silently halve
 * detection whether or not either one persists.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { store } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, '.state.json');
const TMP = `${FILE}.tmp`;

/** Write-behind interval. The hot path never waits on disk. */
const FLUSH_MS = 2000;

export const persistence = {
  /** Called once at boot, before the listener starts. Never throws. */
  load() {
    if (!existsSync(FILE)) return 0;
    try {
      const restored = store.restore(JSON.parse(readFileSync(FILE, 'utf8')));
      console.log(`[state] restored ${restored} tracked positions`);
      return restored;
    } catch (err) {
      console.error('[state] restore failed, starting cold:', err.message);
      return 0;
    }
  },

  /**
   * Snapshot via temp-file + rename so a crash mid-write cannot leave a
   * half-written file that poisons the next boot.
   */
  save() {
    try {
      writeFileSync(TMP, JSON.stringify(store.snapshot()));
      renameSync(TMP, FILE);
    } catch (err) {
      console.error('[state] snapshot failed:', err.message);
    }
  },

  startFlushing() {
    const timer = setInterval(() => {
      if (store.consumeDirty()) persistence.save();
    }, FLUSH_MS);
    timer.unref();
    return timer;
  },

  /** Demo only - drops the file so the next boot is genuinely cold. */
  clear() {
    try {
      if (existsSync(FILE)) unlinkSync(FILE);
    } catch (err) {
      console.error('[state] clear failed:', err.message);
    }
  }
};
