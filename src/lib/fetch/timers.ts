/** Timers shared by pacing, count-once waits and claim checks. */

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const TIMED_OUT: unique symbol = Symbol("timed out");

/**
 * `task`'s result, or TIMED_OUT when it has not settled after `ms`. With `sleep` (an injected clock's
 * wait), the timeout is that sleep; otherwise a timer that never keeps the process alive and is
 * cleared when the task settles first. A task that rejects after the timeout is ignored.
 */
export async function beforeDeadline<T>(task: Promise<T>, ms: number, sleep?: (ms: number) => Promise<void>): Promise<T | typeof TIMED_OUT> {
  task.catch(() => {});
  if (sleep) return Promise.race([task, sleep(ms).then((): typeof TIMED_OUT => TIMED_OUT)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
