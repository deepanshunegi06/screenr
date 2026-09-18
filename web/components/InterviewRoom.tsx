"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Wordmark, buttonClass, ghostButtonClass, inputClass } from "@/components/Chrome";
import { AgentVoice, startMicrophone, type MicHandle } from "@/lib/audio";
import { mmss, wsUrl } from "@/lib/api";

type Line = { speaker: "agent" | "you"; text: string };
type Phase = "connecting" | "listening" | "thinking" | "speaking" | "ended" | "failed";

const PHASE_LABEL: Record<Phase, string> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Finished",
  failed: "Disconnected",
};

export function InterviewRoom({
  token,
  candidate,
  onFinished,
}: {
  token: string;
  candidate: string;
  onFinished: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [problem, setProblem] = useState("");
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  const socket = useRef<WebSocket | null>(null);
  const mic = useRef<MicHandle | null>(null);
  const voice = useRef<AgentVoice | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, phase]);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // Tab switches are recorded for a human to read. They are not scored.
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else if (hiddenAt) {
        const seconds = Math.round((Date.now() - hiddenAt) / 1000);
        if (seconds >= 3) {
          socket.current?.send(
            JSON.stringify({
              type: "Integrity",
              kind: "tab_hidden",
              detail: `Switched away for ${seconds}s`,
            }),
          );
        }
        hiddenAt = 0;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const agentVoice = new AgentVoice();
    voice.current = agentVoice;

    async function begin() {
      try {
        const ws = new WebSocket(wsUrl(`/ws/interview/${token}`));
        ws.binaryType = "arraybuffer";
        socket.current = ws;

        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            agentVoice.play(event.data);
            setPhase((p) => (p === "ended" ? p : "speaking"));
            return;
          }
          const frame = JSON.parse(event.data);
          switch (frame.type) {
            case "Ready":
              setPhase("listening");
              break;
            case "ConversationText": {
              const text = (frame.content ?? "").trim();
              if (!text) break;
              setLines((prev) => [
                ...prev,
                { speaker: frame.role === "assistant" ? "agent" : "you", text },
              ]);
              break;
            }
            case "UserStartedSpeaking":
              agentVoice.interrupt();
              setPhase("listening");
              break;
            case "AgentThinking":
              setPhase("thinking");
              break;
            case "AgentAudioDone":
              setPhase("listening");
              break;
            case "Finished":
              setPhase("ended");
              setTimeout(onFinished, 2600);
              break;
            case "Rejected":
              setProblem(frame.reason ?? "Could not start.");
              setPhase("failed");
              break;
          }
        };

        ws.onerror = () => {
          setPhase("failed");
          setProblem("The connection dropped. Reload this page and it picks up where you left off.");
        };
        ws.onclose = () => setPhase((p) => (p === "ended" ? p : "failed"));

        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          setTimeout(() => reject(new Error("timeout")), 10000);
        });

        if (cancelled) return;

        mic.current = await startMicrophone((pcm) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
        });

        const meter = setInterval(() => setLevel(mic.current?.level() ?? 0), 100);
        return () => clearInterval(meter);
      } catch {
        if (!cancelled) {
          setPhase("failed");
          setProblem(
            "No microphone access. You can type your answers instead — the interview works either way.",
          );
          setTyping(true);
        }
      }
    }

    void begin();

    return () => {
      cancelled = true;
      mic.current?.stop();
      agentVoice.close();
      socket.current?.close();
    };
  }, [token, onFinished]);

  const sendTyped = useCallback(() => {
    const answer = draft.trim();
    if (!answer || !socket.current) return;
    socket.current.send(JSON.stringify({ type: "Typed", content: answer }));
    setLines((prev) => [...prev, { speaker: "you", text: answer }]);
    setDraft("");
    setPhase("thinking");
  }, [draft]);

  const live = phase !== "ended" && phase !== "failed";

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-rule bg-sheet px-6 py-4">
        <Wordmark />
        <div className="flex items-center gap-5">
          <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                phase === "failed" ? "bg-rust" : live ? "bg-pine" : "bg-faint"
              } ${phase === "thinking" ? "animate-pulse" : ""}`}
            />
            {PHASE_LABEL[phase]}
          </span>
          <span className="font-mono text-[13px] text-ink">{mmss(elapsed)}</span>
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
        {lines.length === 0 && live && (
          <p className="font-display text-[19px] text-muted">
            Setting up. Your interviewer will speak first — answer out loud when it does.
          </p>
        )}

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

        {phase === "ended" && (
          <p className="mt-8 border-l-2 border-pine pl-4 font-display text-[19px] text-ink">
            That's the end of the interview. A person reviews it from here.
          </p>
        )}

        {problem && <p className="mt-6 text-[14px] text-rust">{problem}</p>}
        <div ref={endRef} />
      </div>

      {live && (
        <div className="sticky bottom-0 border-t border-rule bg-sheet px-6 py-4">
          <div className="mx-auto max-w-2xl">
            {typing ? (
              <div className="flex gap-3">
                <textarea
                  className={`${inputClass} h-[52px] resize-none`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendTyped();
                    }
                  }}
                  placeholder="Type your answer. Enter to send."
                />
                <button className={buttonClass} onClick={sendTyped} disabled={!draft.trim()}>
                  Send
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <div className="flex h-8 flex-1 items-center gap-[3px]">
                  {Array.from({ length: 40 }, (_, i) => {
                    const height = Math.max(
                      3,
                      Math.min(32, level * 34 * (0.45 + Math.sin(i * 0.7) * 0.35 + 0.4)),
                    );
                    return (
                      <span
                        key={i}
                        className="flex-1 rounded-full bg-rule-soft transition-[height,background-color] duration-100"
                        style={{
                          height: `${height}px`,
                          backgroundColor:
                            level > 0.06 ? "var(--color-pine)" : "var(--color-rule)",
                        }}
                      />
                    );
                  })}
                </div>
                <button className={ghostButtonClass} onClick={() => setTyping(true)}>
                  Type instead
                </button>
              </div>
            )}
            <p className="mt-2 text-[12px] text-faint">
              {typing
                ? "Your microphone isn't being used. Answers are read by the interviewer as if spoken."
                : "Just talk — it will wait for you to finish. Pauses are fine."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
