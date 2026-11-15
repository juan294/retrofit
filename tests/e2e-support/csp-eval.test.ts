import { describe, expect, it } from "vitest";
import { evaluateCsp } from "../../e2e/fixtures/csp-eval";

const img = { directive: "img-src", blockedURI: "http://a.fixture.test:3013/x.png" };

describe("evaluateCsp", () => {
  // Fails if matching goes back to prefixes: a second URL on the same origin must be unexpected.
  it("requires exact blocked URIs", () => {
    const other = { directive: "img-src", blockedURI: "http://a.fixture.test:3013/y.png" };
    const r = evaluateCsp([img, other], [img], []);
    expect(r.unexpected).toEqual([other]);
    expect(r.missing).toEqual([]);
  });

  it("reports a missing expected violation", () => {
    expect(evaluateCsp([], [img], []).missing).toEqual([img]);
  });

  it("matches the directive too", () => {
    const r = evaluateCsp([{ ...img, directive: "connect-src" }], [img], []);
    expect(r.unexpected).toHaveLength(1);
    expect(r.missing).toHaveLength(1);
  });

  // Fails if console CSP errors are ignored when an event was also seen.
  it("flags console CSP errors that match no expectation, even with expected events", () => {
    const r = evaluateCsp([img], [img], ["Refused to connect to 'http://b.fixture.test/' because it violates ...", `Refused to load the image '${img.blockedURI}'`]);
    expect(r.strayConsole).toHaveLength(1);
  });

  it("refuses an empty or missing blocked URI in an expectation", () => {
    expect(() => evaluateCsp([], [{ directive: "img-src", blockedURI: "" }], [])).toThrow();
  });

  it("counts repeated reports of one violation once", () => {
    expect(evaluateCsp([img, img], [img], [])).toEqual({ unexpected: [], missing: [], strayConsole: [] });
  });
});
