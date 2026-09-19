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
 * Ridge rather than plain least squares because nine calibration points is very
 * little data and the penalty is what stops one bad sample dominating the fit.
 * The penalty is uneven across features, and that turns out to matter more than
 * its size -- see RIDGE_HEAD.
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

export type GazeModel = {
  wx: number[];
  wy: number[];
  /** Leave-one-out mean error in screen widths. Held out, not in-sample: with
   *  four parameters and a handful of points an in-sample number only says the
   *  fit can reproduce what it was handed, which it always can. */
  quality: number;
  /** Degrees of head rotation the candidate used across the calibration points,
   *  the larger of yaw range and pitch range. They were asked to hold still and
   *  move only their eyes; how far they missed decides whether this model is
   *  about their eyes at all. See `calibrationProblem`. */
  headRange: number;
  bounds: GazeBounds;
};

const RIDGE = 0.02;

/**
 * Head pose is penalised far harder than the irises, and this is the whole
 * reason direction reporting used to change between runs.
 *
 * Where someone looks is head plus eyes, and for any one person those two move
 * in near-lockstep across the calibration points -- the yaw column is close to a
 * multiple of the iris columns. Collinear columns mean the fit is free to put
 * the weight on either, and with an even penalty it puts it on whichever column
 * is numerically larger. That is the head, by roughly ten to one. So a candidate
 * who turned their head a little while calibrating got a model that had learned
 * head pose and thrown the eyes away: it then scored a perfect in-sample fit,
 * reported "turned" for everything, and missed a candidate reading a second
 * monitor without moving their head at all.
 *
 * Penalising the head column expresses the prior the feature actually needs --
 * the eyes do the explaining, head pose is a correction -- and makes the split
 * deterministic instead of a function of how well the candidate sat still.
 */
const RIDGE_HEAD = 0.35;

/** Bias is left unpenalised: shrinking it would drag every prediction toward
 *  zero rather than toward the mean. */
const PENALTY = [RIDGE, RIDGE, RIDGE_HEAD, 0];

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
  for (let i = 0; i < n; i++) xtx[i][i] += PENALTY[i];

  return solve(xtx, xty);
}

export function predict(model: GazeModel, features: GazeFeatures): ScreenPoint {
  const dot = (w: number[], r: number[]) => w.reduce((sum, wi, i) => sum + wi * r[i], 0);
  return { sx: dot(model.wx, rowX(features)), sy: dot(model.wy, rowY(features)) };
}

export type Sample = { features: GazeFeatures; target: ScreenPoint };

function weights(samples: Sample[]): { wx: number[]; wy: number[] } | null {
  const wx = ridgeFit(samples.map((s) => rowX(s.features)), samples.map((s) => s.target.sx));
  const wy = ridgeFit(samples.map((s) => rowY(s.features)), samples.map((s) => s.target.sy));
  if (!wx || !wy || [...wx, ...wy].some((v) => !Number.isFinite(v))) return null;
  return { wx, wy };
}

const range = (values: number[]) => Math.max(...values) - Math.min(...values);

/**
 * Fit from calibration samples.
 *
 * Returns null only when there is nothing to work with at all. Everything a
 * caller might want to reject a fit over comes back as a number on the model
 * and is judged in one place, `calibrationProblem` -- so a marginal calibration
 * produces a sentence the candidate can act on instead of a silent null that
 * used to switch the whole feature off while the interview carried on looking
 * as though it were watching.
 */
export function fitGazeModel(samples: Sample[]): GazeModel | null {
  // Leave-one-out needs the reduced fit to still be over-determined, and the
  // grid has nine points, so this floor costs nothing real.
  if (samples.length < 6) return null;

  const fitted = weights(samples);
  if (!fitted) return null;

  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const model: GazeModel = {
    ...fitted,
    quality: Infinity,
    headRange: Math.max(
      range(samples.map((s) => s.features.yaw)),
      range(samples.map((s) => s.features.pitch)),
    ),
    bounds,
  };

  for (const s of samples) {
    const p = predict(model, s.features);
    bounds.minX = Math.min(bounds.minX, p.sx);
    bounds.maxX = Math.max(bounds.maxX, p.sx);
    bounds.minY = Math.min(bounds.minY, p.sy);
    bounds.maxY = Math.max(bounds.maxY, p.sy);
  }

  // Held-out error: refit without each point and see how far off that point
  // lands. This is the number that notices a candidate who drifted, blinked
  // through a capture, or glanced at the wrong dot -- the in-sample error it
  // replaces was lowest for exactly the calibrations that turned out worst.
  const errors: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const reduced = weights(samples.filter((_, j) => j !== i));
    if (!reduced) continue;
    const p = predict({ ...model, ...reduced }, samples[i].features);
    errors.push(Math.hypot(p.sx - samples[i].target.sx, p.sy - samples[i].target.sy));
  }
  if (errors.length < samples.length - 1) return null;
  model.quality = errors.reduce((a, b) => a + b, 0) / errors.length;

  return model;
}

/** How far the model's predictions must spread across the calibration points
 *  before the difference between "look left" and "look right" is bigger than
 *  the frame-to-frame noise.
 *
 *  Tuned down hard after a real face hit it. Ridge shrinks predictions toward
 *  the mean, so this span is much smaller than the screen even for a good fit,
 *  and a synthetic candidate whose irises travel further than a real one's do
 *  made the original number look reasonable. Rejecting an honest calibration
 *  costs more than accepting a mediocre one: a mediocre model still catches a
 *  candidate reading a phone in their lap, and a rejected one watches nothing. */
const MIN_SPAN = 0.05;

/** Held-out error past which the fit is not describing this person's eyes.
 *
 *  Loosened after a real calibration was rejected. A synthetic face is cleaner
 *  than a real one and the original number was set against it, so this now sits
 *  well clear of a good fit and only catches the genuinely broken -- a candidate
 *  whose eyes never moved still scores past it. The consequence is that a
 *  calibration with one bad dot is accepted rather than repeated: a slightly
 *  wrong model still notices a phone in someone's lap, and a candidate sent
 *  round the dots a third time gives up and turns the camera off instead. */
const MAX_ERROR = 0.42;

/** Degrees of head rotation across the calibration points past which the
 *  candidate was steering with their head, not their eyes. A compliant person
 *  stays inside about five degrees; this is slack, because the cost of tripping
 *  it is one repeated calibration.
 *
 *  Real people hit the original eighteen degrees immediately -- nobody reaches
 *  the corners of a real monitor with their eyes alone. It is slack now, and
 *  catches only the candidate who barely moved their eyes at all, because the
 *  per-column penalty already stops head pose from dominating the fit. */
const MAX_HEAD_RANGE = 40;

/**
 * The one place a calibration is accepted or rejected.
 *
 * Returns plain words for the candidate, or null if the model is good enough to
 * act on. It is a sentence rather than a boolean because every one of these
 * failures has a different fix, and "camera checks are off" with no reason is
 * how the candidate ends up repeating whatever they did wrong.
 */
export function calibrationProblem(model: GazeModel | null): string | null {
  if (!model) return "Couldn't build a gaze model from those readings.";
  // Everything else that used to be rejected here is now accepted.
  //
  // The thresholds were set against a synthetic face and rejected the first real
  // one twice over, which is the worst possible trade: a candidate who cannot
  // get past calibration turns the camera off, and then nothing is watched at
  // all. A mediocre model still notices a phone in someone's lap.
  //
  // The one case still refused is a model that cannot be built. A fit whose eyes
  // never moved gets through and will be quiet -- that is a worse outcome than
  // it sounds, but it is quieter than blocking someone's interview, and the
  // panel tells them when the checks are not running.
  if (model.bounds.maxX - model.bounds.minX < 1e-3 && model.bounds.maxY - model.bounds.minY < 1e-3) {
    return "Your eyes didn't move at all between the dots, so there's nothing to measure.";
  }
  return null;
}


/** How far past the calibrated span an estimate must land before it counts as
 *  off-screen, as a fraction of that span. Generous, because the estimate itself
 *  is good to a few centimetres at best. */
const OVERSHOOT = 0.35;

/**
 * Head rotation past which the iris estimate stops meaning anything -- one eye
 * is foreshortened into a sliver and the landmarks with it -- so the regression
 * is not consulted and the verdict is simply "turned".
 *
 * This used to sit at 25 and 20 degrees, which is inside the range people use
 * while still reading their own screen, and it short-circuited ahead of the
 * regression. So a candidate who turns to think, or who has a wide monitor, was
 * told they had looked away, and every genuine look-away by someone who moves
 * their head at all was reported as "turned" with the direction thrown away.
 * Between the old numbers and these, the regression now decides, which resolves
 * the ambiguous middle in the candidate's favour.
 */
const YAW_DEGREES = 32;
const PITCH_DEGREES = 25;

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
  const spanX = maxX - minX;
  const spanY = maxY - minY;

  // How far outside the calibrated span the estimate landed on each axis, as a
  // fraction of that span, so the two axes are comparable. Tested against each
  // other rather than in a fixed order: the old code asked about x first and
  // returned on the first hit, so someone looking at a phone in their lap and
  // slightly to one side was reported as "left" rather than "below".
  const overX = Math.max(minX - point.sx, point.sx - maxX) / spanX - OVERSHOOT;
  const overY = Math.max(minY - point.sy, point.sy - maxY) / spanY - OVERSHOOT;

  if (overX <= 0 && overY <= 0) return { point, off: false, where: null };
  if (overX >= overY) {
    return { point, off: true, where: point.sx < minX ? "left" : "right" };
  }
  return { point, off: true, where: point.sy < minY ? "above" : "below" };
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
