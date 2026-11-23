import type { Status } from "./post";

/** The answer to an action: announced as a status, or as an alert in the danger color, with the next step's link. Nothing without one. */
export function StatusMessage({ status, testId, className }: { status: Status | null; testId?: string; className?: string }) {
  if (!status) return null;
  return (
    <p className={className} role={status.ok ? "status" : "alert"} data-testid={testId} style={status.ok ? undefined : { color: "var(--color-danger)" }}>
      {status.text}
      {status.href ? (
        <>
          {" "}
          <a href={status.href} className="underline">
            {status.linkText}
          </a>
        </>
      ) : null}
    </p>
  );
}
