/** Joins class names; empty and missing parts are left out. */
export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" ");
