"use client";

import { useLayoutEffect, useRef, type FocusEvent } from "react";

/** True when the focused element went away and nothing else has the focus now. */
export const lostFocus = (last: { readonly isConnected: boolean } | null, active: unknown, body: unknown): boolean => last !== null && !last.isConnected && (active === null || active === body);

/**
 * Keeps the keyboard position when a section removes the focused element (a removed claim, Publish that
 * becomes Refresh): the focus goes to the element with tabIndex -1 that is first in the same list item, or
 * to the section's heading when the item is gone too. A focus that is elsewhere on the page never moves.
 */
export function useFocusFallback() {
  const heading = useRef<HTMLHeadingElement>(null);
  const last = useRef<{ readonly element: Element; readonly item: Element | null } | null>(null);
  // After every render: any of them can remove the element.
  useLayoutEffect(() => {
    const at = last.current;
    if (!at || !lostFocus(at.element, document.activeElement, document.body)) return;
    last.current = null;
    const inItem = at.item?.isConnected ? at.item.querySelector<HTMLElement>('[tabindex="-1"]') : null;
    (inItem ?? heading.current)?.focus();
  });
  const section = {
    onFocus: (e: FocusEvent) => {
      last.current = { element: e.target, item: e.target.closest("li") };
    },
    onBlur: (e: FocusEvent) => {
      // Another window has the focus: the element keeps its place in this one.
      if (document.activeElement !== e.target) last.current = null;
    },
  };
  return { heading, section };
}
