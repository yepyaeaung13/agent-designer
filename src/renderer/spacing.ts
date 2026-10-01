export type Box = { x: number; y: number; width: number; height: number };
export type Measure = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  value: number;
};
export function measureSpacing(a: Box, b: Box, zoom: number): Measure[] {
  const result: Measure[] = [];
  const add = (x1: number, y1: number, x2: number, y2: number) => {
    const value = Math.hypot(x2 - x1, y2 - y1) / zoom;
    if (value > 0.01)
      result.push({ x1, y1, x2, y2, value: Math.round(value * 10) / 10 });
  };
  const ar = a.x + a.width,
    ab = a.y + a.height,
    br = b.x + b.width,
    bb = b.y + b.height;
  const y =
    Math.max(a.y, b.y) <= Math.min(ab, bb)
      ? (Math.max(a.y, b.y) + Math.min(ab, bb)) / 2
      : a.y + a.height / 2;
  const x =
    Math.max(a.x, b.x) <= Math.min(ar, br)
      ? (Math.max(a.x, b.x) + Math.min(ar, br)) / 2
      : a.x + a.width / 2;
  if (ar <= b.x) add(ar, y, b.x, y);
  else if (br <= a.x) add(br, y, a.x, y);
  else {
    add(a.x, y, b.x, y);
    add(ar, y, br, y);
  }
  if (ab <= b.y) add(x, ab, x, b.y);
  else if (bb <= a.y) add(x, bb, x, a.y);
  else {
    add(x, a.y, x, b.y);
    add(x, ab, x, bb);
  }
  return result;
}
