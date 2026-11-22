// Sokoban solver: push-optimal, room by room.
//
// The levels this competition draws are a hallway with independent rooms off it:
// a box pushed out of a room's door can never come back, so every box stays in its
// room and the level's push-optimal count is the sum of its rooms' optima. This
// solver splits a level into its rooms, solves each room with a breadth-first
// search over pushes (so the first solution found is push-optimal), and stitches
// the rooms' moves together. Player walks between pushes are free: only pushes
// are scored, so the stitching only has to walk the player to each push.
//
// Search details, per room:
//   - a state is the boxes' squares plus the player's reachable region (named by
//     its lowest square); two states with the same boxes and the same region are
//     one state, since the player walks freely inside a region.
//   - states expand in order of pushes made, so the first solved state met is
//     push-optimal. Ties break by square order, so the search is deterministic.
//   - two prunings, neither of which removes a solvable state:
//       * a dead square: a square from which no push, ignoring the other boxes,
//         brings a box to any goal (found by pulling back from the goals);
//       * a frozen 2 x 2 block: four squares of walls and boxes holding a box
//         off its goal.
//   - the search is budgeted by work (states kept), never by the clock: a run
//     past the wall budget earns nothing, and a clock cut-off would answer
//     differently from one execution to the next.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budget, in states kept across the whole set: the search never reads the
// clock, so this number is what keeps a run inside the wall budget.
const ROOM_STATE_CAP = 1500000;
const TOTAL_STATE_CAP = 6000000;

const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** Parse XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal: pull back from the goals over open floor. */
function liveSquares(b: Board): Uint8Array {
  const { w, wall, goals } = b;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Scratch space for flood fills, shared by every search: each stamp array carries
// a stamp per square, `stack` the fill's frontier. Stamps only grow, so fills
// never clash. Two stamp arrays: one holds the state being expanded, the other
// the region of each child it makes, so a child's fill never corrupts its
// parent's region test.
const seen = new Int32Array(65536);
const mark = new Int32Array(65536);
const stack = new Int32Array(65536);
let stamp = 0;

/**
 * Flood fill from `from` over open floor avoiding walls and `occupied` boxes,
 * marking squares in `arr` with a fresh stamp. Returns the lowest square
 * reached, which names the region.
 */
function regionLow(b: Board, occupied: Uint8Array, from: number, arr: Int32Array): number {
  const { w, wall } = b;
  const s = ++stamp;
  let low = from;
  let n = 0;
  stack[n++] = from;
  arr[from] = s;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const a = p - w;
    if (wall[a] === 0 && occupied[a] === 0 && arr[a] !== s) { arr[a] = s; stack[n++] = a; }
    const c = p + w;
    if (wall[c] === 0 && occupied[c] === 0 && arr[c] !== s) { arr[c] = s; stack[n++] = c; }
    const l = p - 1;
    if (wall[l] === 0 && occupied[l] === 0 && arr[l] !== s) { arr[l] = s; stack[n++] = l; }
    const r = p + 1;
    if (wall[r] === 0 && occupied[r] === 0 && arr[r] !== s) { arr[r] = s; stack[n++] = r; }
  }
  return low;
}

/** Whether the square `t` (just pushed to) sits in a frozen 2 x 2 block of walls and boxes holding a box off its goal. */
function frozenBlock(b: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = b;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c = a + w;
    const d = c + 1;
    const e = a + 1;
    if (!(wall[a] || occupied[a]) || !(wall[e] || occupied[e]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[e] && !goal[e]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Pack sorted box squares into one number (base `size` digits), exact while size ** boxes stays under 2 ** 53. */
function packBoxes(boxes: number[], size: number): number {
  let k = 0;
  for (const b of boxes) k = k * size + b;
  return k;
}

function unpackBoxes(packed: number, n: number, size: number, out: number[]): void {
  for (let i = n - 1; i >= 0; i--) {
    out[i] = packed % size;
    packed = Math.floor(packed / size);
  }
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case LURD letters. */
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = b;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The player's square after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** States kept across the whole set, the work budget's meter. */
let totalStates = 0;

/**
 * The push-optimal solution of `b`, searching at most `cap` new states:
 * { pushes, moves } (moves in LURD, an upper letter a push), or null when the
 * search gives up, the budget runs out, or the level has no solution.
 *
 * Breadth-first over pushes: states leave the queue in order of pushes made,
 * so the first solved state met is push-optimal. A state's key is its region's
 * lowest square followed by its boxes' squares, as digits in base `size`.
 */
function solvePushes(b: Board, cap: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = b;
  const size = wall.length;
  const n = b.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(b);
  const occupied = new Uint8Array(size);
  const solved = (boxes: number[]): boolean => boxes.every((x) => goal[x]);
  if (b.boxes.some((x) => !live[x])) return null;
  if (solved(b.boxes)) return { pushes: 0, moves: '' };

  // The states in the order found: their boxes packed, the player's square, parent.
  const qBoxes: number[] = [packBoxes(b.boxes, size)];
  const qPlayer: number[] = [b.player];
  const qParent: number[] = [-1];
  const index = new Map<number, number>();
  for (const x of b.boxes) occupied[x] = 1;
  const rootLow = regionLow(b, occupied, b.player, seen);
  index.set(rootLow * Math.pow(size, n) + qBoxes[0], 0);
  for (const x of b.boxes) occupied[x] = 0;

  const cur = new Array<number>(n);
  const nxt = new Array<number>(n);
  let found = -1;
  for (let head = 0; found < 0 && head < qBoxes.length; head++) {
    unpackBoxes(qBoxes[head], n, size, cur);
    for (const x of cur) occupied[x] = 1;
    regionLow(b, occupied, qPlayer[head], seen);
    const here = stamp;
    for (let bi = 0; bi < n && found < 0; bi++) {
      const box = cur[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = box + d;
        // The player must stand on the square behind the box, the target open
        // and alive, and the push must not freeze a 2 x 2 block.
        if (seen[box - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[box] = 0;
        occupied[t] = 1;
        if (frozenBlock(b, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[box] = 1;
          continue;
        }
        for (let i = 0; i < n; i++) nxt[i] = cur[i];
        nxt[bi] = t;
        nxt.sort((a, c) => a - c);
        const packed = packBoxes(nxt, size);
        const low = regionLow(b, occupied, box, mark);
        const key = low * Math.pow(size, n) + packed;
        occupied[t] = 0;
        occupied[box] = 1;
        if (index.has(key)) continue;
        if (qBoxes.length >= cap || totalStates >= TOTAL_STATE_CAP) {
          for (const x of cur) occupied[x] = 0;
          return null;
        }
        index.set(key, qBoxes.length);
        qBoxes.push(packed);
        qPlayer.push(box);
        qParent.push(head);
        totalStates++;
        if (solved(nxt)) {
          found = qBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of cur) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = qParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes;
  for (const s of path) {
    unpackBoxes(qBoxes[s], n, size, nxt);
    const from = boxes.find((x) => !nxt.includes(x))!;
    const to = nxt.find((x) => !boxes.includes(x))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const x of boxes) occupied[x] = 1;
    moves += walkTo(b, occupied, player, from - d);
    for (const x of boxes) occupied[x] = 0;
    moves += dir[3];
    player = from;
    boxes = nxt.slice();
  }
  return { pushes: path.length, moves };
}

type Room = { squares: number[]; boxes: number[]; goals: number[]; done: boolean };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds a
 * box is a room. Null when some part holds more or fewer boxes than goals, a
 * goal falls in the cut, or a box starts in the hallway: then the level is no
 * set of rooms.
 */
function roomsOf(level: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const x of boxes) rooms[part[x]].boxes.push(x);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn, the
 * other rooms' boxes standing as walls (on their goals once their room is done),
 * the player walking on from where the last room left it. A box never leaves
 * its room, so the rooms' optima add up to the level's. Null when a room's
 * search gives up, or the level is no set of rooms and the search over the
 * whole level gives up.
 */
function solveLevel(level: Board): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushes(level, ROOM_STATE_CAP);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const x of other.done ? other.goals : other.boxes) wall[x] = 1;
    }
    const sub: Board = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushes(sub, ROOM_STATE_CAP);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves for a level in XSB: a string of u, d, l and r (an upper letter marks a push; case is not checked). */
function solve(text: string): string {
  const level = parseLevel(text);
  const solved = solveLevel(level);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
