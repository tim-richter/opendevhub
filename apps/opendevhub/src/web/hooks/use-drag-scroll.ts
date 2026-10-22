import { useCallback } from "react";

/** How far the mouse travels before a press becomes a drag; anything shorter stays a click. */
const DRAG_THRESHOLD_PX = 6;

/** How far ahead a release projects the drag's speed, so a flick carries past the nearest column. */
const MOMENTUM_MS = 200;

/** Only the last moments of a drag count towards its release speed. */
const VELOCITY_WINDOW_MS = 80;

/** Re-enables snapping if a glide never reports `scrollend`. */
const GLIDE_FALLBACK_MS = 800;

/** Presses on these keep their own behaviour instead of panning. */
const INTERACTIVE = "input, textarea, select, button, [contenteditable]";

interface Gesture {
  pointerId: number;
  x: number;
  y: number;
  left: number;
  top: number;
  /** The vertically scrolling element under the press, panned along with the container. */
  inner?: HTMLElement;
  dragging: boolean;
  /** Recent pointer positions, for the speed at release. */
  samples: { t: number; x: number }[];
}

const scrollsVertically = (element: HTMLElement) => {
  const { overflowY } = getComputedStyle(element);
  return (
    (overflowY === "auto" || overflowY === "scroll") &&
    element.scrollHeight > element.clientHeight
  );
};

const innerScroller = (target: Element, container: HTMLElement) => {
  for (
    let element = target instanceof HTMLElement ? target : target.parentElement;
    element && element !== container;
    element = element.parentElement
  ) {
    if (scrollsVertically(element)) {
      return element;
    }
  }
};

/** A press on a scrollbar lands on the scrolling element itself, outside its client box. */
const onScrollbar = (event: PointerEvent, target: Element) =>
  target instanceof HTMLElement &&
  (event.offsetX >= target.clientWidth || event.offsetY >= target.clientHeight);

const clampScroll = (container: HTMLElement, left: number) =>
  Math.min(Math.max(left, 0), container.scrollWidth - container.clientWidth);

/** Horizontal speed in px/ms over the last moments of the drag. */
const releaseVelocity = (samples: Gesture["samples"]) => {
  const last = samples.at(-1);
  const first = samples.find(
    (sample) => last && last.t - sample.t <= VELOCITY_WINDOW_MS
  );
  if (!first || !last || last.t === first.t) {
    return 0;
  }
  return (last.x - first.x) / (last.t - first.t);
};

/** The child snap position, in scroll coordinates, closest to `left`. */
const nearestSnap = (container: HTMLElement, left: number) => {
  // Computed lengths come back in px, e.g. "4px"; "auto" counts as none.
  const padding =
    Number(getComputedStyle(container).scrollPaddingLeft.replace("px", "")) ||
    0;
  const origin = container.getBoundingClientRect().left - container.scrollLeft;
  let best = left;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const child of container.children) {
    const position = child.getBoundingClientRect().left - origin - padding;
    const distance = Math.abs(position - left);
    if (distance < bestDistance) {
      best = position;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * Lets the mouse pan a scrolling container by dragging it, like grabbing a canvas.
 * Moving it vertically also scrolls the inner list the press started on.
 * A press only becomes a drag past a small threshold, and the click that ends a drag is swallowed,
 * so links and buttons inside keep working. Touch and pen already scroll natively and are left alone.
 * On release it glides on with the drag's speed and, if the container snaps, settles on the nearest snap point.
 * The container gets `data-dragging` while a drag is in progress.
 */
export const useDragScroll = <T extends HTMLElement>() =>
  useCallback((container: T | null) => {
    if (!container) {
      return;
    }
    let gesture: Gesture | undefined;
    let swallowClick = false;
    let snap = "";
    let snaps = false;
    let glideTimer: ReturnType<typeof setTimeout> | undefined;
    let glideTarget = 0;

    const restoreSnap = () => {
      clearTimeout(glideTimer);
      glideTimer = undefined;
      container.removeEventListener("scrollend", onScrollEnd);
      if (!gesture?.dragging) {
        container.style.scrollSnapType = snap;
      }
    };

    // The drag's own scrolling also ends with a `scrollend`, which can arrive once the glide has begun.
    const onScrollEnd = () => {
      if (Math.abs(container.scrollLeft - glideTarget) < 1) {
        restoreSnap();
      }
    };

    // Snapping stays off while the board glides, so the browser doesn't jump ahead of it.
    const glide = (velocity: number) => {
      const projected = clampScroll(
        container,
        container.scrollLeft - velocity * MOMENTUM_MS
      );
      const left = clampScroll(
        container,
        snaps ? nearestSnap(container, projected) : projected
      );
      if (Math.abs(left - container.scrollLeft) < 1) {
        restoreSnap();
        return;
      }
      const reduceMotion = matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      glideTarget = left;
      container.addEventListener("scrollend", onScrollEnd);
      glideTimer = setTimeout(restoreSnap, GLIDE_FALLBACK_MS);
      container.scrollTo({
        behavior: reduceMotion ? "instant" : "smooth",
        left,
      });
    };

    const end = (event: PointerEvent) => {
      if (event.pointerId !== gesture?.pointerId) {
        return;
      }
      if (gesture.dragging) {
        swallowClick = true;
        // The click, if any, follows in this same task; drop the flag after it.
        setTimeout(() => {
          swallowClick = false;
        }, 0);
        container.releasePointerCapture(event.pointerId);
        delete container.dataset.dragging;
        const velocity = releaseVelocity(gesture.samples);
        gesture = undefined;
        glide(velocity);
        return;
      }
      gesture = undefined;
    };

    const onPointerDown = (event: PointerEvent) => {
      const { target } = event;
      const modified =
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
      if (
        event.pointerType !== "mouse" ||
        event.button !== 0 ||
        modified ||
        !(target instanceof Element) ||
        target.closest(INTERACTIVE) ||
        onScrollbar(event, target)
      ) {
        return;
      }
      const inner = innerScroller(target, container);
      gesture = {
        dragging: false,
        inner,
        left: container.scrollLeft,
        pointerId: event.pointerId,
        samples: [{ t: event.timeStamp, x: event.clientX }],
        top: inner?.scrollTop ?? 0,
        x: event.clientX,
        y: event.clientY,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== gesture?.pointerId) {
        return;
      }
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!gesture.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
          return;
        }
        gesture.dragging = true;
        container.setPointerCapture(event.pointerId);
        // Snapping would fight every scroll step; the release glide settles on a column instead.
        if (glideTimer === undefined) {
          snap = container.style.scrollSnapType;
          snaps = getComputedStyle(container).scrollSnapType !== "none";
        } else {
          // Grabbed mid-glide: snapping is still off, so keep what was saved before.
          clearTimeout(glideTimer);
          glideTimer = undefined;
          container.removeEventListener("scrollend", onScrollEnd);
        }
        container.style.scrollSnapType = "none";
        container.dataset.dragging = "";
      }
      gesture.samples.push({ t: event.timeStamp, x: event.clientX });
      if (gesture.samples.length > 20) {
        gesture.samples.shift();
      }
      // Undo any text selection the press began before it turned into a drag.
      getSelection()?.removeAllRanges();
      container.scrollLeft = gesture.left - dx;
      if (gesture.inner) {
        gesture.inner.scrollTop = gesture.top - dy;
      }
    };

    const onClick = (event: MouseEvent) => {
      if (swallowClick) {
        swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
      }
    };

    // A link would otherwise start a native drag-and-drop and cancel the pan.
    const onDragStart = (event: DragEvent) => {
      if (gesture) {
        event.preventDefault();
      }
    };

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", end);
    container.addEventListener("pointercancel", end);
    container.addEventListener("click", onClick, true);
    container.addEventListener("dragstart", onDragStart);
    return () => {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", end);
      container.removeEventListener("pointercancel", end);
      container.removeEventListener("click", onClick, true);
      container.removeEventListener("dragstart", onDragStart);
      container.removeEventListener("scrollend", onScrollEnd);
      clearTimeout(glideTimer);
    };
  }, []);
