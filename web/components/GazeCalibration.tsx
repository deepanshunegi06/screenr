"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui";
import {
  averageFeatures,
  calibrationProblem,
  fitGazeModel,
  judge,
  Smoother,
  type GazeFeatures,
  type GazeModel,
  type ScreenPoint,
} from "@/lib/gaze";
import type { GazeTracker } from "@/lib/proctor";

/**
 * Look at five dots, then prove it works.
 *
 * The calibration itself is the standard approach: known screen points, record
 * features at each, fit a regression. The second half matters just as much —
 * the candidate is asked to deliberately look away, and if the model does not
 * notice, camera checks are turned off and they are told so. An earlier version
 * failed this step silently and ran the whole interview detecting nothing,
 * which is the worst of both worlds: no protection, and false confidence.
 */

export type GazeSetup = { model: GazeModel; neutral: GazeFeatures };

/**
 * A three-by-three grid, centre first.
 *
 * Five points on the two midlines only ever showed the fit one horizontal and
 * one vertical sweep, which is barely more than the four free parameters it has
 * to set -- hold one out to measure the fit honestly and there is nothing left.
 * The corners are what make that measurement possible, and they are also where
 * a phone or a second monitor actually sits.
 */
const POINTS: { at: ScreenPoint; label: string }[] = [
  { at: { sx: 0.5, sy: 0.5 }, label: "Look at the centre dot" },
  { at: { sx: 0.04, sy: 0.5 }, label: "Now the left edge" },
  { at: { sx: 0.96, sy: 0.5 }, label: "Now the right edge" },
  { at: { sx: 0.5, sy: 0.05 }, label: "Now the top" },
  { at: { sx: 0.5, sy: 0.95 }, label: "Now the bottom" },
  { at: { sx: 0.04, sy: 0.05 }, label: "Top left corner" },
  { at: { sx: 0.96, sy: 0.05 }, label: "Top right corner" },
  { at: { sx: 0.04, sy: 0.95 }, label: "Bottom left corner" },
  { at: { sx: 0.96, sy: 0.95 }, label: "Bottom right corner" },
];

const SETTLE_MS = 800;
const CAPTURE_MS = 1000;
const MIN_FRAMES = 5;

/** The check must fire within this long while they are looking away, or the
 *  model is not good enough to act on. */
const VERIFY_SECONDS = 6;

type Phase = "points" | "verify" | "failed";

export function GazeCalibration({
  tracker,
  onDone,
  onSkip,
}: {
  tracker: GazeTracker;
  onDone: (setup: GazeSetup | null) => void;
  onSkip: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("points");
  const [step, setStep] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [message, setMessage] = useState("");
  const [verifySeconds, setVerifySeconds] = useState(VERIFY_SECONDS);
  const view = useRef<HTMLVideoElement>(null);
  const collected = useRef<{ features: GazeFeatures; target: ScreenPoint }[]>([]);
  const setup = useRef<GazeSetup | null>(null);

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    el.srcObject = tracker.stream;
    void el.play().catch(() => {});
  }, [tracker.stream]);

  const captureAt = useCallback(
    async (target: ScreenPoint) => {
      const samples: GazeFeatures[] = [];
      const deadline = Date.now() + CAPTURE_MS;
      while (Date.now() < deadline) {
        const { features } = tracker.read();
        if (features) samples.push(features);
        await new Promise((r) => setTimeout(r, 70));
      }
      if (samples.length < MIN_FRAMES) return false;
      collected.current.push({ features: averageFeatures(samples), target });
      return true;
    },
    [tracker],
  );

  // Walk the five points.
  useEffect(() => {
    if (phase !== "points") return;
    let cancelled = false;

    const run = async () => {
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      if (cancelled) return;
      setCapturing(true);
      const ok = await captureAt(POINTS[step].at);
      if (cancelled) return;
      setCapturing(false);

      if (!ok) {
        setMessage("The camera can't see your face clearly enough. Check the lighting.");
        setPhase("failed");
        return;
      }
      if (step < POINTS.length - 1) {
        setStep((s) => s + 1);
        return;
      }

      const model = fitGazeModel(collected.current);
      const problem = calibrationProblem(model);
      if (!model || problem) {
        setMessage(problem ?? "Couldn't build a gaze model from those readings.");
        setPhase("failed");
        return;
      }
      // Neutral is the head pose while looking at the centre of the screen,
      // found by target rather than by position in the list so that reordering
      // the grid cannot quietly make it the top-left corner instead.
      const centre = collected.current.find((s) => s.target.sx === 0.5 && s.target.sy === 0.5);
      if (!centre) {
        setMessage("Couldn't build a gaze model from those readings.");
        setPhase("failed");
        return;
      }
      setup.current = { model, neutral: centre.features };
      setPhase("verify");
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [phase, step, captureAt]);

  // Prove it. They look away; the model has to notice.
  useEffect(() => {
    if (phase !== "verify" || !setup.current) return;
    let cancelled = false;
    const smoother = new Smoother();
    const started = Date.now();

    const timer = setInterval(() => {
      if (cancelled) return;
      const left = VERIFY_SECONDS - Math.floor((Date.now() - started) / 1000);
      setVerifySeconds(Math.max(0, left));

      const { features } = tracker.read();
      if (features && setup.current) {
        const verdict = judge(setup.current.model, smoother.push(features), setup.current.neutral);
        if (verdict.off) {
          clearInterval(timer);
          onDone(setup.current);
          return;
        }
      }
      if (left <= 0) {
        clearInterval(timer);
        setMessage(
          "The checks couldn't tell you were looking away. Camera checks will stay off for this interview.",
        );
        setPhase("failed");
      }
    }, 200);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, tracker, onDone]);

  const retry = () => {
    collected.current = [];
    setup.current = null;
    setMessage("");
    setStep(0);
    setVerifySeconds(VERIFY_SECONDS);
    setPhase("points");
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-fg">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div>
          <p className="display text-[19px] text-white">Setting up the camera checks</p>
          <p className="mt-0.5 text-[13px] text-white/60">
            {phase === "verify"
              ? "One last check that it works."
              : "Keep your head still and move only your eyes."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <video
            ref={view}
            muted
            playsInline
            className="h-14 w-[74px] -scale-x-100 rounded-md object-cover ring-1 ring-white/20"
          />
          <Button variant="ghost" className="text-white/70 hover:bg-white/10" onClick={onSkip}>
            Skip
          </Button>
        </div>
      </div>

      <div className="relative flex-1">
        {phase === "points" &&
          POINTS.map((p, i) => (
            <div
              key={i}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 transition-opacity duration-300"
              style={{ left: `${p.at.sx * 100}%`, top: `${p.at.sy * 100}%`, opacity: i === step ? 1 : 0 }}
            >
              <span className="relative grid h-7 w-7 place-items-center">
                <span
                  aria-hidden
                  className={`absolute inset-0 rounded-full bg-accent/40 ${
                    i === step && !capturing ? "animate-ping" : ""
                  }`}
                />
                <span
                  aria-hidden
                  className={`relative h-3.5 w-3.5 rounded-full transition-colors ${
                    capturing && i === step ? "bg-ok" : "bg-accent"
                  }`}
                />
              </span>
            </div>
          ))}

        <div className="absolute inset-x-0 top-1/2 flex -translate-y-28 flex-col items-center px-6 text-center">
          {phase === "points" && (
            <>
              <p className="display text-[23px] text-white" role="status">
                {POINTS[step].label}
              </p>
              <p className="mt-1 text-[13px] text-white/50">
                {capturing ? "Hold it…" : `${step + 1} of ${POINTS.length}`}
              </p>
            </>
          )}

          {phase === "verify" && (
            <>
              <p className="display text-[23px] text-white" role="status">
                Now look away from the screen
              </p>
              <p className="mt-1 max-w-sm text-[13px] text-white/50">
                Down at your lap, or off to one side. Checking that the tracker notices — {verifySeconds}s
              </p>
            </>
          )}

          {phase === "failed" && (
            <>
              <p className="display max-w-md text-[21px] text-white" role="alert">
                {message}
              </p>
              <div className="mt-5 flex gap-2">
                <Button variant="primary" onClick={retry}>
                  Try again
                </Button>
                <Button
                  variant="ghost"
                  className="text-white/70 hover:bg-white/10"
                  onClick={() => onDone(null)}
                >
                  Continue without camera checks
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      <p className="px-5 pb-5 text-center text-[12px] text-white/40">
        This runs on your device. Nothing is recorded — but if a warning fires, the
        picture at that moment is saved for the reviewer.
      </p>
    </div>
  );
}
