/**
 * The two pieces of imperative browser state the page genuinely needs: the
 * theme, and the Overview's measured scrollbar gutter.
 */
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
 * The theme in force, and a toggle that makes it explicit.
 *
 * Three states, matching the CSS: no stored choice falls through to
 * prefers-color-scheme, and clicking the toggle always sets an explicit choice
 * from then on, in either direction. The initial application happens in
 * index.html before React mounts - it has to run before first paint, which no
 * component can do.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => explicitTheme() ?? (osPrefersDark() ? "dark" : "light"));

  // Follow the OS while no explicit choice has been made.
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
 * The Overview's scroll region: its shadow hairline, and the gutter the pinned
 * tile row above it has to reserve.
 *
 * The Overview scrolls inside itself while the tiles stay put, so the tile row
 * sits outside the scrollbar and would be that much wider than the card below
 * it. `--sbw` is the difference, measured rather than assumed - a scrollbar is
 * ~15px on Windows, 0 on an overlay-scrollbar platform, and guessing gets it
 * wrong on one of them.
 *
 * **This is the bug fix.** The old page measured in render() and re-measured on
 * a window `resize` listener, which left a stale value on a layout that had
 * stopped using the region at all. Keying a ResizeObserver to the element being
 * measured means the measurement cannot outlive it: no region, no value.
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

  // The hairline is on only while there is content above the fold.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrolled(el.scrollTop > 0);
  }, []);

  return { scrollRef, scrolled, onScroll };
}

/**
 * A callback ref for a master/detail list: scrolls the selected row into view
 * when the list mounts.
 *
 * Mounting is the case that needs it - switching in from Grid, where the row was
 * picked by expanding it and can be far down a list that would otherwise open at
 * the top, beside a detail pane showing a row you can't see. Module-level, so its
 * identity never changes and React doesn't call it again on a re-render:
 * selecting a row must leave the list where it is.
 */
export function revealSelectedRow(list: HTMLElement | null): void {
  list?.querySelector<HTMLElement>(".md-row.sel")?.scrollIntoView?.({ block: "nearest" });
}
