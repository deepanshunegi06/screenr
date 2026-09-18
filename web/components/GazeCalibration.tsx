"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui";
import {
  averageSample,
  calibrationIsUsable,
  type GazeCalibration as Calibration,
  type GazeSample,
  type GazeTarget,
  type GazeTracker,
} from "@/lib/proctor";

/**
 * Look at four dots. That is the whole calibration.
 *
 * Without it, iris position says almost nothing: head rotation swamps it and
 * everyone's eyes sit differently relative to their camera. With it, the checks
 * have a reference for where this person's eyes actually are when they look at
 * the screen versus off it — which is what makes eye movement detectable while
 * the head stays still.
 *
 * "down" is its own target because that is where a phone is.
 */

const STEPS: { target: GazeTarget; label: string; style: React.CSSProperties }[] = [
  { target: "center", label: "Look at the centre", style: { top: "50%", left: "50%" } },
  { target: "left", label: "Now the left edge", style: { top: "50%", left: "4%" } },
  { target: "right", label: "Now the right edge", style: { top: "50%", left: "96%" } },
  { target: "down", label: "Now down, as if at your lap", style: { top: "94%", left: "50%" } },
];

const SETTLE_MS = 900;
const CAPTURE_MS = 1100;

export function GazeCalibration({
  tracker,
  onDone,
  onSkip,
}: {
  tracker: GazeTracker;
  onDone: (calibration: Calibration | null) => void;
  onSkip: () => void;
}) {
  const [step, setStep] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [problem, setProblem] = useState("");
  const view = useRef<HTMLVideoElement>(null);
  const results = useRef<Partial<Record<GazeTarget, GazeSample>>>({});

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    el.srcObject = tracker.stream;
    void el.play().catch(() => {});
  }, [tracker.stream]);

  const capture = useCallback(
    async (target: GazeTarget) => {
      const samples: GazeSample[] = [];
      const deadline = Date.now() + CAPTURE_MS;
      while (Date.now() < deadline) {
        const { gaze } = tracker.sample();
        if (gaze) samples.push(gaze);
        await new Promise((r) => setTimeout(r, 80));
      }
      // Six good frames out of roughly fourteen. Below that the camera is not
      // seeing them well enough for the reference to mean anything.
      if (samples.length < 6) return false;
      results.current[target] = averageSample(samples);
      return true;
    },
    [tracker],
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      if (cancelled) return;
      setCapturing(true);
      const ok = await capture(STEPS[step].target);
      if (cancelled) return;
      setCapturing(false);

      if (!ok) {
        setProblem("The camera can't see you clearly enough. Check the lighting and try again.");
        return;
      }
      if (step < STEPS.length - 1) {
        setStep((s) => s + 1);
        return;
      }

      const calibration = results.current as Calibration;
      // A calibration where looking away barely differs from looking at the
      // screen is not usable. Running unproctored beats acting on noise.
      onDone(calibrationIsUsable(calibration) ? calibration : null);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [step, capture, onDone]);

  const retry = () => {
    results.current = {};
    setProblem("");
    setStep(0);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-fg">
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <p className="text-[15px] font-semibold text-white">Setting up the camera checks</p>
          <p className="mt-0.5 text-[13px] text-white/60">
            Keep your head still and move only your eyes. Four quick points.
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
        {STEPS.map((s, i) => (
          <div
            key={s.target}
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 transition-opacity duration-300"
            style={{ ...s.style, opacity: i === step ? 1 : 0 }}
          >
            <span className="relative grid h-6 w-6 place-items-center">
              <span
                aria-hidden
                className={`absolute inset-0 rounded-full bg-accent/40 ${
                  i === step && !capturing ? "animate-ping" : ""
                }`}
              />
              <span
                aria-hidden
                className={`relative h-3 w-3 rounded-full transition-colors ${
                  capturing && i === step ? "bg-ok" : "bg-accent"
                }`}
              />
            </span>
          </div>
        ))}

        <div className="absolute inset-x-0 top-1/2 flex -translate-y-24 flex-col items-center px-6 text-center">
          <p className="text-[18px] font-medium text-white" role="status">
            {problem || STEPS[step].label}
          </p>
          <p className="mt-1 text-[13px] text-white/50">
            {problem ? "" : capturing ? "Hold it…" : `${step + 1} of ${STEPS.length}`}
          </p>
          {problem && (
            <div className="mt-4 flex gap-2">
              <Button variant="primary" onClick={retry}>
                Try again
              </Button>
              <Button variant="ghost" className="text-white/70 hover:bg-white/10" onClick={onSkip}>
                Continue without camera checks
              </Button>
            </div>
          )}
        </div>
      </div>

      <p className="px-5 pb-5 text-center text-[12px] text-white/40">
        This runs on your device. No video is sent or stored.
      </p>
    </div>
  );
}
