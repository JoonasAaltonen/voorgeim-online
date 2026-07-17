// Battle-board geometry, extracted from `Figma exports/Battle board.svg`
// (viewBox 503x558). Coordinates are in that SVG space; the UI positions coins
// as percentages of the board dimensions, so everything scales at any size.

export const BOARD = { width: 503, height: 558 } as const;

/** Column centers (x), left→right. 4 columns. */
export const COLS_X = [208, 296, 384, 473] as const;

/**
 * Row centers (y) per side, ordered FRONT→BACK (front = nearest the frontline).
 * Deployment fills from the front row per the rules.
 */
export const SIDE_ROWS_Y = {
  top: [207, 118, 30],
  bottom: [351, 439, 527],
} as const;

/** The dashed frontline sits between the two sides. */
export const FRONTLINE_Y = 279;

/** Indirect-fire support slot for each side (single artillery, off-grid, left). */
export const SUPPORT_SLOT = {
  top: { x: 68, y: 104 },
  bottom: { x: 68, y: 452 },
} as const;

export const CELL_RADIUS = 27.6;
export const SUPPORT_RADIUS = 37;

/** Rows per side (front, middle, back). */
export const ROWS_PER_SIDE = 3;
/** Back-row index — units here may withdraw. */
export const BACK_ROW = ROWS_PER_SIDE - 1;

export type Side = 'top' | 'bottom';

export interface Cell {
  id: string;
  side: Side;
  /** 0 = frontline row, increasing toward the back. */
  row: number;
  col: number;
  x: number;
  y: number;
  kind: 'grid' | 'support';
  /**
   * Global grid coordinates spanning both sides (gr 0 = top back … gr 5 =
   * bottom back), used for 8-direction adjacency across the frontline.
   * -1 for support slots (off-grid).
   */
  gr: number;
  gc: number;
}

/** top side: front row (row0) is gr2 …; bottom side: front row (row0) is gr3 … */
function globalRow(side: Side, row: number): number {
  return side === 'top' ? 2 - row : 3 + row;
}

/** All 24 grid cells plus the 2 support slots. */
export function boardCells(): Cell[] {
  const cells: Cell[] = [];
  (['top', 'bottom'] as Side[]).forEach((side) => {
    SIDE_ROWS_Y[side].forEach((y, row) => {
      COLS_X.forEach((x, col) => {
        cells.push({
          id: `${side}-r${row}-c${col}`,
          side,
          row,
          col,
          x,
          y,
          kind: 'grid',
          gr: globalRow(side, row),
          gc: col,
        });
      });
    });
    const s = SUPPORT_SLOT[side];
    cells.push({ id: `${side}-support`, side, row: -1, col: -1, x: s.x, y: s.y, kind: 'support', gr: -1, gc: -1 });
  });
  return cells;
}

const ALL_CELLS = boardCells();

export const CELL_BY_ID: Record<string, Cell> = Object.fromEntries(
  ALL_CELLS.map((c) => [c.id, c]),
);

const CELL_BY_GRID: Record<string, Cell> = Object.fromEntries(
  ALL_CELLS.filter((c) => c.kind === 'grid').map((c) => [`${c.gr},${c.gc}`, c]),
);

/** 8-direction neighbors of a grid cell (crosses the frontline at the front rows). */
export function neighborIds(cellId: string): string[] {
  const c = CELL_BY_ID[cellId];
  if (!c || c.kind !== 'grid') return [];
  const out: string[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const n = CELL_BY_GRID[`${c.gr + dr},${c.gc + dc}`];
      if (n) out.push(n.id);
    }
  }
  return out;
}

export function areAdjacent(a: string, b: string): boolean {
  return neighborIds(a).includes(b);
}

// Artillery extended fire: a perpendicular line of 3 cells at distance 2 in all
// four orthogonal directions (symmetric, no facing). See Artillery fire arc.png.
const ARC_OFFSETS: Array<[number, number]> = [
  [2, -1], [2, 0], [2, 1], // forward line (down)
  [-2, -1], [-2, 0], [-2, 1], // rear line (up)
  [-1, 2], [0, 2], [1, 2], // right line
  [-1, -2], [0, -2], [1, -2], // left line
];

/**
 * Global row an off-grid indirect-fire support shell "comes from": behind its
 * own side, so it strikes the far side frontally but takes a fortification on
 * its own side from the rear.
 */
export const SUPPORT_ORIGIN_GR = { top: -1, bottom: ROWS_PER_SIDE * 2 } as const;

/**
 * Fortifications face the frontline. They cover the front and both flanks — 5
 * of the 8 surrounding positions — leaving the rear and the rear corners open.
 * `fromGr` is the global row the attack originates from.
 */
export function fortCovers(fortCellId: string, fromGr: number): boolean {
  const c = CELL_BY_ID[fortCellId];
  if (!c || c.kind !== 'grid') return false;
  return c.side === 'bottom' ? fromGr <= c.gr : fromGr >= c.gr;
}

/** Cells an artillery unit can reach with extended (ranged) fire. */
export function artilleryArcCells(cellId: string): string[] {
  const c = CELL_BY_ID[cellId];
  if (!c || c.kind !== 'grid') return [];
  const out: string[] = [];
  for (const [dr, dc] of ARC_OFFSETS) {
    const n = CELL_BY_GRID[`${c.gr + dr},${c.gc + dc}`];
    if (n) out.push(n.id);
  }
  return out;
}
