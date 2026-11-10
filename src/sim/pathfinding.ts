import type { SimSite } from './types';

/**
 * A* over a settlement's walkability grid (8 neighbours, no corner cutting),
 * followed by line-of-sight smoothing. Deterministic. Returns waypoints as
 * flat [e0, n0, e1, n1, ...] in metres, or null when unreachable.
 */
const SQRT2 = Math.SQRT2;
let gScore = new Float32Array(0);
let came = new Int32Array(0);
let stamp = new Uint32Array(0);
let closed = new Uint32Array(0);
let heap = new Int32Array(0);
let fScore = new Float32Array(0);
let epoch = 0;

function ensure(n: number): void {
  if (gScore.length >= n) return;
  gScore = new Float32Array(n);
  came = new Int32Array(n);
  stamp = new Uint32Array(n);
  closed = new Uint32Array(n);
  heap = new Int32Array(n * 4);
  fScore = new Float32Array(n);
}

export function cellOf(site: SimSite, e: number, n: number): number {
  const half = (site.size * site.cell) / 2;
  const i = Math.floor((e + half) / site.cell), j = Math.floor((n + half) / site.cell);
  if (i < 0 || j < 0 || i >= site.size || j >= site.size) return -1;
  return j * site.size + i;
}

export function isWalkable(site: SimSite, e: number, n: number): boolean {
  const c = cellOf(site, e, n);
  return c >= 0 && site.walk[c] === 1;
}

/** Nearest walkable cell centre within `maxCells` rings (deterministic scan order). */
export function nearestWalkable(site: SimSite, e: number, n: number, maxCells = 6): { e: number; n: number } | null {
  if (isWalkable(site, e, n)) return { e, n };
  const half = (site.size * site.cell) / 2;
  const ci = Math.floor((e + half) / site.cell), cj = Math.floor((n + half) / site.cell);
  let best: { e: number; n: number } | null = null, bestD = Infinity;
  for (let r = 1; r <= maxCells && !best; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= site.size || j >= site.size || !site.walk[j * site.size + i]) continue;
        const pe = (i + 0.5) * site.cell - half, pn = (j + 0.5) * site.cell - half;
        const d = (pe - e) * (pe - e) + (pn - n) * (pn - n);
        if (d < bestD) { bestD = d; best = { e: pe, n: pn }; }
      }
    }
  }
  return best;
}

/** True when the straight segment only crosses walkable cells. */
export function lineOfSight(site: SimSite, e0: number, n0: number, e1: number, n1: number): boolean {
  const d = Math.hypot(e1 - e0, n1 - n0);
  const steps = Math.max(1, Math.ceil(d / (site.cell * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    if (!isWalkable(site, e0 + (e1 - e0) * t, n0 + (n1 - n0) * t)) return false;
  }
  return true;
}

export function findPath(site: SimSite, e0: number, n0: number, e1: number, n1: number): number[] | null {
  const start = cellOf(site, e0, n0), goal = cellOf(site, e1, n1);
  if (goal < 0 || !site.walk[goal] || start < 0) return null;
  if (lineOfSight(site, e0, n0, e1, n1)) return [e1, n1];
  const S = site.size, N = S * S;
  ensure(N);
  epoch++;
  const gi = goal % S, gj = (goal / S) | 0;
  const h = (c: number) => {
    const dx = Math.abs((c % S) - gi), dy = Math.abs(((c / S) | 0) - gj);
    return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
  };
  let len = 0;
  const push = (c: number) => {
    let p = len++;
    const f = fScore[c];
    while (p > 0) {
      const par = (p - 1) >> 1;
      const pc = heap[par];
      if (fScore[pc] < f || (fScore[pc] === f && pc <= c)) break;
      heap[p] = pc;
      p = par;
    }
    heap[p] = c;
  };
  const pop = () => {
    const top = heap[0];
    const last = heap[--len];
    const f = fScore[last];
    let p = 0;
    for (;;) {
      let ch = p * 2 + 1;
      if (ch >= len) break;
      if (ch + 1 < len && (fScore[heap[ch + 1]] < fScore[heap[ch]] || (fScore[heap[ch + 1]] === fScore[heap[ch]] && heap[ch + 1] < heap[ch]))) ch++;
      if (fScore[heap[ch]] > f || (fScore[heap[ch]] === f && heap[ch] >= last)) break;
      heap[p] = heap[ch];
      p = ch;
    }
    heap[p] = last;
    return top;
  };
  gScore[start] = 0;
  fScore[start] = h(start);
  stamp[start] = epoch;
  came[start] = -1;
  push(start);
  let found = false;
  let expansions = 0;
  while (len > 0 && expansions < 30000 && len < heap.length - 16) {
    const c = pop();
    if (closed[c] === epoch) continue;
    closed[c] = epoch;
    if (c === goal) { found = true; break; }
    expansions++;
    const ci = c % S, cj = (c / S) | 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= S || j >= S) continue;
        const nb = j * S + i;
        // the start cell may be unwalkable (e.g. standing in a doorway): allow leaving it
        if (!site.walk[nb] || closed[nb] === epoch) continue;
        if (di && dj && (!site.walk[cj * S + i] || !site.walk[j * S + ci])) continue;
        const g = gScore[c] + (di && dj ? SQRT2 : 1);
        if (stamp[nb] !== epoch || g < gScore[nb]) {
          stamp[nb] = epoch;
          gScore[nb] = g;
          fScore[nb] = g + h(nb);
          came[nb] = c;
          push(nb);
        }
      }
    }
  }
  if (!found) return null;
  // reconstruct (goal -> start), then smooth with line of sight
  const cells: number[] = [];
  for (let c = goal; c !== -1 && c !== start; c = came[c]) cells.push(c);
  cells.reverse();
  const half = (S * site.cell) / 2;
  const pts: number[] = [];
  for (const c of cells) pts.push(((c % S) + 0.5) * site.cell - half, (((c / S) | 0) + 0.5) * site.cell - half);
  pts[pts.length - 2] = e1;
  pts[pts.length - 1] = n1;
  const out: number[] = [];
  let ae = e0, an = n0, idx = 0;
  const count = pts.length / 2;
  while (idx < count) {
    let far = idx;
    // furthest waypoint visible from the anchor (bounded look-ahead keeps it cheap)
    for (let k = Math.min(count - 1, idx + 40); k > idx; k--) {
      if (lineOfSight(site, ae, an, pts[k * 2], pts[k * 2 + 1])) { far = k; break; }
    }
    ae = pts[far * 2];
    an = pts[far * 2 + 1];
    out.push(ae, an);
    idx = far + 1;
  }
  return out;
}
