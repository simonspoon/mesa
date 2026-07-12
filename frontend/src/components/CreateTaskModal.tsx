import { useEffect } from "react";
import { CreateTaskPanel } from "./CreateTaskPanel";

/**
 * Centered modal wrapper around `CreateTaskPanel`, matching CommandPalette's
 * overlay pattern: backdrop click and Escape both close it, a click inside
 * the box does not.
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

  return (
    <div className="create-task-backdrop" onClick={onClose}>
      <div className="create-task-modal" onClick={(e) => e.stopPropagation()}>
        <CreateTaskPanel
          projectId={projectId}
          onClose={onClose}
          onCreated={onCreated}
        />
      </div>
    </div>
  );
}
