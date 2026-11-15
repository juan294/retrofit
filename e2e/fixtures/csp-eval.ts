export interface CspViolation {
  directive: string;
  blockedURI: string;
}

export interface CspEvaluation {
  unexpected: CspViolation[];
  missing: CspViolation[];
  strayConsole: string[];
}

const key = (v: CspViolation) => `${v.directive} ${v.blockedURI}`;

/**
 * Compares observed violations with the exact expected list. Directive and
 * blocked URI must be equal. Repeated reports of one violation count once,
 * because browsers may report a blocked resource more than once. Every CSP
 * console message must name an expected blocked URI.
 */
export function evaluateCsp(seen: CspViolation[], expected: CspViolation[], consoleCsp: string[]): CspEvaluation {
  for (const e of expected) {
    if (!e.directive || !e.blockedURI) throw new Error("expectCspViolations needs a directive and an exact blockedURI");
  }
  const want = new Set(expected.map(key));
  const got = new Map(seen.map((v) => [key(v), v]));
  return {
    unexpected: [...got.values()].filter((v) => !want.has(key(v))),
    missing: expected.filter((e) => !got.has(key(e))),
    strayConsole: consoleCsp.filter((t) => !expected.some((e) => t.includes(e.blockedURI))),
  };
}
