/**
 * LibraryDropZone — page-wide drag-and-drop overlay.
 *
 * Listens at the window level for `dragenter`/`dragover`/`dragleave`/
 * `drop` events. When the user drags files into the window, a full-page
 * overlay appears; dropping calls `onFiles(files)`.
 *
 * dragleave is fiddly because it fires on every child element transition.
 * We track a counter of dragenter calls and only hide the overlay when the
 * matching dragleave brings the counter back to 0.
 */

import { type ReactElement, useEffect, useState } from "react";

interface Props {
  /** Disabled while the user can't upload (viewer role, etc). */
  enabled: boolean;
  onFiles: (files: File[]) => void;
}

export function LibraryDropZone({ enabled, onFiles }: Props): ReactElement | null {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let counter = 0;

    const hasFiles = (e: DragEvent): boolean => {
      const dt = e.dataTransfer;
      if (!dt) return false;
      if (dt.types && Array.from(dt.types).includes("Files")) return true;
      return false;
    };

    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      counter += 1;
      setActive(true);
    };
    const onOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      counter -= 1;
      if (counter <= 0) {
        counter = 0;
        setActive(false);
      }
    };
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      counter = 0;
      setActive(false);
      const list = e.dataTransfer?.files;
      if (!list || list.length === 0) return;
      const files: File[] = [];
      for (let i = 0; i < list.length; i++) {
        const f = list.item(i);
        if (f) files.push(f);
      }
      if (files.length > 0) onFiles(files);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [enabled, onFiles]);

  if (!active || !enabled) return null;
  return (
    <div className="lib-dropzone-overlay" role="presentation">
      <div className="lib-dropzone-card">Drop to upload</div>
    </div>
  );
}
