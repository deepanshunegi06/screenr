"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ProctorPanel } from "@/components/ProctorPanel";
import { Badge, Button, Logo, Textarea } from "@/components/ui";
import { Wrapping } from "@/components/Wrapping";
import { AgentVoice, startMicrophone, type MicHandle } from "@/lib/audio";
import { exitFullscreen, watchIntegrity, type IntegrityWatch } from "@/lib/integrity";
import type { GazeSetup } from "@/components/GazeCalibration";
import { watchCamera, type GazeTracker, type ProctorHandle, type ProctorStatus } from "@/lib/proctor";
import { api, mmss, wsUrl } from "@/lib/api";

type Line = { speaker: "agent" | "you"; text: string; tools?: string[] };
type Phase = "connecting" | "listening" | "thinking" | "speaking" | "ending" | "ended" | "failed";

const PHASE_LABEL: Record<Phase, string> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Interviewer speaking",
  ending: "Wrapping up",
  ended: "Finished",
  failed: "Disconnected",
};

// What the candidate sees the agent doing. Names only, never what it concluded.
const TOOL_LABEL: Record<string, string> = {
  record_evidence: "Noting your answer",
  plan_probe: "Following up",
  mark_claim: "Checking your résumé",
  end_interview: "Wrapping up",
  escalate_to_human: "Flagging for a reviewer",
};

const MAX_WARNINGS = 3;

export function InterviewRoom({
  token,
  candidate,
  maxMinutes,
  voice,
  tracker,
  gaze,
  onFinished,
}: {
  token: string;
  candidate: string;
  maxMinutes: number;
  /** Created and unlocked inside the Start click, so autoplay policy is satisfied. */
  voice: AgentVoice;
  /** Camera and model, already running from the calibration step. Null when the
   *  candidate declined or calibration could not be trusted. */
  tracker: GazeTracker | null;
  gaze: GazeSetup | null;
  onFinished: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [elapsed, setElapsed] = useState(0);
  const [bins, setBins] = useState<Uint8Array>(new Uint8Array(24));
  const [problem, setProblem] = useState("");
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [resumed, setResumed] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [pendingTools, setPendingTools] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [warnings, setWarnings] = useState(0);
  const [warning, setWarning] = useState<{ text: string; count: number } | null>(null);
  const [removed, setRemoved] = useState(false);
  const [proctorStatus, setProctorStatus] = useState<ProctorStatus | null>(null);


  const socket = useRef<WebSocket | null>(null);
  const mic = useRef<MicHandle | null>(null);
  const proctor = useRef<ProctorHandle | null>(null);
  const integrity = useRef<IntegrityWatch | null>(null);
  const meter = useRef<ReturnType<typeof setInterval> | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const warningsRef = useRef(0);
  // Read inside handleSignal, which must not be rebuilt every time the camera
  // changes -- it is a dependency of the socket effect.
  const trackerRef = useRef(tracker);
  const endedRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
    trackerRef.current = tracker;
  }, [onFinished, tracker]);

  const send = useCallback((frame: object) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }, []);

  const stopProctor = useCallback(() => {
    proctor.current?.stop();
    proctor.current = null;
    tracker?.stop();
  }, [tracker]);

  const stopMic = useCallback(() => {
    mic.current?.stop();
    mic.current = null;
    if (meter.current) clearInterval(meter.current);
    meter.current = null;
    setBins(new Uint8Array(24));
  }, []);

  const startMic = useCallback(async () => {
    const handle = await startMicrophone((pcm) => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(pcm);
    });
    mic.current = handle;
    meter.current = setInterval(() => setBins(new Uint8Array(handle.bins())), 80);
  }, []);

  /** Shut everything down and show the wrapping screen. Every exit goes through
   *  here: the candidate's own choice, the warning limit, or the agent finishing. */
  const finishUp = useCallback(
    (reason?: "violations") => {
      if (endedRef.current) return;
      endedRef.current = true;
      if (reason) setRemoved(true);
      send({ type: "End", reason });
      setPhase("ending");
      stopMic();
      stopProctor();
      integrity.current?.stop();
      integrity.current = null;
      void exitFullscreen();
      // The server answers immediately now, but the candidate should never be
      // stuck on this screen if it does not.
      setTimeout(() => setPhase((p) => (p === "ending" ? "ended" : p)), 6000);
    },
    [send, stopMic, stopProctor],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, phase, pendingTools]);

  /** A violation spends a warning; the last one ends the interview. Notes never
   *  spend anything -- they are only context for whoever reads the transcript. */
  const handleSignal = useCallback(
    (kind: string, detail: string, violation: boolean) => {
      if (endedRef.current) return;
      // A frame goes with anything that spends a warning. Whoever reviews this
      // should be looking at the moment, not at a description of it.
      send({ type: "Integrity", kind, detail, shot: violation ? trackerRef.current?.grab(detail) : null });
      if (!violation) return;

      const count = warningsRef.current + 1;
      warningsRef.current = count;
      setWarnings(count);

      if (count >= MAX_WARNINGS) {
        setWarning({ text: "that was the last warning, so the interview has ended.", count });
        finishUp("violations");
        return;
      }
      setWarning({
        text: `${detail.toLowerCase()}. Stay in this window for the rest of the interview.`,
        count,
      });
      setTimeout(() => setWarning(null), 6000);
    },
    [send, finishUp],
  );

  useEffect(() => {
    let cancelled = false;
    let openTimer: ReturnType<typeof setTimeout> | null = null;

    async function begin() {
      setPhase("connecting");
      setProblem("");

      // Redraw what already happened, so a reload does not look like a reset.
      try {
        const state = await api.interviewState(token);
        if (cancelled) return;
        if (state.exists && state.transcript?.length) {
          setLines(
            state.transcript.map((t) => ({
              speaker: t.speaker === "agent" ? "agent" : "you",
              text: t.text,
            })),
          );
          setElapsed(state.elapsedSeconds ?? 0);
        }
        if (state.finished) {
          endedRef.current = true;
          setPhase("ended");
          return;
        }
      } catch {
        // Not fatal; the socket will tell us what it knows.
      }

      const ws = new WebSocket(wsUrl(`/ws/interview/${token}`));
      ws.binaryType = "arraybuffer";
      socket.current = ws;

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          voice.play(event.data);
          setPhase((p) => (p === "ended" || p === "failed" || p === "ending" ? p : "speaking"));
          return;
        }
        const frame = JSON.parse(event.data);
        switch (frame.type) {
          case "Ready":
            setPhase("listening");
            setResumed(Boolean(frame.resumed));
            if (timer.current) clearInterval(timer.current);
            timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
            break;
          case "ConversationText": {
            const text = (frame.content ?? "").trim();
            if (!text) break;
            if (frame.role === "assistant") {
              setPendingTools((tools) => {
                setLines((prev) => [...prev, { speaker: "agent", text, tools }]);
                return [];
              });
            } else {
              setLines((prev) => [...prev, { speaker: "you", text }]);
            }
            break;
          }
          case "AgentTool":
            setPendingTools((t) => (t.includes(frame.name) ? t : [...t, frame.name]));
            break;
          case "UserStartedSpeaking":
            voice.interrupt();
            setPhase((p) => (p === "ending" || p === "ended" ? p : "listening"));
            break;
          case "AgentThinking":
            setPhase((p) => (p === "ending" || p === "ended" ? p : "thinking"));
            break;
          case "AgentAudioDone":
            setPhase((p) => (p === "ending" || p === "ended" ? p : "listening"));
            break;
          case "Finished":
            endedRef.current = true;
            if (frame.reason === "removed") setRemoved(true);
            setPhase("ended");
            stopMic();
            stopProctor();
            void exitFullscreen();
            break;
          case "Rejected":
            setProblem(frame.reason ?? "Couldn't start the interview.");
            setPhase("failed");
            break;
          case "Error":
            setProblem(frame.description ?? "The interviewer hit a problem.");
            setPhase("failed");
            break;
        }
      };

      ws.onerror = () => {
        setPhase((p) => (p === "ended" || p === "ending" ? p : "failed"));
        setProblem("The connection dropped.");
      };
      ws.onclose = () => setPhase((p) => (p === "ended" || p === "ending" ? p : "failed"));

      try {
        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          openTimer = setTimeout(() => reject(new Error("timeout")), 10000);
        });
      } catch {
        if (!cancelled) {
          setPhase("failed");
          setProblem("Couldn't reach the interview server.");
        }
        return;
      } finally {
        if (openTimer) clearTimeout(openTimer);
      }
      if (cancelled) return;

      integrity.current = watchIntegrity((signal) =>
        handleSignal(signal.kind, signal.detail, signal.violation),
      );

      // Microphone failure is not a connection failure: the socket is fine and
      // the candidate can type.
      try {
        await startMic();
        if (cancelled) stopMic();
      } catch {
        if (!cancelled) {
          setTyping(true);
          setProblem("No microphone access. You can type your answers below.");
        }
      }

      // Camera checks only run if the candidate opted in and calibration worked.
      // Looking away spends a warning; the rest are notes for the recruiter.
      if (tracker && !cancelled) {
        proctor.current = watchCamera(
          tracker,
          gaze,
          (event) => handleSignal(event.kind, event.detail, event.kind === "looking_away"),
          setProctorStatus,
        );
      }
    }

    void begin();

    return () => {
      cancelled = true;
      if (openTimer) clearTimeout(openTimer);
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      stopMic();
      stopProctor();
      integrity.current?.stop();
      integrity.current = null;
      const ws = socket.current;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
      }
      socket.current = null;
    };
  }, [token, voice, attempt, tracker, gaze, startMic, stopMic, stopProctor, handleSignal]);

  const sendTyped = useCallback(() => {
    const answer = draft.trim();
    if (!answer) return;
    send({ type: "Typed", content: answer });
    setLines((prev) => [...prev, { speaker: "you", text: answer }]);
    setDraft("");
    setPhase("thinking");
  }, [draft, send]);

  const switchToTyping = useCallback(() => {
    stopMic();
    setTyping(true);
  }, [stopMic]);

  const switchToVoice = useCallback(async () => {
    try {
      await voice.unlock();
      await startMic();
      setTyping(false);
      setProblem("");
    } catch {
      setProblem("Still no microphone access. Check the browser's permission for this site.");
    }
  }, [startMic, voice]);

  const endInterview = useCallback(() => {
    if (!confirmEnd) {
      setConfirmEnd(true);
      setTimeout(() => setConfirmEnd(false), 5000);
      return;
    }
    setConfirmEnd(false);
    finishUp();
  }, [confirmEnd, finishUp]);

  const live = phase !== "ending" && phase !== "ended" && phase !== "failed";
  const remaining = Math.max(0, maxMinutes * 60 - elapsed);
  const progress = Math.min(100, (elapsed / (maxMinutes * 60)) * 100);

  if (phase === "ending" || phase === "ended") {
    return (
      <div className="flex min-h-dvh flex-col bg-bg">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex h-12 w-full max-w-[860px] items-center px-4">
            <Logo />
          </div>
        </header>
        <Wrapping done={phase === "ended"} removed={removed} />
        {phase === "ended" && (
          <div className="pb-12 text-center">
            <Button onClick={() => onFinishedRef.current()}>Close</Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      {warning && (
        <div
          role="alert"
          className={`sticky top-0 z-20 px-4 py-2.5 text-center text-[14px] font-medium text-white ${
            warning.count >= MAX_WARNINGS ? "bg-bad" : "bg-warn"
          }`}
        >
          Warning {Math.min(warning.count, MAX_WARNINGS)} of {MAX_WARNINGS} — {warning.text}
        </div>
      )}

      <header className="sticky top-0 z-10 border-b border-border bg-surface">
        <div className="mx-auto flex h-12 w-full max-w-[860px] items-center justify-between px-4">
          <Logo />
          <div className="flex items-center gap-4">
            {warnings > 0 && (
              <span className="text-[12px] font-medium text-warn">
                {warnings}/{MAX_WARNINGS} warnings
              </span>
            )}
            <span role="status" className="flex items-center gap-2 text-[13px] text-fg-2">
              <span
                aria-hidden
                className={`h-2 w-2 rounded-full ${phase === "failed" ? "bg-bad" : "bg-ok"} ${
                  phase === "thinking" ? "animate-pulse" : ""
                }`}
              />
              {PHASE_LABEL[phase]}
            </span>
            <span className="tnum font-mono text-[13px] text-fg" title="Time remaining">
              {mmss(remaining)}
            </span>
          </div>
        </div>
        <div className="h-0.5 w-full bg-surface-2">
          <div className="h-full bg-accent transition-[width] duration-1000" style={{ width: `${progress}%` }} />
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[860px] flex-1 gap-6 px-4 py-8">
        <div className="min-w-0 flex-1">
          {resumed && (
            <div className="mb-6 rounded-md bg-accent-soft px-3 py-2 text-[13px] text-accent-fg">
              Reconnected. Carry on from where you were.
            </div>
          )}

          {lines.length === 0 && (
            <p className="said text-fg-3">
              {phase === "connecting"
                ? "Connecting to your interviewer."
                : "Your interviewer will speak first. Answer out loud when it does."}
            </p>
          )}

          <div aria-live="polite" className="space-y-6">
            {lines.map((line, i) => (
              <div key={i}>
                <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.07em] text-fg-3">
                  {line.speaker === "agent" ? "Interviewer" : candidate}
                </div>
                <p className={line.speaker === "agent" ? "said text-fg" : "said text-fg-2"}>{line.text}</p>
                {line.tools && line.tools.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {line.tools.map((t) => (
                      <Badge key={t}>{TOOL_LABEL[t] ?? t}</Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {pendingTools.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {pendingTools.map((t) => (
                  <Badge key={t} tone="accent" dot>
                    {TOOL_LABEL[t] ?? t}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {problem && (
            <div
              role="alert"
              className="mt-6 flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-fg shadow-sm"
            >
              <span>{problem}</span>
              {phase === "failed" && (
                <Button size="sm" onClick={() => setAttempt((a) => a + 1)}>
                  Reconnect
                </Button>
              )}
            </div>
          )}
          <div ref={endRef} />
        </div>

        {tracker && (
          <aside className="hidden shrink-0 sm:block">
            <div className="sticky top-20">
              <ProctorPanel
                stream={tracker.stream}
                status={proctorStatus}
                warnings={warnings}
                maxWarnings={MAX_WARNINGS}
              />
              <p className="mt-2 w-[164px] text-[11px] leading-snug text-fg-3">
                Checks run on your device. Nothing is recorded — a warning saves the
                picture at that moment.
              </p>
            </div>
          </aside>
        )}
      </div>

      {live && (
        <div className="sticky bottom-0 border-t border-border bg-surface">
          <div className="mx-auto w-full max-w-[860px] px-4 py-3">
            {typing ? (
              <div className="flex items-end gap-2">
                <Textarea
                  aria-label="Your answer"
                  className="min-h-[44px] flex-1"
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      sendTyped();
                    }
                  }}
                  placeholder="Type your answer. Enter to send, Shift+Enter for a new line."
                />
                <Button variant="primary" onClick={sendTyped} disabled={!draft.trim()}>
                  Send
                </Button>
              </div>
            ) : (
              <div aria-hidden className="flex h-8 items-end gap-[3px]">
                {Array.from(bins).map((v, i) => (
                  <span
                    key={i}
                    className="flex-1 rounded-sm transition-[height] duration-75"
                    style={{
                      height: `${Math.max(3, (v / 255) * 32)}px`,
                      backgroundColor: v > 24 ? "var(--color-accent)" : "var(--color-border-strong)",
                    }}
                  />
                ))}
              </div>
            )}
            <div className="mt-2 flex items-center justify-between text-[12px] text-fg-3">
              <span>
                {typing
                  ? "Your microphone is off. Answers are read by the interviewer as if spoken."
                  : "Just talk. It waits for you to finish, and pauses are fine."}
              </span>
              <span className="flex gap-1">
                {typing ? (
                  <Button size="sm" variant="ghost" onClick={switchToVoice}>
                    Use voice
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={switchToTyping}>
                    Type instead
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={endInterview}>
                  {confirmEnd ? "Confirm end" : "End interview"}
                </Button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
