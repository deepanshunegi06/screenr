"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";

import { Wordmark, buttonClass, inputClass } from "@/components/Chrome";
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

  return <Live token={token} candidate={intro.candidate} onFinished={() => setStage("done")} />;
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
      await api.start(token);
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

function Live({
  token,
  candidate,
  onFinished,
}: {
  token: string;
  candidate: string;
  onFinished: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.start(token).then((res) => {
      if (res.say) setLines([{ speaker: "agent", text: res.say }]);
    });
  }, [token]);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, thinking]);

  // Tab and window switches are reported as observations for a human to read.
  // Nothing here reaches scoring -- see docs/adr/005.
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else if (hiddenAt) {
        const seconds = Math.round((Date.now() - hiddenAt) / 1000);
        if (seconds >= 3) {
          api.integrity(token, "tab_hidden", `Switched away for ${seconds}s`);
        }
        hiddenAt = 0;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [token]);

  const send = useCallback(async () => {
    const answer = draft.trim();
    if (!answer || thinking) return;
    setDraft("");
    setLines((prev) => [...prev, { speaker: "you", text: answer }]);
    setThinking(true);
    try {
      const res = await api.turn(token, answer);
      setLines((prev) => [...prev, { speaker: "agent", text: res.say }]);
      if (res.finished) setTimeout(onFinished, 2500);
    } catch {
      setLines((prev) => [
        ...prev,
        { speaker: "agent", text: "Something dropped on my side. Say that again?" },
      ]);
    } finally {
      setThinking(false);
    }
  }, [draft, thinking, token, onFinished]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-rule bg-sheet px-6 py-4">
        <Wordmark />
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-2 text-[12px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-rust" />
            Recording
          </span>
          <span className="font-mono text-[13px] text-ink">{mmss(elapsed)}</span>
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
        {lines.map((line, i) => (
          <div key={i} className="mb-7">
            <p className="eyebrow">{line.speaker === "agent" ? "Interviewer" : candidate}</p>
            <p
              className={`mt-2 leading-relaxed ${
                line.speaker === "agent"
                  ? "font-display text-[19px] text-ink"
                  : "text-[15px] text-ink-soft"
              }`}
            >
              {line.text}
            </p>
          </div>
        ))}
        {thinking && <p className="eyebrow animate-pulse">Interviewer is thinking</p>}
        <div ref={endRef} />
      </div>

      <div className="sticky bottom-0 border-t border-rule bg-sheet px-6 py-4">
        <div className="mx-auto flex max-w-2xl gap-3">
          <textarea
            className={`${inputClass} h-[52px] resize-none`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Type your answer. Enter to send."
            disabled={thinking}
          />
          <button className={buttonClass} onClick={send} disabled={thinking || !draft.trim()}>
            Send
          </button>
        </div>
        <p className="mx-auto mt-2 max-w-2xl text-[12px] text-faint">
          Typed for now — voice is being wired up.
        </p>
      </div>
    </div>
  );
}
