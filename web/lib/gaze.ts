/**
 * Gaze estimation from MediaPipe landmarks.
 *
 * The method is the established one for webcam gaze: extract iris displacement
 * features, have the user look at known screen points, and fit a ridge
 * regression from features to screen coordinates (Gudi et al., "Efficiency in
 * Real-time Webcam Gaze Tracking"; the same shape WebGazer uses internally).
 *
 * Features are normalised by inter-ocular distance so leaning toward the camera
 * does not read as looking somewhere new. Head yaw and pitch are inputs too:
 * where someone looks is where their head points plus where their eyes point
 * within it, and a model given only the eyes has to explain head movement with
 * eye terms, which is what makes uncalibrated gaze so unstable.
 *
 * Ridge rather than plain least squares because five calibration points is very
 * little data and the penalty is what stops one bad sample dominating the fit.
 *
 * This produces a screen estimate accurate to a few centimetres at best. It is
 * used for one question only -- is the estimate well outside the screen -- and
 * every threshold is set so ambiguity resolves in the candidate's favour.
 */

export type GazeFeatures = {
  /** Iris displacement from eye centre, normalised by inter-ocular distance. */
  ixL: number;
  iyL: number;
  ixR: number;
  iyR: number;
  yaw: number;
  pitch: number;
};

/** Normalised screen space: 0,0 top-left, 1,1 bottom-right. */
export type ScreenPoint = { sx: number; sy: number };

/** `bounds` are the model's own predictions at the calibration points, not the
 *  targets. Ridge deliberately shrinks predictions toward the mean, so a fit
 *  whose extremes land at 0.2 and 0.8 is normal and healthy. Judging against
 *  absolute screen coordinates would then almost never fire; judging against the
 *  span the model actually produces is what makes the thresholds mean something. */
export type GazeBounds = { minX: number; maxX: number; minY: number; maxY: number };

export type GazeModel = { wx: number[]; wy: number[]; quality: number; bounds: GazeBounds };

const RIDGE = 0.02;

/** Design row for the horizontal fit: both eyes' horizontal offsets, head yaw,
 *  and a bias term. */
function rowX(f: GazeFeatures): number[] {
  return [f.ixL, f.ixR, f.yaw / 30, 1];
}

function rowY(f: GazeFeatures): number[] {
  return [f.iyL, f.iyR, f.pitch / 30, 1];
}

/** Solve (A + lambda I) w = b by Gaussian elimination with partial pivoting.
 *  Four unknowns; no linear-algebra dependency is worth adding for this. */
function solve(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
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

function ridgeFit(rows: number[][], targets: number[]): number[] | null {
  const n = rows[0].length;
  const xtx = Array.from({ length: n }, () => Array(n).fill(0));
  const xty = Array(n).fill(0);

  for (let s = 0; s < rows.length; s++) {
    for (let i = 0; i < n; i++) {
      xty[i] += rows[s][i] * targets[s];
      for (let j = 0; j < n; j++) xtx[i][j] += rows[s][i] * rows[s][j];
    }
  }
  // Bias term is left unpenalised: shrinking it would drag every prediction
  // toward zero rather than toward the mean.
  for (let i = 0; i < n - 1; i++) xtx[i][i] += RIDGE;

  return solve(xtx, xty);
}

export function predict(model: GazeModel, features: GazeFeatures): ScreenPoint {
  const dot = (w: number[], r: number[]) => w.reduce((sum, wi, i) => sum + wi * r[i], 0);
  return { sx: dot(model.wx, rowX(features)), sy: dot(model.wy, rowY(features)) };
}

/**
 * Fit from calibration samples.
 *
 * `quality` is the mean error, in screen widths, of the fitted model on the
 * points it was fitted to. Above roughly 0.25 the fit is not describing this
 * person's eyes and is better discarded than trusted -- but the caller is told,
 * rather than the whole feature failing quietly.
 */
export function fitGazeModel(
  samples: { features: GazeFeatures; target: ScreenPoint }[],
): GazeModel | null {
  if (samples.length < 4) return null;

  const wx = ridgeFit(samples.map((s) => rowX(s.features)), samples.map((s) => s.target.sx));
  const wy = ridgeFit(samples.map((s) => rowY(s.features)), samples.map((s) => s.target.sy));
  if (!wx || !wy || [...wx, ...wy].some((v) => !Number.isFinite(v))) return null;

  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const model: GazeModel = { wx, wy, quality: 0, bounds };

  const errors = samples.map((s) => {
    const p = predict(model, s.features);
    bounds.minX = Math.min(bounds.minX, p.sx);
    bounds.maxX = Math.max(bounds.maxX, p.sx);
    bounds.minY = Math.min(bounds.minY, p.sy);
    bounds.maxY = Math.max(bounds.maxY, p.sy);
    return Math.hypot(p.sx - s.target.sx, p.sy - s.target.sy);
  });
  model.quality = errors.reduce((a, b) => a + b, 0) / errors.length;

  // A model whose predictions barely move between "look left" and "look right"
  // has not learned this person's eyes and must not be acted on.
  if (bounds.maxX - bounds.minX < 0.15 || bounds.maxY - bounds.minY < 0.15) return null;
  return model;
}

/** How far past the calibrated span an estimate must land before it counts as
 *  off-screen, as a fraction of that span. Generous, because the estimate itself
 *  is good to a few centimetres at best. */
const OVERSHOOT = 0.35;

/** Head rotation this far past the calibrated neutral is off-screen regardless
 *  of what the regression says. It is the most reliable signal available. */
const YAW_DEGREES = 25;
const PITCH_DEGREES = 20;

export type GazeVerdict = {
  point: ScreenPoint;
  off: boolean;
  /** Plain words for the self-view and the recruiter's timeline. */
  where: "left" | "right" | "above" | "below" | "turned" | null;
};

export function judge(
  model: GazeModel,
  features: GazeFeatures,
  neutral: GazeFeatures,
): GazeVerdict {
  const point = predict(model, features);

  const yawOff = features.yaw - neutral.yaw;
  const pitchOff = features.pitch - neutral.pitch;
  if (Math.abs(yawOff) > YAW_DEGREES || Math.abs(pitchOff) > PITCH_DEGREES) {
    return { point, off: true, where: "turned" };
  }

  const { minX, maxX, minY, maxY } = model.bounds;
  const padX = (maxX - minX) * OVERSHOOT;
  const padY = (maxY - minY) * OVERSHOOT;

  if (point.sx < minX - padX) return { point, off: true, where: "left" };
  if (point.sx > maxX + padX) return { point, off: true, where: "right" };
  if (point.sy < minY - padY) return { point, off: true, where: "above" };
  if (point.sy > maxY + padY) return { point, off: true, where: "below" };
  return { point, off: false, where: null };
}

/** Exponential smoothing. Raw per-frame estimates jitter by tens of percent of
 *  screen width; without this the readout is unreadable and the thresholds trip
 *  on noise. */
export class Smoother {
  private value: GazeFeatures | null = null;
  // A plain field rather than a constructor parameter property: this module is
  // imported directly by gaze_check.mjs under Node's type stripping, which
  // rejects parameter properties. Worth the two extra lines to have the test
  // harness exercise this file instead of a copy of it that can drift.
  private readonly alpha: number;

  constructor(alpha = 0.25) {
    this.alpha = alpha;
  }

  push(next: GazeFeatures): GazeFeatures {
    if (!this.value) {
      this.value = next;
      return next;
    }
    const a = this.alpha;
    const previous = this.value;
    this.value = {
      ixL: previous.ixL + a * (next.ixL - previous.ixL),
      iyL: previous.iyL + a * (next.iyL - previous.iyL),
      ixR: previous.ixR + a * (next.ixR - previous.ixR),
      iyR: previous.iyR + a * (next.iyR - previous.iyR),
      yaw: previous.yaw + a * (next.yaw - previous.yaw),
      pitch: previous.pitch + a * (next.pitch - previous.pitch),
    };
    return this.value;
  }

  reset() {
    this.value = null;
  }
}

export function averageFeatures(samples: GazeFeatures[]): GazeFeatures {
  const mid = (pick: (f: GazeFeatures) => number) => {
    const sorted = samples.map(pick).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  return {
    ixL: mid((f) => f.ixL),
    iyL: mid((f) => f.iyL),
    ixR: mid((f) => f.ixR),
    iyR: mid((f) => f.iyR),
    yaw: mid((f) => f.yaw),
    pitch: mid((f) => f.pitch),
  };
}
