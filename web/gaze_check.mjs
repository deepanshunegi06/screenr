// Verifies the gaze regression against a synthetic person. Run: node gaze_check.mjs
const RIDGE = 0.02;
const rowX = (f) => [f.ixL, f.ixR, f.yaw / 30, 1];
const rowY = (f) => [f.iyL, f.iyR, f.pitch / 30, 1];

function solve(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / a[i][i]);
}
function ridgeFit(rows, targets) {
  const n = rows[0].length;
  const xtx = Array.from({ length: n }, () => Array(n).fill(0));
  const xty = Array(n).fill(0);
  for (let s = 0; s < rows.length; s++)
    for (let i = 0; i < n; i++) {
      xty[i] += rows[s][i] * targets[s];
      for (let j = 0; j < n; j++) xtx[i][j] += rows[s][i] * rows[s][j];
    }
  for (let i = 0; i < n - 1; i++) xtx[i][i] += RIDGE;
  return solve(xtx, xty);
}
const dot = (w, r) => w.reduce((s, wi, i) => s + wi * r[i], 0);

console.log("solver 2x2:", solve([[2,1],[1,3]],[5,10]).map(v=>v.toFixed(3)), "expect 1.000, 3.000");

// A synthetic person: eyes move a little, head follows a little.
const make = (sx, sy) => {
  const ix = (sx - 0.5) / 6, iy = (sy - 0.5) / 6;
  return { ixL: ix, ixR: ix, iyL: iy, iyR: iy, yaw: (sx - 0.5) * 12, pitch: (sy - 0.5) * 10 };
};
const POINTS = [[0.5,0.5],[0.04,0.5],[0.96,0.5],[0.5,0.05],[0.5,0.95]];
const samples = POINTS.map(([sx, sy]) => ({ f: make(sx, sy), sx, sy }));
const wx = ridgeFit(samples.map(s=>rowX(s.f)), samples.map(s=>s.sx));
const wy = ridgeFit(samples.map(s=>rowY(s.f)), samples.map(s=>s.sy));
const predict = (f) => ({ sx: dot(wx, rowX(f)), sy: dot(wy, rowY(f)) });

const preds = POINTS.map(([sx,sy]) => predict(make(sx,sy)));
const b = {
  minX: Math.min(...preds.map(p=>p.sx)), maxX: Math.max(...preds.map(p=>p.sx)),
  minY: Math.min(...preds.map(p=>p.sy)), maxY: Math.max(...preds.map(p=>p.sy)),
};
console.log("calibrated span  x:", (b.maxX-b.minX).toFixed(2), " y:", (b.maxY-b.minY).toFixed(2));

const OVER = 0.35;
const padX = (b.maxX-b.minX)*OVER, padY = (b.maxY-b.minY)*OVER;
const cases = [
  ["phone in lap",            0.5, 1.8, true],
  ["quick glance at phone",   0.5, 1.4, true],
  ["second monitor, right",   2.0, 0.5, true],
  ["bottom of own screen",    0.5, 0.98, false],
  ["corner of own screen",    0.02, 0.95, false],
  ["dead centre",             0.5, 0.5, false],
];
let failures = 0;
for (const [label, sx, sy, expectOff] of cases) {
  const p = predict(make(sx, sy));
  const off = p.sx < b.minX-padX || p.sx > b.maxX+padX || p.sy > b.maxY+padY || p.sy < b.minY-padY;
  const ok = off === expectOff;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(24)} (${p.sx.toFixed(2)}, ${p.sy.toFixed(2)}) -> ${off ? "off screen" : "on screen"}`);
}
console.log(failures ? `${failures} FAILED` : "all cases correct");
process.exit(failures ? 1 : 0);
