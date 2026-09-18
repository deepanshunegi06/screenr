"use client";

import { use, useEffect, useState } from "react";

import { InterviewRoom } from "@/components/InterviewRoom";
import { Button, Card, Logo, Skeleton } from "@/components/ui";
import { AgentVoice } from "@/lib/audio";
import { api, type InterviewIntro } from "@/lib/api";

type Stage = "loading" | "invalid" | "consent" | "live" | "done";

export default function InterviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [intro, setIntro] = useState<InterviewIntro | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [proctoring, setProctoring] = useState(false);
  // One AgentVoice for the page, unlocked inside the Start click.
  const [voice] = useState(() => new AgentVoice());

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
        <h1 className="text-[18px] font-semibold text-fg">This link isn&apos;t valid any more</h1>
        <p className="mt-2 text-[14px] text-fg-2">Ask whoever invited you to send a new one.</p>
      </Frame>
    );
  }

  if (!intro) return null;

  if (stage === "done") {
    return (
      <Frame>
        <h1 className="text-[18px] font-semibold text-fg">Thanks, {intro.candidate}. That&apos;s the end.</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-fg-2">
          Someone from the team reviews the conversation and decides what happens next. Nothing
          was decided automatically.
        </p>
      </Frame>
    );
  }

  if (stage === "consent") {
    return (
      <Consent
        token={token}
        intro={intro}
        onStart={async (cameraChecks) => {
          await voice.unlock();
          setProctoring(cameraChecks);
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
      cameraChecks={proctoring}
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
      <div className="text-[12px] font-medium text-fg-2">{intro.roleTitle}</div>
      <h1 className="mt-1 text-[18px] font-semibold text-fg">Hello {intro.candidate}. Here&apos;s how this works.</h1>

      <ol className="mt-5 space-y-3 text-[14px] leading-relaxed text-fg">
        <li className="flex gap-3">
          <span className="tnum w-4 shrink-0 text-fg-3">1</span>
          You&apos;ll talk with an AI interviewer for up to {intro.maxMinutes} minutes. It asks follow-up
          questions based on your answers, so there&apos;s no fixed list.
        </li>
        <li className="flex gap-3">
          <span className="tnum w-4 shrink-0 text-fg-3">2</span>
          It writes down what you say. Every note it makes has to point at something you actually said.
        </li>
        <li className="flex gap-3">
          <span className="tnum w-4 shrink-0 text-fg-3">3</span>
          It doesn&apos;t decide anything. A person reads the transcript and makes the call.
        </li>
        <li className="flex gap-3">
          <span className="tnum w-4 shrink-0 text-fg-3">4</span>
          Say &quot;I don&apos;t know&quot; when you don&apos;t. Honesty scores better than a confident guess.
        </li>
      </ol>

      <label className="mt-6 flex cursor-pointer gap-3 rounded-md border border-border bg-surface-2/50 p-3">
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
            Optional. Runs entirely on your device — no video is sent or stored, only notes like
            &quot;no one in frame for 12 seconds&quot;. Declining is fine and changes nothing about
            your scoring.
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
