/**
 * Camera presence and attention checks, entirely on the candidate's device.
 *
 * MediaPipe's face landmarker runs in this tab against a hidden <video>. Frames
 * are never uploaded, never stored, and never reach our server — only events,
 * each with the time it happened:
 *
 *   no_face          nobody in frame for a sustained stretch
 *   multiple_faces   more than one person in frame
 *   looking_away     head turned or eyes off-screen for a sustained stretch
 *   camera_lost      the track ended mid-interview
 *
 * On what "looking away" can and cannot mean
 * ------------------------------------------
 * Retinal imaging is not possible from a webcam; it needs infrared hardware
 * pointed into the eye. What is available is iris position among the landmarks,
 * which gives a gaze estimate with roughly 5-10 degrees of error uncalibrated —
 * wider than a laptop screen subtends. It cannot distinguish reading a second
 * monitor from glancing at the edge of this one.
 *
 * Head pose is the reliable signal, so it carries most of the weight here and
 * iris offset only corroborates it. Both are measured against a baseline taken
 * from this candidate's own first few seconds, because everyone sits differently.
 * Thresholds are deliberately generous and an event needs to persist for seconds
 * before it is reported.
 *
 * What this still is: a note saying "they looked away for eleven seconds at
 * 6:42", for a human reading the transcript. What it is not, and must never
 * become: an attention score, an emotion reading, or an input to any judgement
 * about the candidate. See docs/adr/005-proctoring-never-touches-scoring.md.
 */

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** How often to look. Four times a second is enough to time an absence to the
 *  second while leaving the main thread to the audio pipeline, which matters
 *  more to the interview than this does. */
const SAMPLE_MS = 250;

/** Seconds a condition must hold before it is worth a note. People lean out of
 *  frame to think, reach for water, and shift in a chair. */
const ABSENCE_SECONDS = 8;
const AWAY_SECONDS = 6;

/** Don't report the same ongoing condition over and over. */
const REPEAT_SECONDS = 60;

/** Baseline: the candidate's own neutral pose, sampled while the agent delivers
 *  its opening line — the one moment they are reliably facing the screen. */
const CALIBRATION_SAMPLES = 20;

/** How far from that baseline counts as away. Head rotation does the work;
 *  the iris term only fires on a large, sustained offset. Both are wide on
 *  purpose — a false note on someone's hiring record is worse than a missed one. */
const YAW_DEGREES = 28;
const PITCH_DEGREES = 22;
const IRIS_OFFSET = 0.22;

// Landmark indices, from the MediaPipe face mesh.
const RIGHT_EYE = { inner: 133, outer: 33, iris: 468 };
const LEFT_EYE = { inner: 362, outer: 263, iris: 473 };

export type ProctorEvent = {
  kind: "no_face" | "multiple_faces" | "looking_away" | "camera_lost";
  detail: string;
};

/** Live state for the interface: whether a face is there right now, and whether
 *  they are currently turned away. Distinct from the events, which only fire once
 *  a condition has persisted. */
export type ProctorStatus = { faces: number; away: boolean; calibrated: boolean };

export type ProctorHandle = {
  stop: () => void;
  /** The same camera the checks read. The room binds its own <video> to this so
   *  the candidate sees exactly what is being looked at. */
  stream: MediaStream;
};

type Point = { x: number; y: number };

/** Where the iris sits between the eye corners: 0 at the inner corner, 1 at the
 *  outer. Taken as a ratio so it survives the candidate moving nearer or further. */
function irisRatio(points: Point[], eye: typeof RIGHT_EYE): number | null {
  const inner = points[eye.inner];
  const outer = points[eye.outer];
  const iris = points[eye.iris];
  if (!inner || !outer || !iris) return null;
  const span = outer.x - inner.x;
  if (Math.abs(span) < 1e-6) return null;
  return (iris.x - inner.x) / span;
}

/** Yaw and pitch in degrees from the 4x4 facial transformation matrix. */
function headAngles(matrix: number[]): { yaw: number; pitch: number } {
  const yaw = Math.atan2(matrix[8], matrix[10]) * (180 / Math.PI);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -matrix[9]))) * (180 / Math.PI);
  return { yaw, pitch };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export async function startProctoring(
  onEvent: (event: ProctorEvent) => void,
  onStatus?: (status: ProctorStatus) => void,
): Promise<ProctorHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 480, height: 360, facingMode: "user" },
  });

  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  // This element exists only to feed the detector. The visible self-view is a
  // separate <video> bound to the same stream, so nothing has to move around the
  // DOM mid-interview.
  video.style.position = "fixed";
  video.style.left = "-9999px";
  video.style.width = "1px";
  video.style.height = "1px";
  document.body.appendChild(video);
  await video.play();

  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  const landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    // Two is enough to notice a second person without paying for more.
    numFaces: 2,
    outputFacialTransformationMatrixes: true,
  });

  let stopped = false;
  let absentSince = 0;
  let awaySince = 0;
  const reported: Record<string, number> = {};

  const calibration: { yaw: number[]; pitch: number[]; iris: number[] } = { yaw: [], pitch: [], iris: [] };
  let baseline: { yaw: number; pitch: number; iris: number } | null = null;

  const report = (kind: ProctorEvent["kind"], detail: string) => {
    const now = Date.now();
    if (reported[kind] && now - reported[kind] < REPEAT_SECONDS * 1000) return;
    reported[kind] = now;
    onEvent({ kind, detail });
  };

  const timer = setInterval(() => {
    if (stopped) return;

    if (!stream.getVideoTracks().some((t) => t.readyState === "live")) {
      report("camera_lost", "Camera stopped during the interview");
      return;
    }
    if (video.readyState < 2) return;

    let result;
    try {
      result = landmarker.detectForVideo(video, performance.now());
    } catch {
      return; // a dropped frame is not an event
    }

    const faces = result.faceLandmarks?.length ?? 0;

    onStatus?.({ faces, away: awaySince > 0, calibrated: baseline !== null });

    if (faces === 0) {
      awaySince = 0;
      if (!absentSince) absentSince = Date.now();
      const seconds = Math.round((Date.now() - absentSince) / 1000);
      if (seconds >= ABSENCE_SECONDS) report("no_face", `No one in frame for ${seconds}s`);
      return;
    }

    absentSince = 0;
    if (faces > 1) {
      report("multiple_faces", `${faces} people in frame`);
      return; // whose gaze would we even be measuring
    }

    const points = result.faceLandmarks[0] as Point[];
    const matrix = result.facialTransformationMatrixes?.[0]?.data;
    if (!matrix) return;

    const { yaw, pitch } = headAngles(Array.from(matrix));
    const right = irisRatio(points, RIGHT_EYE);
    const left = irisRatio(points, LEFT_EYE);
    const iris = right !== null && left !== null ? (right + left) / 2 : null;
    if (iris === null) return;

    // Calibrate against this candidate's own neutral pose. Everyone sits at a
    // different angle to their webcam; an absolute threshold would flag posture.
    if (!baseline) {
      calibration.yaw.push(yaw);
      calibration.pitch.push(pitch);
      calibration.iris.push(iris);
      if (calibration.yaw.length >= CALIBRATION_SAMPLES) {
        baseline = {
          yaw: median(calibration.yaw),
          pitch: median(calibration.pitch),
          iris: median(calibration.iris),
        };
      }
      return;
    }

    const turned =
      Math.abs(yaw - baseline.yaw) > YAW_DEGREES || Math.abs(pitch - baseline.pitch) > PITCH_DEGREES;
    const eyesOff = Math.abs(iris - baseline.iris) > IRIS_OFFSET;

    // Head rotation alone is enough; iris offset alone is not trusted, because
    // uncalibrated gaze cannot tell a second screen from the edge of this one.
    if (!turned && !(eyesOff && Math.abs(yaw - baseline.yaw) > YAW_DEGREES / 2)) {
      awaySince = 0;
      return;
    }

    if (!awaySince) awaySince = Date.now();
    const seconds = Math.round((Date.now() - awaySince) / 1000);
    if (seconds >= AWAY_SECONDS) report("looking_away", `Looked away from the screen for ${seconds}s`);
  }, SAMPLE_MS);

  return {
    stream,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      landmarker.close();
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
    },
  };
}
