import { useEffect, useRef, useState } from "react";
import { dragOffset, type Offset } from "../modalDrag";
import { CreateTaskPanel } from "./CreateTaskPanel";

/**
 * Centered modal wrapper around `CreateTaskPanel`, matching CommandPalette's
 * overlay pattern: backdrop click and Escape both close it, a click inside
 * the box does not.
 *
 * Two things set it apart from the other modals sharing these classes (mesa
 * task 811), both because this is the one modal you fill in *while reading
 * something else*:
 *
 * - Its backdrop dims less (`create-task-backdrop-soft`), so the view it was
 *   opened over stays readable. The base class stays on the element — it is
 *   what `shouldIgnoreShortcut()` matches to suppress the global single-key
 *   shortcuts (docs/keyboard.md), so the modifier is additive, never a
 *   replacement.
 * - It can be dragged out of the way by its head bar. The box is still
 *   flex-centred by the backdrop and displaced with a `transform`, so nothing
 *   about the existing sizing, the phone-tier full-bleed sheet or the `--cut`
 *   styling changes; `modalDrag.ts` owns the clamp that keeps it on screen.
 */
export function CreateTaskModal({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  // Non-render state of an in-flight drag: where the box sat and where the
  // pointer was when it started. A ref, not state — it changes on every
  // pointermove and nothing renders off it.
  const drag = useRef<{ origin: Offset; from: Offset } | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The head bar is the title bar: `CreateTaskPanel` renders it (with the ✕),
  // and matching it here rather than owning a bar of its own keeps the panel's
  // markup untouched. The ✕ inside it is excluded — a click that closes the
  // modal must not first start a drag.
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target?.closest(".panel-head") || target.closest("button")) return;
    e.preventDefault();
    drag.current = {
      origin: offset,
      from: { x: e.clientX, y: e.clientY },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const box = boxRef.current;
    if (!state || !box) return;
    const rect = box.getBoundingClientRect();
    setOffset(
      dragOffset(
        state.origin,
        { x: e.clientX - state.from.x, y: e.clientY - state.from.y },
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (drag.current === null) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  return (
    <div
      className="create-task-backdrop create-task-backdrop-soft"
      onClick={onClose}
    >
      <div
        ref={boxRef}
        className="create-task-modal create-task-modal-movable"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <CreateTaskPanel
          projectId={projectId}
          onClose={onClose}
          onCreated={onCreated}
        />
      </div>
    </div>
  );
}
