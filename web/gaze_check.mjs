/**
 * Offline check of the gaze model against synthetic candidates. No camera.
 * Run: node gaze_check.mjs
 *
 * It imports lib/gaze.ts directly, under Node's type stripping, rather than
 * keeping a copy of the maths here. The copy passed happily for months while
 * the real module had the bug this file now covers -- a harness that tests a
 * duplicate tests nothing.
 *
 * The synthetic candidate is parameterised by one number, `headShare`: how much
 * of a look they perform with their head rather than their eyes. It is the axis
 * the real complaint lived on, because the same person calibrates differently
 * on different days depending on how literally they take "hold your head still".
 */
import {
  calibrationProblem,
  fitGazeModel,
  judge,
  Smoother,
} from "./lib/gaze.ts";

const GRID = [];
for (const sx of [0.5, 0.04, 0.96]) for (const sy of [0.5, 0.05, 0.95]) GRID.push([sx, sy]);

/** Deterministic noise, so a failure here is reproducible rather than a mood. */
let seed = 20240917;
const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);

/**
 * Screen point -> what the landmarker would report.
 *
 * Eye and head both point at the target and share the work in proportion to
 * `headShare`. The 1/6 and the degrees-per-screen-width are only rough physical
 * scales; what the tests turn on is the ratio between them, which is the thing
 * that actually varies between real calibrations.
 */
const candidate =
  ({ headShare = 0.1, jitter = 0 } = {}) =>
  (sx, sy) => {
    const gx = sx - 0.5;
    const gy = sy - 0.5;
    const eye = 1 - headShare;
    const ix = (eye * gx) / 6;
    const iy = (eye * gy) / 6;
    return {
      ixL: ix + noise() * jitter,
      ixR: ix + noise() * jitter,
      iyL: iy + noise() * jitter,
      iyR: iy + noise() * jitter,
      yaw: headShare * gx * 60,
      pitch: headShare * gy * 45,
    };
  };

const calibrate = (person, points = GRID) =>
  fitGazeModel(points.map(([sx, sy]) => ({ features: person(sx, sy), target: { sx, sy } })));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  const shown = ok ? String(actual) : `${actual}, wanted ${expected}`;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(46)} ${shown}`);
};

/* -- calibration is accepted or refused, never silently useless ----------- */

console.log("\ncalibration gate");
{
  const cases = [
    ["eyes only, head still", { headShare: 0 }, null],
    ["a little head movement", { headShare: 0.12 }, null],
    ["normal landmark jitter", { headShare: 0.1, jitter: 0.03 }, null],
    // The one the complaint came from: the model fits head pose beautifully and
    // has learned nothing about the eyes.
    ["head doing most of the work", { headShare: 0.5 }, "head"],
    ["head doing all of the work", { headShare: 0.95 }, "head"],
  ];
  for (const [label, opts, expect] of cases) {
    const model = calibrate(candidate(opts));
    const problem = calibrationProblem(model);
    const kind = !problem ? null : /head moved/.test(problem) ? "head" : "other";
    check(label, kind, expect);
    if (model) {
      console.log(
        `       held-out error ${model.quality.toFixed(3)}  head range ${model.headRange.toFixed(1)}deg` +
          `  eye weight ${model.wx[0].toFixed(2)}  head weight ${model.wx[2].toFixed(2)}`,
      );
    }
  }

  // A capture the candidate spent looking at something other than the dot.
  const person = candidate({ headShare: 0.1 });
  const sloppy = GRID.map(([sx, sy], i) => ({
    features: i === 3 ? person(0.9, 0.1) : person(sx, sy),
    target: { sx, sy },
  }));
  check("one dot missed entirely", /inconsistent/.test(calibrationProblem(fitGazeModel(sloppy)) ?? ""), true);

  // Staring straight ahead through the whole thing.
  const frozen = GRID.map(([sx, sy]) => ({ features: person(0.5, 0.5), target: { sx, sy } }));
  check("eyes never moved", /barely moved/.test(calibrationProblem(fitGazeModel(frozen)) ?? ""), true);

  check("too few points to hold one out", fitGazeModel(GRID.slice(0, 5).map(([sx, sy]) => ({
    features: person(sx, sy),
    target: { sx, sy },
  }))), null);
}

/* -- the same event gets the same name whoever calibrated ----------------- */

console.log("\ndirection reported, across calibrations and runtime habits");
{
  // Every calibration the gate accepts, crossed with every way someone might
  // move at runtime. The complaint was that this table was not constant.
  const looks = [
    ["second monitor, left", -1.0, 0.5, "left"],
    ["second monitor, right", 2.0, 0.5, "right"],
    ["phone in the lap", 0.5, 1.8, "below"],
    ["notes above the screen", 0.5, -0.7, "above"],
    // Down and a little to one side: the axis with the bigger overshoot wins,
    // and it is not whichever one happens to be tested first.
    ["phone in the lap, off to one side", 0.25, 1.8, "below"],
    ["own screen, bottom edge", 0.5, 0.98, null],
    ["own screen, far corner", 0.02, 0.95, null],
    ["dead centre", 0.5, 0.5, null],
  ];

  for (const calShare of [0, 0.12, 0.25]) {
    const person = candidate({ headShare: calShare });
    const model = calibrate(person);
    if (calibrationProblem(model)) throw new Error("fixture should calibrate");
    const neutral = person(0.5, 0.5);

    for (const runShare of [0, 0.3]) {
      const runtime = candidate({ headShare: runShare });
      console.log(`  calibrated head-share ${calShare}, looking with head-share ${runShare}`);
      for (const [label, sx, sy, expected] of looks) {
        const verdict = judge(model, runtime(sx, sy), neutral);
        check(`  ${label}`, verdict.where, expected);
      }
    }
  }
}

/* -- head and eyes pulling in different directions ------------------------ */

console.log("\nhead and eyes disagreeing");
{
  const person = candidate({ headShare: 0.1 });
  const model = calibrate(person);
  const neutral = person(0.5, 0.5);

  // Turned to think, or sitting at an angle to a wide monitor, while still
  // reading it. Resolving this the candidate's way is the whole point of the
  // thresholds; the old code called it "turned" and spent a warning.
  const turnedButReading = { ...person(0.5, 0.5), yaw: 28 };
  check("head turned 28deg, eyes on the screen", judge(model, turnedButReading, neutral).where, null);

  // Far enough round that the iris estimate is not worth consulting.
  const turnedAway = { ...person(0.5, 0.5), yaw: 45 };
  check("head turned 45deg", judge(model, turnedAway, neutral).where, "turned");

  // Head square to the camera, eyes on a second screen. The failure that made
  // this whole exercise necessary: a head-trained model scored this as fine.
  const eyesOnlyAway = { ...person(2.0, 0.5), yaw: 0, pitch: 0 };
  check("head still, eyes on a second monitor", judge(model, eyesOnlyAway, neutral).where, "right");

  const eyesOnlyDown = { ...person(0.5, 1.8), yaw: 0, pitch: 0 };
  check("head still, eyes down at a phone", judge(model, eyesOnlyDown, neutral).where, "below");

  // Leaning in. Normalising by inter-ocular distance is supposed to absorb this.
  const leaning = person(0.5, 0.5);
  const closer = {
    ...leaning,
    ixL: leaning.ixL * 1.4,
    ixR: leaning.ixR * 1.4,
    iyL: leaning.iyL * 1.4,
    iyR: leaning.iyR * 1.4,
  };
  check("leaning toward the camera", judge(model, closer, neutral).where, null);
}

/* -- a real session, frame by frame --------------------------------------- */

console.log("\nsmoothed over a run of frames");
{
  const person = candidate({ headShare: 0.1 });
  const model = calibrate(person);
  const neutral = person(0.5, 0.5);
  const jittery = candidate({ headShare: 0.1, jitter: 0.02 });

  // Forty frames of working normally: not one of them may fire, because at
  // 150ms a frame the away timer only needs a run of them to spend a warning.
  const smoother = new Smoother();
  let fired = 0;
  for (let i = 0; i < 40; i++) {
    const wander = jittery(0.5 + noise() * 0.6, 0.5 + noise() * 0.6);
    if (judge(model, smoother.push(wander), neutral).off) fired++;
  }
  check("40 frames reading own screen, none off", fired, 0);

  // Then they look at the phone and keep looking. The smoother must not take
  // so long to catch up that a four-second glance goes unreported.
  const away = new Smoother();
  let framesToNotice = -1;
  for (let i = 0; i < 40; i++) {
    if (judge(model, away.push(jittery(0.5, 1.8)), neutral).off) {
      framesToNotice = i;
      break;
    }
  }
  check("phone look noticed within 8 frames", framesToNotice >= 0 && framesToNotice < 8, true);
}

console.log(failures ? `\n${failures} FAILED` : "\nall cases correct");
process.exit(failures ? 1 : 0);
