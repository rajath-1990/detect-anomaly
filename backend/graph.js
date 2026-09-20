/**
 * Door adjacency graph.
 *
 * Straight-line distance is wrong indoors: two doors 5m apart through a wall can
 * be a 90-second walk. So travel time comes from a graph of real walk seconds
 * between adjacent doors, with all-pairs shortest paths precomputed at boot.
 *
 * Floyd-Warshall runs once on ~10 nodes, then every lookup is O(1) — the hot
 * path never runs a pathfinder.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, 'doors.json'), 'utf8'));

export const doors = raw.nodes;
export const doorById = Object.fromEntries(raw.nodes.map((n) => [n.door_id, n]));

const ids = raw.nodes.map((n) => n.door_id);

// dist[a][b] = minimum walk seconds. Infinity = no walking route at all
// (genuinely separate sites), which makes any movement between them impossible
// by definition — the check falls out of the math for free.
const dist = {};
const adjacency = {};

for (const a of ids) {
  dist[a] = {};
  adjacency[a] = new Set();
  for (const b of ids) dist[a][b] = a === b ? 0 : Infinity;
}

for (const [a, b, seconds] of raw.edges) {
  if (!(a in dist) || !(b in dist)) {
    throw new Error(`doors.json: edge references unknown door (${a} <-> ${b})`);
  }
  // Doors are walkable in both directions.
  dist[a][b] = Math.min(dist[a][b], seconds);
  dist[b][a] = Math.min(dist[b][a], seconds);
  adjacency[a].add(b);
  adjacency[b].add(a);
}

for (const k of ids) {
  for (const i of ids) {
    if (dist[i][k] === Infinity) continue;
    for (const j of ids) {
      const viaK = dist[i][k] + dist[k][j];
      if (viaK < dist[i][j]) dist[i][j] = viaK;
    }
  }
}

/** Minimum seconds a human needs to get from door `a` to door `b`. */
export function minTravelSeconds(a, b) {
  return dist[a]?.[b] ?? Infinity;
}

/**
 * Full all-pairs matrix for the operator console, so it can show the walk time
 * from wherever the selected person is standing. Infinity is not valid JSON;
 * unreachable pairs serialise as null.
 */
export function travelMatrix() {
  const out = {};
  for (const a of ids) {
    out[a] = {};
    for (const b of ids) out[a][b] = dist[a][b] === Infinity ? null : dist[a][b];
  }
  return out;
}

/** Doors directly reachable from `a` in one hop. Used by the traffic simulator. */
export function neighbors(a) {
  return [...(adjacency[a] ?? [])];
}

export function isKnownDoor(id) {
  return id in dist;
}

// `node graph.js` prints the full matrix — quick sanity check on the walk times.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('', 13) + ids.map((i) => pad(i.replace('D-', ''), 11)).join(''));
  for (const a of ids) {
    const row = ids.map((b) => pad(dist[a][b] === Infinity ? '-' : dist[a][b], 11));
    console.log(pad(a, 13) + row.join(''));
  }
}
