import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/** A bordered sheet. `raised` adds the hard shadow. */
export function Panel({ raised, className, ...rest }: { raised?: boolean } & HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("fi-panel", raised && "fi-panel-raised", className)} {...rest} />;
}

/** A small upper-case label in the mono face. Not a heading. */
export function MonoLabel({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("fi-mono", className)} {...rest} />;
}

/** The hazard stripe: decoration, hidden from assistive technology. */
export function Stripe({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cx("fi-stripe", className)} {...rest} />;
}

/** The round inspection stamp. The caller gives it text and, when it is decoration, `aria-hidden`. */
export function Stamp({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("fi-stamp", className)} {...rest} />;
}

/** A block of code or of a value to copy, on the ink. */
export function CodeBlock({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <code className={cx("fi-code", className)} {...rest} />;
}
