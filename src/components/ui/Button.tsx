import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

interface Look {
  /** primary: ink fill. accent: accent fill under ink text. quiet: white fill. */
  readonly tone?: "primary" | "accent" | "quiet";
  /** The condensed display face, for the main action of a page. */
  readonly display?: boolean;
  /** Moves up and left on hover, with a hard shadow. */
  readonly lift?: boolean;
}

const look = ({ tone = "primary", display, lift }: Look, className?: string) =>
  cx("fi-btn", tone === "accent" && "fi-btn-accent", tone === "quiet" && "fi-btn-quiet", display && "fi-btn-display", lift && "fi-lift", className);

/** A button. Every other attribute passes through, so ids, aria attributes and `{...buttonState()}` keep working. */
export function Button({ tone, display, lift, className, type = "button", ...rest }: Look & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={look({ tone, display, lift }, className)} {...rest} />;
}

/** A link with the look of a button. A plain anchor: no client prefetch, as in the navigation. */
export function ButtonLink({ tone, display, lift, className, children, ...rest }: Look & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={look({ tone, display, lift }, className)} {...rest}>
      {children}
    </a>
  );
}
