"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";

import { Wordmark, buttonClass, inputClass } from "@/components/Chrome";
import { InterviewRoom } from "@/components/InterviewRoom";
import { api, mmss } from "@/lib/api";

type Line = { speaker: "agent" | "you"; text: string };

export default function InterviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [intro, setIntro] = useState<Awaited<ReturnType<typeof api.intro>> | null>(null);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<"consent" | "live" | "done">("consent");

  useEffect(() => {
    api
      .intro(token)
      .then((data) => {
        setIntro(data);
        if (data.finished) setStage("done");
        else if (data.started) setStage("live");
      })
      .catch(() => setError("This interview link is no longer valid."));
  }, [token]);

  if (error) {
    return (
      <Centered>
        <p className="font-display text-[24px] text-ink">{error}</p>
        <p className="mt-3 text-[14px] text-muted">
          Ask whoever invited you to send a new one.
        </p>
      </Centered>
    );
  }

  if (!intro) return <Centered>{null}</Centered>;

  if (stage === "done") {
    return (
      <Centered>
        <p className="eyebrow">All done</p>
        <p className="mt-4 font-display text-[28px] leading-snug text-ink">
          Thanks, {intro.candidate}. That's the end of the screen.
        </p>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted">
          Someone from the team reviews the conversation and decides what happens next.
          Nothing was decided automatically.
        </p>
      </Centered>
    );
  }

  if (stage === "consent") {
    return (
      <Consent
        token={token}
        intro={intro}
        onStarted={() => setStage("live")}
        onError={setError}
      />
    );
  }

  return (
    <InterviewRoom
      token={token}
      candidate={intro.candidate}
      onFinished={() => setStage("done")}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-rule bg-sheet px-6 py-4">
        <Wordmark />
      </header>
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div>{children}</div>
      </div>
    </div>
  );
}

function Consent({
  token,
  intro,
  onStarted,
  onError,
}: {
  token: string;
  intro: { candidate: string; roleTitle: string; maxMinutes: number };
  onStarted: () => void;
  onError: (message: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [proctoring, setProctoring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function begin() {
    if (!recording) {
      setProblem("Tick the first box to continue. The interview can't run without it.");
      return;
    }
    setBusy(true);
    try {
      await api.consent(token, recording, proctoring);
      // The opening question comes from the voice socket, not from here. Calling
      // the typed start endpoint would burn that turn before the agent connects.
      onStarted();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not start");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-rule bg-sheet px-6 py-4">
        <Wordmark />
      </header>
      <div className="mx-auto w-full max-w-xl px-6 py-14">
        <p className="eyebrow">{intro.roleTitle}</p>
        <h1 className="mt-3 font-display text-[30px] leading-snug text-ink">
          Hello {intro.candidate} — here's how this works.
        </h1>

        <ul className="mt-8 space-y-4 text-[15px] leading-relaxed text-ink-soft">
          <li className="border-l-2 border-rule pl-4">
            You'll talk with an AI interviewer for up to {intro.maxMinutes} minutes. It asks
            follow-up questions based on your answers, so there's no fixed list.
          </li>
          <li className="border-l-2 border-rule pl-4">
            It writes down what you say and scores it against a rubric. Every score has to
            point at something you actually said.
          </li>
          <li className="border-l-2 border-pine pl-4">
            <span className="text-ink">It does not decide anything.</span> A person reads the
            transcript and makes the call.
          </li>
          <li className="border-l-2 border-rule pl-4">
            Say "I don't know" when you don't. It scores honesty higher than a confident
            guess.
          </li>
        </ul>

        <div className="mt-10 space-y-4 border-t border-rule pt-8">
          <label className="flex cursor-pointer gap-3">
            <input
              type="checkbox"
              checked={recording}
              onChange={(e) => {
                setRecording(e.target.checked);
                setProblem("");
              }}
              className="mt-1 accent-pine"
            />
            <span className="text-[14px] leading-relaxed text-ink">
              Record and transcribe this conversation.
              <span className="mt-0.5 block text-[13px] text-muted">
                The text is kept with your application. Audio is not stored.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer gap-3">
            <input
              type="checkbox"
              checked={proctoring}
              onChange={(e) => setProctoring(e.target.checked)}
              className="mt-1 accent-pine"
            />
            <span className="text-[14px] leading-relaxed text-ink">
              Camera checks during the interview.
              <span className="mt-0.5 block text-[13px] text-muted">
                Optional. Runs on your device — no video is sent or stored, only notes like
                "no face for 8 seconds". Declining is fine and doesn't affect scoring.
              </span>
            </span>
          </label>
        </div>

        {problem && <p className="mt-5 text-[13px] text-rust">{problem}</p>}

        <button className={`${buttonClass} mt-8`} onClick={begin} disabled={busy}>
          {busy ? "Starting…" : "Start the interview"}
        </button>
      </div>
    </div>
  );
}
