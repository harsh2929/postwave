import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import { acceptDroppedFiles, pickImportFiles } from "../../lib/file-transfer";
import type { ImportPolicy } from "../../lib/file-transfer-types";

interface MigrationFileFieldInputProps {
  id: string;
  label: string;
  required: boolean;
  help?: string;
  file: File | null;
  policy: ImportPolicy;
  maxBytes: number;
  onChange: (file: File | null) => void;
}

export function MigrationFileFieldInput({
  id,
  label,
  required,
  help,
  file,
  policy,
  maxBytes,
  onChange,
}: MigrationFileFieldInputProps): ReactElement {
  const [fileError, setFileError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const mountedRef = useRef(true);
  const errorId = useId();
  const helpId = useId();
  const busyId = useId();
  const picker = useSingleFlightOperation({
    ownerId: `migration-file-picker-${id}`,
    label: "Choose migration file",
    detail:
      "Finish or dismiss the migration file picker before leaving Moosewave.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const chooseFile = (next: File | null): void => {
    setFileError("");
    if (!next) {
      onChange(null);
      return;
    }
    const validationError = migrationFileValidationError(
      next,
      maxBytes,
      policy.extensions,
    );
    if (validationError) {
      onChange(null);
      setFileError(validationError);
      return;
    }
    onChange(next);
  };

  const openPicker = (): void => {
    const flight = picker.run(async () => {
      const picked = await pickImportFiles(policy);
      if (!mountedRef.current) return;
      if (!picked.ok) {
        onChange(null);
        setFileError(picked.message);
        return;
      }
      chooseFile(picked.files[0] ?? null);
    });
    if (!flight) return;
    void flight.catch(() => {
      if (mountedRef.current) {
        setFileError(
          "The file picker could not be completed. No file was selected; retry when ready.",
        );
      }
    });
  };

  const describedBy = [
    help ? helpId : null,
    fileError ? errorId : null,
    picker.active ? busyId : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {required ? " *" : ""}
      </label>
      <div
        className={`wizard-file-drop ${dragOver ? "is-over" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDragEnd={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          try {
            const picked = acceptDroppedFiles(event.dataTransfer.files, policy);
            if (!picked.ok) {
              onChange(null);
              setFileError(picked.message);
            } else chooseFile(picked.files[0] ?? null);
          } catch {
            setFileError(
              "The dropped file could not be inspected. No file was selected.",
            );
          }
        }}
      >
        <button
          id={id}
          type="button"
          className="wizard-file-input"
          aria-label={
            file
              ? `Change ${label}. Selected file: ${file.name}`
              : `Choose ${label}`
          }
          aria-disabled={picker.active || undefined}
          aria-busy={picker.active || undefined}
          aria-describedby={describedBy || undefined}
          onClick={() => {
            if (!picker.active) openPicker();
          }}
        />
        <div className="wizard-file-prompt" aria-hidden="true">
          {file ? (
            <>
              <strong>{file.name}</strong>
              <span className="muted">
                {" "}
                · {(file.size / 1024).toFixed(1)} KB
              </span>
            </>
          ) : policy.extensions.includes("zip") ? (
            "Drop an official Substack ZIP or subscriber CSV here, or click to browse"
          ) : (
            "Drop a CSV here, or click to browse"
          )}
        </div>
      </div>
      {help ? (
        <div id={helpId} className="field-help">
          {help}
        </div>
      ) : null}
      {fileError ? (
        <div id={errorId} className="field-error" role="alert">
          {fileError}
        </div>
      ) : null}
      {picker.active ? (
        <div id={busyId} className="migration-action-reason" role="status">
          The native file picker is already open.
        </div>
      ) : null}
    </div>
  );
}

export function migrationFileValidationError(
  file: Pick<File, "name" | "type" | "size">,
  maxBytes: number,
  allowedExtensions: readonly string[] = ["csv"],
): string | null {
  const lowerName = file.name.toLowerCase();
  const normalizedExtensions = allowedExtensions.map((extension) =>
    extension.toLowerCase().replace(/^\./, ""),
  );
  const isAllowedByExt = normalizedExtensions.some((extension) =>
    lowerName.endsWith(`.${extension}`),
  );
  const allowedMimes = [
    "text/csv",
    "application/vnd.ms-excel",
    "application/csv",
    "text/comma-separated-values",
    ...(normalizedExtensions.includes("zip")
      ? ["application/zip", "application/x-zip-compressed"]
      : []),
  ];
  if (!isAllowedByExt && !allowedMimes.includes(file.type)) {
    const formats = normalizedExtensions.map((extension) => `.${extension}`);
    return `Only ${formats.join(" or ")} files are supported. The selected file has an unsupported format.`;
  }
  if (file.size === 0) {
    return "The selected migration file is empty. Choose a non-empty export.";
  }
  if (file.size > maxBytes) {
    return "Migration uploads must be 200 MB or smaller.";
  }
  return null;
}
