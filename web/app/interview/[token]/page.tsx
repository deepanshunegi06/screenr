"use client";

import { use, useCallback, useEffect, useState } from "react";

import { GazeCalibration, type GazeSetup } from "@/components/GazeCalibration";
import { InterviewRoom } from "@/components/InterviewRoom";
import { Button, Card, Logo, Skeleton } from "@/components/ui";
import { AgentVoice } from "@/lib/audio";
import { enterFullscreen } from "@/lib/integrity";
import { createTracker, type GazeTracker } from "@/lib/proctor";
import { api, type InterviewIntro } from "@/lib/api";

type Stage = "loading" | "invalid" | "consent" | "calibrating" | "live" | "done";

export default function InterviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [intro, setIntro] = useState<InterviewIntro | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  // One AgentVoice for the page, unlocked inside the Start click.
  const [voice] = useState(() => new AgentVoice());
  const [tracker, setTracker] = useState<GazeTracker | null>(null);
  const [gaze, setGaze] = useState<GazeSetup | null>(null);

  useEffect(() => {
    api
      .intro(token)
      .then((data) => {
        setIntro(data);
        if (data.finished) setStage("done");
        else if (data.consented && data.started) setStage("live");
        else setStage("consent");
      })
      .catch(() => setStage("invalid"));
  }, [token]);

  useEffect(() => () => voice.close(), [voice]);

  /** Camera and model live for the whole interview; calibration and monitoring
   *  share them, so the candidate is only prompted for the camera once. */
  const start = useCallback(
    async (cameraChecks: boolean) => {
      await voice.unlock();
      // Inside the click: browsers only grant fullscreen from a user gesture.
      await enterFullscreen();

      if (!cameraChecks) {
        setStage("live");
        return;
      }
      try {
        setTracker(await createTracker());
        setStage("calibrating");
      } catch {
        // Camera refused or unavailable. The interview runs unproctored rather
        // than not at all.
        setStage("live");
      }
    },
    [voice],
  );

  if (stage === "loading") {
    return (
      <Frame>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-4 h-7 w-72" />
        <Skeleton className="mt-6 h-24 w-full" />
      </Frame>
    );
  }

  if (stage === "invalid") {
    return (
      <Frame>
        <h1 className="display text-[24px] text-fg">This link isn&apos;t valid any more</h1>
        <p className="mt-2 text-[14px] text-fg-2">Ask whoever invited you to send a new one.</p>
      </Frame>
    );
  }

  if (!intro) return null;

  if (stage === "done") {
    return (
      <Frame>
        <h1 className="display text-[24px] leading-tight text-fg">
          Thanks, {intro.candidate}. That&apos;s the end.
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-fg-2">
          Someone from the team reviews the conversation and decides what happens next. Nothing
          was decided automatically.
        </p>
      </Frame>
    );
  }

  if (stage === "consent") {
    return <Consent token={token} intro={intro} onStart={start} />;
  }

  if (stage === "calibrating" && tracker) {
    return (
      <GazeCalibration
        tracker={tracker}
        onDone={(result) => {
          setGaze(result);
          setStage("live");
        }}
        onSkip={() => {
          tracker.stop();
          setTracker(null);
          setStage("live");
        }}
      />
    );
  }

  return (
    <InterviewRoom
      token={token}
      candidate={intro.candidate}
      maxMinutes={intro.maxMinutes}
      voice={voice}
      tracker={tracker}
      gaze={gaze}
      onFinished={() => setStage("done")}
    />
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-12 w-full max-w-[720px] items-center px-4">
          <Logo />
        </div>
      </header>
      <div className="mx-auto w-full max-w-[560px] flex-1 px-4 py-12">
        <Card>{children}</Card>
      </div>
    </div>
  );
}

function Consent({
  token,
  intro,
  onStart,
}: {
  token: string;
  intro: InterviewIntro;
  onStart: (cameraChecks: boolean) => Promise<void>;
}) {
  const [agreed, setAgreed] = useState(false);
  const [cameraChecks, setCameraChecks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function begin() {
    if (!agreed) {
      setProblem("Tick the box to continue. The interview can't run without it.");
      return;
    }
    setBusy(true);
    setProblem("");
    try {
      if (!intro.consented) await api.consent(token, true, cameraChecks);
      await onStart(cameraChecks);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Couldn't start. Try again.");
      setBusy(false);
    }
  }

  return (
    <Frame>
      <div className="text-[11px] font-medium uppercase tracking-[0.07em] text-fg-3">{intro.roleTitle}</div>
      <h1 className="display mt-1.5 text-[26px] leading-tight text-fg">
        Hello {intro.candidate}. Here&apos;s how this works.
      </h1>

      {/* Four facts, not four steps -- so no numbers, just hairlines. */}
      <ul className="mt-5 divide-y divide-border text-[14px] leading-relaxed text-fg">
        <li className="py-3 first:pt-0">
          You&apos;ll talk with an AI interviewer for up to {intro.maxMinutes} minutes. It asks
          follow-up questions based on your answers, so there&apos;s no fixed list.
        </li>
        <li className="py-3">
          It writes down what you say. Every note it makes has to point at something you actually
          said.
        </li>
        <li className="py-3">
          It doesn&apos;t decide anything. A person reads the transcript and makes the call.
        </li>
        <li className="py-3">
          Say &quot;I don&apos;t know&quot; when you don&apos;t. Honesty scores better than a
          confident guess.
        </li>
      </ul>

      <div className="mt-5 rounded-md border border-border bg-surface-2/60 p-3">
        <div className="text-[13px] font-medium text-fg">Before you start</div>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-2">
          The interview opens in full screen. Leaving full screen, switching tabs, or moving to
          another window each gives you a warning — after three, the interview ends and a person
          reviews whatever was recorded up to that point.
        </p>
      </div>

      <label className="mt-5 flex cursor-pointer gap-3 rounded-md border border-border bg-surface-2/50 p-3">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => {
            setAgreed(e.target.checked);
            setProblem("");
          }}
          className="mt-0.5 accent-accent"
        />
        <span className="text-[14px] text-fg">
          Record and transcribe this conversation.
          <span className="mt-0.5 block text-[12px] text-fg-3">
            The text is kept with your application. Audio isn&apos;t stored.
          </span>
        </span>
      </label>

      <label className="mt-3 flex cursor-pointer gap-3 rounded-md border border-border bg-surface-2/50 p-3">
        <input
          type="checkbox"
          checked={cameraChecks}
          onChange={(e) => setCameraChecks(e.target.checked)}
          className="mt-0.5 accent-accent"
        />
        <span className="text-[14px] text-fg">
          Camera checks during the interview.
          <span className="mt-0.5 block text-[12px] text-fg-3">
            Optional. You&apos;ll look at four points first, so the checks know where your eyes sit.
            After that, looking away from the screen also costs a warning. Everything runs on your
            device, and nothing is recorded — but if a warning fires, the picture at that moment
            is saved for whoever reviews this. Declining is fine and changes nothing about your
            scoring.
          </span>
        </span>
      </label>

      {problem && (
        <p role="alert" className="mt-3 text-[12px] text-bad">
          {problem}
        </p>
      )}

      <Button variant="primary" className="mt-5" onClick={begin} loading={busy}>
        Start interview
      </Button>
      <p className="mt-3 text-[12px] text-fg-3">
        Your browser will ask for microphone access. If that doesn&apos;t work, you can type instead.
      </p>
    </Frame>
  );
}
