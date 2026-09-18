/**
 * Camera checks, entirely on the candidate's device.
 *
 * MediaPipe's face landmarker runs in this tab. Frames are never uploaded, never
 * stored, and never reach our server — only events, each with the time it
 * happened: no_face, multiple_faces, looking_away, camera_lost.
 *
 * Gaze estimation lives in lib/gaze.ts; this file owns the camera, the model,
 * feature extraction from landmarks, and the timing rules that decide when a
 * condition has lasted long enough to be worth reporting.
 */

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";

import {
  judge,
  Smoother,
  type GazeFeatures,
  type GazeModel,
  type ScreenPoint,
} from "@/lib/gaze";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const SAMPLE_MS = 150;

/** Seconds a condition must hold before it counts. People lean out of frame to
 *  think, and glance away mid-sentence like everyone does in a conversation. */
const ABSENCE_SECONDS = 8;
const AWAY_SECONDS = 4;

/** Don't report the same ongoing condition over and over. */
const REPEAT_SECONDS = 30;

// Landmark indices from the MediaPipe face mesh. Iris centres are 468 and 473,
// present because the landmarker returns 478 points with iris refinement.
const LEFT = { inner: 362, outer: 263, upper: 386, lower: 374, iris: 473 };
const RIGHT = { inner: 133, outer: 33, upper: 159, lower: 145, iris: 468 };

export type ProctorEvent = {
  kind: "no_face" | "multiple_faces" | "looking_away" | "camera_lost";
  detail: string;
};

export type ProctorStatus = {
  faces: number;
  /** Live estimate in normalised screen space, for the self-view readout. */
  point: ScreenPoint | null;
  off: boolean;
  where: string | null;
};

type Point = { x: number; y: number; z?: number };

/**
 * Iris displacement per eye, normalised by inter-ocular distance.
 *
 * Normalising by the distance between the eyes is what makes this survive the
 * candidate leaning toward or away from the camera: everything scales together,
 * so the ratio does not move.
 */
export function extractFeatures(points: Point[], matrix: Float32Array | number[]): GazeFeatures | null {
  const centre = (eye: typeof LEFT) => {
    const inner = points[eye.inner];
    const outer = points[eye.outer];
    const upper = points[eye.upper];
    const lower = points[eye.lower];
    const iris = points[eye.iris];
    if (!inner || !outer || !upper || !lower || !iris) return null;
    return {
      cx: (inner.x + outer.x) / 2,
      cy: (upper.y + lower.y) / 2,
      ix: iris.x,
      iy: iris.y,
    };
  };

  const left = centre(LEFT);
  const right = centre(RIGHT);
  if (!left || !right) return null;

  const interocular = Math.hypot(left.cx - right.cx, left.cy - right.cy);
  if (interocular < 1e-6) return null;

  const yaw = Math.atan2(matrix[8], matrix[10]) * (180 / Math.PI);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -matrix[9]))) * (180 / Math.PI);

  return {
    ixL: (left.ix - left.cx) / interocular,
    iyL: (left.iy - left.cy) / interocular,
    ixR: (right.ix - right.cx) / interocular,
    iyR: (right.iy - right.cy) / interocular,
    yaw,
    pitch,
  };
}

/* ------------------------------------------------------------------------ */
/* Tracker: one camera and one model, shared by calibration and monitoring   */
/* ------------------------------------------------------------------------ */

export type Reading = { faces: number; features: GazeFeatures | null };

export type GazeTracker = {
  stream: MediaStream;
  read: () => Reading;
  stop: () => void;
};

export async function createTracker(): Promise<GazeTracker> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
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
    read: () => {
      if (video.readyState < 2) return { faces: 0, features: null };
      let result;
      try {
        result = landmarker.detectForVideo(video, performance.now());
      } catch {
        return { faces: 0, features: null };
      }
      const faces = result.faceLandmarks?.length ?? 0;
      if (faces !== 1) return { faces, features: null };

      const points = result.faceLandmarks[0] as Point[];
      const matrix = result.facialTransformationMatrixes?.[0]?.data;
      if (!matrix) return { faces, features: null };
      return { faces, features: extractFeatures(points, matrix) };
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

const WHERE_WORDS: Record<string, string> = {
  left: "away to the left",
  right: "away to the right",
  above: "above the screen",
  below: "down, away from the screen",
  turned: "away from the screen",
};

export function watchCamera(
  tracker: GazeTracker,
  gaze: { model: GazeModel; neutral: GazeFeatures } | null,
  onEvent: (event: ProctorEvent) => void,
  onStatus?: (status: ProctorStatus) => void,
): ProctorHandle {
  let stopped = false;
  let absentSince = 0;
  let awaySince = 0;
  const smoother = new Smoother();
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

    const { faces, features } = tracker.read();

    if (faces === 0) {
      awaySince = 0;
      smoother.reset();
      if (!absentSince) absentSince = Date.now();
      const seconds = Math.round((Date.now() - absentSince) / 1000);
      onStatus?.({ faces, point: null, off: false, where: null });
      if (seconds >= ABSENCE_SECONDS) report("no_face", `No one in frame for ${seconds}s`);
      return;
    }

    absentSince = 0;

    if (faces > 1) {
      awaySince = 0;
      onStatus?.({ faces, point: null, off: false, where: null });
      report("multiple_faces", `${faces} people in frame`);
      return;
    }

    if (!features || !gaze) {
      onStatus?.({ faces, point: null, off: false, where: null });
      return;
    }

    const verdict = judge(gaze.model, smoother.push(features), gaze.neutral);
    onStatus?.({ faces, point: verdict.point, off: verdict.off, where: verdict.where });

    if (!verdict.off) {
      awaySince = 0;
      return;
    }

    if (!awaySince) awaySince = Date.now();
    const seconds = Math.round((Date.now() - awaySince) / 1000);
    if (seconds >= AWAY_SECONDS) {
      report("looking_away", `Looked ${WHERE_WORDS[verdict.where ?? "turned"]} for ${seconds}s`);
    }
  }, SAMPLE_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
