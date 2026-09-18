/**
 * Browser-side integrity signals and the warning budget.
 *
 * Two different things live here and the difference matters:
 *
 *   notes       observations worth putting on the transcript timeline —
 *               a paste, a second display, the mic being swapped
 *   violations  leaving the interview: tab hidden, window blurred,
 *               fullscreen exited. These spend a warning.
 *
 * Spending the last warning ends the interview. Ending is not judging: the
 * scorecard records that it ended this way and a person still makes every
 * decision about the candidate (docs/adr/005-proctoring-never-touches-scoring.md).
 */

export type IntegrityKind =
  | "tab_hidden"
  | "window_blur"
  | "fullscreen_exit"
  | "paste"
  | "second_screen"
  | "audio_device_changed";

export type IntegritySignal = {
  kind: IntegrityKind;
  detail: string;
  /** Whether this spends a warning, or is only a note for the recruiter. */
  violation: boolean;
};

/** Brief blurs are the OS stealing focus — a notification, a permission prompt.
 *  Only a real departure counts. */
const BLUR_GRACE_MS = 1200;

/** One trip away is one warning, however many events it fires. */
const COALESCE_MS = 2500;

export type IntegrityWatch = { stop: () => void };

export function watchIntegrity(onSignal: (signal: IntegritySignal) => void): IntegrityWatch {
  let lastViolationAt = 0;
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const emit = (signal: IntegritySignal) => {
    if (stopped) return;
    if (signal.violation) {
      const now = Date.now();
      if (now - lastViolationAt < COALESCE_MS) return;
      lastViolationAt = now;
    }
    onSignal(signal);
  };

  const onVisibility = () => {
    if (document.hidden) {
      emit({ kind: "tab_hidden", detail: "Switched away from the interview tab", violation: true });
    }
  };

  const onBlur = () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      // document.hidden already covered a tab switch; this is another window
      // taking focus while ours is still visible.
      if (!document.hidden) {
        emit({ kind: "window_blur", detail: "Focus moved to another window", violation: true });
      }
    }, BLUR_GRACE_MS);
  };

  const onFocus = () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = null;
  };

  const onFullscreenChange = () => {
    if (!document.fullscreenElement) {
      emit({ kind: "fullscreen_exit", detail: "Left full screen", violation: true });
    }
  };

  const onPaste = (event: ClipboardEvent) => {
    const length = event.clipboardData?.getData("text")?.length ?? 0;
    emit({ kind: "paste", detail: `Pasted ${length} characters`, violation: false });
  };

  const onDeviceChange = () => {
    emit({ kind: "audio_device_changed", detail: "Audio device changed", violation: false });
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("paste", onPaste);
  navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);

  // A second display is a note, not a violation: plenty of people work on a
  // docked laptop and the interview is not going to punish them for it.
  if (typeof window !== "undefined" && "isExtended" in window.screen && window.screen.isExtended) {
    emit({ kind: "second_screen", detail: "A second display is connected", violation: false });
  }

  return {
    stop: () => {
      stopped = true;
      if (blurTimer) clearTimeout(blurTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("paste", onPaste);
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    },
  };
}

/** Ask for fullscreen. Browsers only grant it from a user gesture, and refusing
 *  is not an error worth stopping an interview over. */
export async function enterFullscreen(element: HTMLElement = document.documentElement): Promise<boolean> {
  try {
    await element.requestFullscreen?.();
    return true;
  } catch {
    return false;
  }
}

export async function exitFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    // leaving fullscreen is never worth an error
  }
}
