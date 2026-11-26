import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

interface NoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "role"> {
  /** action: the visitor must do something (accent header). info: nothing to do (ink header). */
  readonly tone: "action" | "info";
  /** The header text. Without it the header names the tone. */
  readonly title?: ReactNode;
  /**
   * `status` or `alert` for the body. It goes on the body, never on the wrapper: a role on the wrapper would
   * announce the header again on every change of the text.
   */
  readonly role?: "status" | "alert";
}

/** One pattern for errors, waits and confirmations. Other attributes (id, data-testid) go on the body with the role. */
export function Notice({ tone, title, role, className, children, ...rest }: NoticeProps) {
  return (
    <div className={cx("fi-notice", tone === "action" && "fi-notice-action", className)}>
      <div className="fi-notice-head fi-mono">{title ?? (tone === "action" ? "Action needed" : "Note")}</div>
      <div className="fi-notice-body" role={role} {...rest}>
        {children}
      </div>
    </div>
  );
}
