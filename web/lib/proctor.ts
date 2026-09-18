/**
 * Camera presence checks, entirely on the candidate's device.
 *
 * MediaPipe's face detector runs in this tab against a hidden <video>. Frames are
 * never uploaded, never stored, and never reach our server — only three kinds of
 * event, each with the time it happened:
 *
 *   no_face          nobody in frame for a sustained stretch
 *   multiple_faces   more than one person in frame
 *   camera_lost      the track ended mid-interview
 *
 * What it deliberately does not do: gaze direction, emotion, attention scoring,
 * or any aggregate "suspicion" number. Those are unreliable, and they punish
 * people for thinking with their eyes off the screen. These events are notes for
 * a human reading the transcript, never inputs to a score
 * (see docs/adr/005-proctoring-never-touches-scoring.md).
 */

import { FilesetResolver, FaceDetector } from "@mediapipe/tasks-vision";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

/** How often to look. Once a second is plenty and keeps the main thread free
 *  for the audio pipeline, which matters far more to the interview. */
const SAMPLE_MS = 1000;

/** An absence only counts once it has lasted. People lean out of frame to think,
 *  reach for water, or shift in a chair; none of that is worth a note. */
const ABSENCE_SECONDS = 8;

/** Don't report the same ongoing condition over and over. */
const REPEAT_SECONDS = 60;

export type ProctorEvent = { kind: "no_face" | "multiple_faces" | "camera_lost"; detail: string };

export type ProctorHandle = {
  stop: () => void;
};

export async function startProctoring(onEvent: (event: ProctorEvent) => void): Promise<ProctorHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 320, height: 240, facingMode: "user" },
  });

  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  // Kept out of the layout: the candidate does not need to watch themselves, and
  // a visible preview invites people to perform for the camera.
  video.style.display = "none";
  document.body.appendChild(video);
  await video.play();

  const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
  const detector = await FaceDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    minDetectionConfidence: 0.5,
  });

  let stopped = false;
  let absentSince = 0;
  let lastReported: Record<string, number> = {};

  const report = (kind: ProctorEvent["kind"], detail: string) => {
    const now = Date.now();
    if (lastReported[kind] && now - lastReported[kind] < REPEAT_SECONDS * 1000) return;
    lastReported[kind] = now;
    onEvent({ kind, detail });
  };

  const timer = setInterval(() => {
    if (stopped) return;

    if (!stream.getVideoTracks().some((t) => t.readyState === "live")) {
      report("camera_lost", "Camera stopped during the interview");
      return;
    }
    if (video.readyState < 2) return;

    let faces = 0;
    try {
      faces = detector.detectForVideo(video, performance.now()).detections.length;
    } catch {
      return; // a dropped frame is not an event
    }

    if (faces === 0) {
      if (!absentSince) absentSince = Date.now();
      const seconds = Math.round((Date.now() - absentSince) / 1000);
      if (seconds >= ABSENCE_SECONDS) report("no_face", `No one in frame for ${seconds}s`);
      return;
    }

    absentSince = 0;
    if (faces > 1) report("multiple_faces", `${faces} people in frame`);
  }, SAMPLE_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      detector.close();
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
      lastReported = {};
    },
  };
}
