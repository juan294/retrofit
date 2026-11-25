import { requestAnalysis, type AnalysisRequestResult, type RequestOptions } from "./request";

/** What the page shows: while `busy`, its start buttons do nothing (aria-disabled); `waiting` is the text while Retrofit waits. */
export interface StartState {
  readonly busy: boolean;
  readonly waiting: string | null;
}

export interface StartControllerOptions {
  readonly request?: (url: string, o: RequestOptions) => Promise<AnalysisRequestResult>;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (id: unknown) => void;
  readonly onState: (s: StartState) => void;
  /** The result of each start, never after dispose. After a success the state stays busy (the page navigates). */
  readonly onResult: (r: AnalysisRequestResult) => void;
}

export interface StartController {
  /** Starts now and cancels a scheduled start. Ignored while a start is in flight. */
  start(url: string, attempts?: number): void;
  /** Starts after `ms`, showing `message` meanwhile. Ignored while a start is in flight or scheduled. */
  schedule(url: string, ms: number, message: string, attempts?: number): void;
  /** For unmount: cancels a scheduled start, aborts the one in flight and drops its result. */
  dispose(): void;
}

/**
 * One analysis start at a time for one page (the form or the failure notice):
 * a click during an automatic retry's wait replaces it, a second click while a
 * start is in flight does nothing, and nothing reaches the page after it left.
 */
export function createStartController(o: StartControllerOptions): StartController {
  const request = o.request ?? requestAnalysis;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const abort = new AbortController();
  let timer: unknown;
  let scheduled = false;
  let inFlight = false;

  const cancelScheduled = () => {
    if (!scheduled) return;
    clearTimer(timer);
    scheduled = false;
  };

  function start(url: string, attempts?: number): void {
    if (abort.signal.aborted || inFlight) return;
    cancelScheduled();
    inFlight = true;
    o.onState({ busy: true, waiting: null });
    const onRetry = (message: string) => {
      if (!abort.signal.aborted) o.onState({ busy: true, waiting: message });
    };
    void request(url, { signal: abort.signal, attempts, onRetry }).then((r) => {
      inFlight = false;
      if (abort.signal.aborted) return;
      o.onState({ busy: r.ok, waiting: null });
      o.onResult(r);
    });
  }

  return {
    start,
    schedule(url, ms, message, attempts) {
      if (abort.signal.aborted || inFlight || scheduled) return;
      scheduled = true;
      o.onState({ busy: true, waiting: message });
      timer = setTimer(() => {
        scheduled = false;
        start(url, attempts);
      }, ms);
    },
    dispose() {
      cancelScheduled();
      abort.abort();
    },
  };
}
