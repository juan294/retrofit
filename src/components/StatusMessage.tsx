import type { Status } from "./post";
import { Notice } from "./ui/Notice";

/**
 * The answer to an action, with the next step's link. The status region is always mounted, so a screen
 * reader announces the text when it appears (empty, it takes no space); a failure is an alert in a notice
 * beside it. `id` and `testId` are on the one of the two that shows the text; `className` is on its box.
 */
export function StatusMessage({ status, id, testId, className }: { status: Status | null; id?: string; testId?: string; className?: string }) {
  const failed = status !== null && !status.ok;
  const own = { id, "data-testid": testId };
  const body = status ? (
    <>
      {status.text}
      {status.href ? (
        <>
          {" "}
          <a href={status.href} className="underline">
            {status.linkText}
          </a>
        </>
      ) : null}
    </>
  ) : null;
  return (
    <>
      <p role="status" {...(failed ? {} : own)} className={className && !failed ? `empty:absolute ${className}` : "empty:absolute"}>
        {failed ? null : body}
      </p>
      {failed ? (
        <Notice tone="action" role="alert" className={className} {...own}>
          {body}
        </Notice>
      ) : null}
    </>
  );
}
