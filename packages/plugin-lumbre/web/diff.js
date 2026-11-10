// Line diff for the review panel (Myers' O(ND) algorithm), plus hunks with context lines.

export const MAX_DIFF_LINES = 6000;
const split = (text) =>
  text === null || text === undefined || text === ""
    ? []
    : String(text).replace(/\r\n?/g, "\n").split("\n");

/**
 * `before`/`after` as lines: [{ type: "same"|"add"|"del", text, a, b }] with 1-based line numbers
 * (`a` in before, `b` in after). Returns null when the files are too large to compare here.
 */
export function lineDiff(before, after) {
  const a = split(before);
  const b = split(after);
  if (a.length + b.length > MAX_DIFF_LINES) return null;
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))
          ? (v.get(k + 1) ?? 0)
          : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  // Walk the trace backwards to recover the edit script.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "same", text: a[x - 1], a: x, b: y });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ type: "add", text: b[y - 1], b: y });
    else ops.push({ type: "del", text: a[x - 1], a: x });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ type: "same", text: a[x - 1], a: x, b: y });
    x--;
    y--;
  }
  return ops.reverse();
}

/** Groups a diff into hunks with `context` unchanged lines around each change. */
export function hunks(ops, context = 3) {
  if (!ops) return null;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.type === "same") return;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++)
      keep[j] = true;
  });
  const out = [];
  let current = null;
  ops.forEach((op, i) => {
    if (!keep[i]) {
      current = null;
      return;
    }
    if (!current) {
      current = [];
      out.push(current);
    }
    current.push(op);
  });
  return out;
}

/** Added and removed line counts. */
export function stats(ops) {
  if (!ops) return { added: 0, removed: 0 };
  return {
    added: ops.filter((o) => o.type === "add").length,
    removed: ops.filter((o) => o.type === "del").length,
  };
}
