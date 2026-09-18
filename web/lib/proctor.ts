/**
 * Camera checks, entirely on the candidate's device.
 *
 * MediaPipe's face landmarker runs in this tab. Frames are never uploaded, never
 * stored, and never reach our server — only events, each with the time it
 * happened: no_face, multiple_faces, looking_away, camera_lost.
 *
 * On gaze, honestly
 * -----------------
 * Retinal imaging is not possible from a webcam; it needs infrared hardware
 * pointed into the eye. What is available is iris position among the landmarks.
 * Used raw it is worth little: head rotation dominates it, and everyone's eyes
 * sit differently relative to their camera.
 *
 * So the candidate looks at four points before the interview and the tracker
 * records where their eyes and head actually sit for each. At runtime a reading
 * is compared against those four references and classified as whichever is
 * nearest. That turns "the iris is a bit left" — meaningless alone — into "this
 * is closer to their look-at-my-lap pose than their look-at-the-screen pose",
 * which is a comparison worth making, and it catches eyes moving while the head
 * stays still.
 *
 * It still cannot read what someone is looking at, only that their eyes are
 * nearer a position they held while looking off-screen. Every threshold here is
 * set so ambiguity resolves in the candidate's favour.
 */

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const SAMPLE_MS = 200;

/** Seconds a condition must hold before it counts. People lean out of frame to
 *  think, and glance away mid-sentence like everyone does in a conversation. */
const ABSENCE_SECONDS = 8;
const AWAY_SECONDS = 5;

/** Don't report the same ongoing condition over and over. */
const REPEAT_SECONDS = 45;

/** How much nearer an off-screen pose must be than the on-screen one before it
 *  counts. Plain nearest-neighbour would flip on noise; this demands a clear win. */
const MARGIN = 1.35;

// Landmark indices from the MediaPipe face mesh.
const EYES = [
  { inner: 133, outer: 33, iris: 468, upper: 159, lower: 145 },
  { inner: 362, outer: 263, iris: 473, upper: 386, lower: 374 },
];

export type GazeTarget = "center" | "left" | "right" | "down";

/** One reading of where the eyes and head are. Iris ratios are 0-1 within the
 *  eye; yaw and pitch are degrees. */
export type GazeSample = { ix: number; iy: number; yaw: number; pitch: number };

export type GazeCalibration = Record<GazeTarget, GazeSample>;

export type ProctorEvent = {
  kind: "no_face" | "multiple_faces" | "looking_away" | "camera_lost";
  detail: string;
};

export type ProctorStatus = {
  faces: number;
  away: boolean;
  /** Where the current reading classifies, for the self-view. */
  looking: GazeTarget | null;
};

type Point = { x: number; y: number };

function irisPosition(points: Point[]): { ix: number; iy: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const eye of EYES) {
    const inner = points[eye.inner];
    const outer = points[eye.outer];
    const iris = points[eye.iris];
    const upper = points[eye.upper];
    const lower = points[eye.lower];
    if (!inner || !outer || !iris || !upper || !lower) continue;
    const spanX = outer.x - inner.x;
    const spanY = lower.y - upper.y;
    if (Math.abs(spanX) < 1e-6 || Math.abs(spanY) < 1e-6) continue;
    xs.push((iris.x - inner.x) / spanX);
    ys.push((iris.y - upper.y) / spanY);
  }
  if (!xs.length) return null;
  return {
    ix: xs.reduce((a, b) => a + b, 0) / xs.length,
    iy: ys.reduce((a, b) => a + b, 0) / ys.length,
  };
}

function headAngles(m: Float32Array | number[]): { yaw: number; pitch: number } {
  return {
    yaw: Math.atan2(m[8], m[10]) * (180 / Math.PI),
    pitch: Math.asin(Math.max(-1, Math.min(1, -m[9]))) * (180 / Math.PI),
  };
}

/** Distance between two poses. Head angles are divided by 30 so a degree of
 *  rotation and a hundredth of iris travel weigh about the same. */
function distance(a: GazeSample, b: GazeSample): number {
  const dx = a.ix - b.ix;
  const dy = a.iy - b.iy;
  const dyaw = (a.yaw - b.yaw) / 30;
  const dpitch = (a.pitch - b.pitch) / 30;
  return Math.sqrt(dx * dx + dy * dy + dyaw * dyaw + dpitch * dpitch);
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Median rather than mean: one bad frame during calibration should not move
 *  the reference the whole interview is judged against. */
export function averageSample(samples: GazeSample[]): GazeSample {
  return {
    ix: median(samples.map((s) => s.ix)),
    iy: median(samples.map((s) => s.iy)),
    yaw: median(samples.map((s) => s.yaw)),
    pitch: median(samples.map((s) => s.pitch)),
  };
}

/** Where a reading classifies, or null when the on-screen pose wins. */
export function classify(sample: GazeSample, calibration: GazeCalibration): GazeTarget | null {
  const toCenter = distance(sample, calibration.center);
  let best: GazeTarget | null = null;
  let bestDistance = Infinity;
  for (const target of ["left", "right", "down"] as const) {
    const d = distance(sample, calibration[target]);
    if (d < bestDistance) {
      bestDistance = d;
      best = target;
    }
  }
  return best && toCenter > bestDistance * MARGIN ? best : null;
}

/** A calibration where the off-screen points barely differ from centre is not
 *  usable — the candidate did not move their eyes, or the camera cannot see
 *  them well enough. Better to run unproctored than to act on noise. */
export function calibrationIsUsable(calibration: GazeCalibration): boolean {
  return (["left", "right", "down"] as const).every(
    (target) => distance(calibration[target], calibration.center) > 0.12,
  );
}

/* ------------------------------------------------------------------------ */
/* Tracker: one camera and one model, shared by calibration and monitoring   */
/* ------------------------------------------------------------------------ */

export type GazeTracker = {
  stream: MediaStream;
  sample: () => { faces: number; gaze: GazeSample | null };
  stop: () => void;
};

export async function createTracker(): Promise<GazeTracker> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 480, height: 360, facingMode: "user" },
  });

  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  // Feeds the detector only. The visible self-view is a separate element bound
  // to the same stream, so nothing has to move around the DOM mid-interview.
  video.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px";
  document.body.appendChild(video);
  await video.play();

  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  const landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 2,
    outputFacialTransformationMatrixes: true,
  });

  return {
    stream,
    sample: () => {
      if (video.readyState < 2) return { faces: 0, gaze: null };
      let result;
      try {
        result = landmarker.detectForVideo(video, performance.now());
      } catch {
        return { faces: 0, gaze: null };
      }
      const faces = result.faceLandmarks?.length ?? 0;
      if (faces !== 1) return { faces, gaze: null };

      const points = result.faceLandmarks[0] as Point[];
      const matrix = result.facialTransformationMatrixes?.[0]?.data;
      const iris = irisPosition(points);
      if (!matrix || !iris) return { faces, gaze: null };

      const { yaw, pitch } = headAngles(matrix);
      return { faces, gaze: { ...iris, yaw, pitch } };
    },
    stop: () => {
      landmarker.close();
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Monitoring                                                                */
/* ------------------------------------------------------------------------ */

export type ProctorHandle = { stop: () => void };

export function watchCamera(
  tracker: GazeTracker,
  calibration: GazeCalibration | null,
  onEvent: (event: ProctorEvent) => void,
  onStatus?: (status: ProctorStatus) => void,
): ProctorHandle {
  let stopped = false;
  let absentSince = 0;
  let awaySince = 0;
  const reported: Record<string, number> = {};

  const report = (kind: ProctorEvent["kind"], detail: string) => {
    const now = Date.now();
    if (reported[kind] && now - reported[kind] < REPEAT_SECONDS * 1000) return;
    reported[kind] = now;
    onEvent({ kind, detail });
  };

  const timer = setInterval(() => {
    if (stopped) return;

    if (!tracker.stream.getVideoTracks().some((t) => t.readyState === "live")) {
      report("camera_lost", "Camera stopped during the interview");
      return;
    }

    const { faces, gaze } = tracker.sample();

    if (faces === 0) {
      awaySince = 0;
      if (!absentSince) absentSince = Date.now();
      const seconds = Math.round((Date.now() - absentSince) / 1000);
      onStatus?.({ faces, away: false, looking: null });
      if (seconds >= ABSENCE_SECONDS) report("no_face", `No one in frame for ${seconds}s`);
      return;
    }

    absentSince = 0;

    if (faces > 1) {
      awaySince = 0;
      onStatus?.({ faces, away: false, looking: null });
      report("multiple_faces", `${faces} people in frame`);
      return;
    }

    if (!gaze || !calibration) {
      onStatus?.({ faces, away: false, looking: null });
      return;
    }

    const looking = classify(gaze, calibration);
    onStatus?.({ faces, away: awaySince > 0, looking });

    if (!looking) {
      awaySince = 0;
      return;
    }

    if (!awaySince) awaySince = Date.now();
    const seconds = Math.round((Date.now() - awaySince) / 1000);
    if (seconds >= AWAY_SECONDS) {
      const where = looking === "down" ? "down, away from the screen" : `away to the ${looking}`;
      report("looking_away", `Looked ${where} for ${seconds}s`);
    }
  }, SAMPLE_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
