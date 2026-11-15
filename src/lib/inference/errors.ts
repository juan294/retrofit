/**
 * The ledger, hold or quota store could not be read or written, or a
 * compare-and-set did not settle within its retry bound. The proxy answers 503
 * with UNAVAILABLE_MESSAGE and forwards nothing (no forwarding without a reservation).
 */
export class CountersUnavailable extends Error {
  constructor(message = "inference counters unavailable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CountersUnavailable";
  }
}

/** The placeholder key the runtime sends on the free path; the credential is the session cookie. Client-safe (no node imports). */
export const FREE_PLACEHOLDER_KEY = "retrofit-free";

/** Visitor text for the overrun hold (parent plan, stuck state "overrun hold"). */
export const HOLD_MESSAGE = "Retrofit's free AI is paused. Use your own key.";

/** Visitor text when the counters are unavailable (parent plan, stuck state "Inference counters unavailable"). */
export const UNAVAILABLE_MESSAGE = "Retrofit's free AI is not available right now. Use your own key.";

/** Runs a store operation and turns any failure into CountersUnavailable. */
export async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CountersUnavailable) throw error;
    throw new CountersUnavailable(`inference counters unavailable (${what})`, { cause: error });
  }
}
