"use client";

import { useRef, useState } from "react";

import { Button, Spinner } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

/**
 * Drop a résumé in. Recruiters have PDFs, not text in a clipboard.
 *
 * The file is parsed and discarded; only the text is kept, and it is shown back
 * so the recruiter can see what the interviewer will actually read. A scanned
 * résumé produces no text, and saying so beats silently starting an interview
 * with nothing to ask about.
 */
export function ResumeDrop({
  text,
  onText,
  onName,
  onPaste,
}: {
  text: string;
  onText: (text: string) => void;
  onName?: (name: string) => void;
  onPaste?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filename, setFilename] = useState("");

  async function take(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const parsed = await api.parseResume(file);
      onText(parsed.text);
      if (parsed.name && onName) onName(parsed.name);
      setFilename(file.name);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't read that file.");
    } finally {
      setBusy(false);
    }
  }

  if (text) {
    return (
      <div className="rounded-md border border-border bg-surface-2/50 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-fg">
              {filename || "Résumé text"}
            </div>
            <div className="text-[12px] text-fg-3">
              {text.length.toLocaleString()} characters the interviewer will read
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onText("");
              setFilename("");
            }}
          >
            Remove
          </Button>
        </div>
        <p className="mt-2 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg-2">
          {text.slice(0, 400)}
          {text.length > 400 ? "…" : ""}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void take(e.dataTransfer.files?.[0]);
        }}
        onClick={() => input.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-6 text-center transition-colors ${
          over ? "border-accent bg-accent-soft/50" : "border-border-strong hover:border-accent"
        }`}
      >
        {busy ? (
          <span className="flex items-center gap-2 text-[13px] text-fg-2">
            <Spinner /> Reading the file…
          </span>
        ) : (
          <>
            <span className="text-[13px] font-medium text-fg">Drop a résumé here</span>
            <span className="mt-0.5 text-[12px] text-fg-3">PDF, Word, or text — or click to browse</span>
          </>
        )}
        <input
          ref={input}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          className="hidden"
          onChange={(e) => void take(e.target.files?.[0])}
        />
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-bad">
          {error}
        </p>
      )}
      {onPaste && (
        <button type="button" onClick={onPaste} className="mt-1.5 text-[12px] text-accent hover:underline">
          Or paste the text instead
        </button>
      )}
    </div>
  );
}
