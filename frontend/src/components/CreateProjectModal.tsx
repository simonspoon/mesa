import { useEffect } from "react";
import { createPortal } from "react-dom";
import { CreateProjectPanel } from "./CreateProjectPanel";

/**
 * Centered modal wrapper around `CreateProjectPanel`, matching
 * `CreateTaskModal`'s overlay pattern: backdrop click and Escape both close
 * it, a click inside the box does not. Unlike `CreateTaskModal` (mounted as
 * a page-level sibling), this one is opened from inside `Sidebar`'s `<nav>`,
 * which is `position: sticky` and therefore its own stacking context — a
 * nested `position: fixed` modal would paint underneath the main content
 * regardless of z-index. Portaling into `document.body` sidesteps that.
 */
export function CreateProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
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

  return createPortal(
    <div className="create-task-backdrop" onClick={onClose}>
      <div className="create-task-modal" onClick={(e) => e.stopPropagation()}>
        <CreateProjectPanel onClose={onClose} onCreated={onCreated} />
      </div>
    </div>,
    document.body,
  );
}
