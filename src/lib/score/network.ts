// Validates a declared agent network with the organizers' own runtime code, so a
// network that passes here is one their browser runtime accepts (engine.js `_compile`:
// parseHocon, new AgentNetwork, validateNetwork). The vendored files are imported
// as they are and never edited; `pnpm vendor:verify` checks them.

import { parseHocon } from "../../../tools/agentic-web/runtime/hocon.js";
import { AgentNetwork, validateNetwork } from "../../../tools/agentic-web/runtime/kernel.js";

export type NetworkValidation = { kind: "unparsable" } | { kind: "invalid"; errors: number } | { kind: "valid" };

/** Parse a network file (HOCON or JSON) and run the runtime's validateNetwork. Never throws. */
export function validateNetworkText(text: string, name: string): NetworkValidation {
  let config: unknown;
  try {
    config = parseHocon(text);
  } catch {
    return { kind: "unparsable" };
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) return { kind: "unparsable" };
  try {
    const result = validateNetwork(new AgentNetwork(config, name)) as { errors?: unknown };
    const errors = Array.isArray(result.errors) ? result.errors.length : 1;
    return errors === 0 ? { kind: "valid" } : { kind: "invalid", errors };
  } catch {
    // The runtime's validators assume a well-formed shape (for example `tools` as an array).
    return { kind: "invalid", errors: 1 };
  }
}
