import { useCallback, useEffect, useRef, useState } from "react";

export type Theme = "light" | "dark";

function osPrefersDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function explicitTheme(): Theme | null {
  const v = document.documentElement.getAttribute("data-theme");
  return v === "light" || v === "dark" ? v : null;
}

/**
 * Three states, matching the CSS: with no explicit choice the theme follows
 * prefers-color-scheme; the toggle always sets an explicit one. A stored choice
 * is first applied in index.html.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => explicitTheme() ?? (osPrefersDark() ? "dark" : "light"));

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => {
      if (!explicitTheme()) setTheme(mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = (explicitTheme() ?? (osPrefersDark() ? "dark" : "light")) === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("bjs.theme", next);
    } catch {
      /* not remembered; not fatal */
    }
    setTheme(next);
  }, []);

  return [theme, toggle];
}

/**
 * The Overview scroll region's hairline, and the `--sbw` gutter the pinned tile
 * row reserves so it lines up with the cards scrolling below it. Measured, not
 * assumed: a scrollbar is ~15px on Windows and 0 where scrollbars overlay.
 *
 * A ResizeObserver on the region itself, so the value can't outlive it.
 */
export function usePinnedLayout(active: boolean) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!active || !el) {
      // The layout branch that does not use the region must not leave a width
      // behind for one that later does.
      document.documentElement.style.removeProperty("--sbw");
      setScrolled(false);
      return;
    }

    const measure = () => {
      document.documentElement.style.setProperty("--sbw", `${el.offsetWidth - el.clientWidth}px`);
    };
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--sbw");
    };
  }, [active]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrolled(el.scrollTop > 0);
  }, []);

  return { scrollRef, scrolled, onScroll };
}

/**
 * A callback ref that scrolls a master/detail list's selected row into view on
 * mount, for a row picked in Grid far down the list. Module-level, so its
 * identity never changes and React doesn't re-run it: selecting a row must leave
 * the list where it is.
 */
export function revealSelectedRow(list: HTMLElement | null): void {
  list?.querySelector<HTMLElement>(".md-row.sel")?.scrollIntoView?.({ block: "nearest" });
}
