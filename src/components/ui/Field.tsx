import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";
import { cx } from "./cx";

/** A text field. The caller supplies the label (`htmlFor`) and every attribute of the input. */
export function Field({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("fi-field", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("fi-select", className)} {...rest}>
      {children}
    </select>
  );
}
