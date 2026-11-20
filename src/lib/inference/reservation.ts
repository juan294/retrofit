import type { FreeConfig } from "@/lib/config";
import type { ChatRequest } from "./schema";

/**
 * Reservation bound (phase 6, "Reservation bound"). Amounts are integer micro-USD.
 * A price in USD per million tokens equals micro-USD per token, so no unit
 * conversion is needed for tokens.
 *
 * Risk (stated by the plan): the bound assumes a byte-level tokenizer, so each
 * billed input token covers at least one byte of the serialized request. The
 * contract probe tests it; a reported usage above the bound triggers the hold.
 */

export interface Reservation {
  readonly inputTokenBound: number;
  readonly outputTokenBound: number;
  readonly microUsd: number;
}

const feeMicro = (free: FreeConfig): number => free.perRequestFeeUsd * 1_000_000;

/** Rounds up to a whole micro-USD. A tiny tolerance absorbs binary noise such as 0.1 * 3 = 0.30000000000000004. */
function ceilMicro(amount: number): number {
  return Math.ceil(amount - 1e-9);
}

export function reservationFor(body: ChatRequest, free: FreeConfig): Reservation {
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  const inputTokenBound = bytes + free.framingTokensPerMessage * body.messages.length + free.framingTokensBase;
  const outputTokenBound = free.maxTokens;
  const microUsd = ceilMicro(inputTokenBound * free.priceInPerM + outputTokenBound * free.priceOutPerM + feeMicro(free));
  return { inputTokenBound, outputTokenBound, microUsd };
}

/** Charge for the usage the provider reported, priced like the reservation. */
export function usageCharge(usage: { promptTokens: number; completionTokens: number }, free: FreeConfig): number {
  return ceilMicro(usage.promptTokens * free.priceInPerM + usage.completionTokens * free.priceOutPerM + feeMicro(free));
}
