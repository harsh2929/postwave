import { useState, type ReactElement } from "react";

/** Mask a local secret by default and require an accessible reveal action. */
export function SecureDraftInput({
  value,
  onChange,
  placeholder,
  accessibleName,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  accessibleName: string;
  disabled?: boolean;
}): ReactElement {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input
        type={show ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        autoComplete="new-password"
        aria-label={accessibleName}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        style={{ paddingRight: 64 }}
      />
      <button
        type="button"
        onClick={() => setShow((visible) => !visible)}
        className="link-button"
        disabled={disabled}
        style={{
          position: "absolute",
          right: 8,
          top: "50%",
          transform: "translateY(-50%)",
          fontSize: 12,
        }}
        aria-label={`${show ? "Hide" : "Show"} ${accessibleName}`}
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}
