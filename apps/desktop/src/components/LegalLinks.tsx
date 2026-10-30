import { type ReactElement, useEffect, useRef, useState } from "react";

import { LEGAL_URLS, type LegalUrlKey } from "../lib/config";
import { tauriApi } from "../lib/tauri";
import { Icon } from "./Icon";

const DEFAULT_LINKS: readonly { key: LegalUrlKey; label: string }[] = [
  { key: "privacy", label: "Privacy" },
  { key: "terms", label: "Terms" },
  { key: "support", label: "Support" },
];

export function LegalLinks({
  links = DEFAULT_LINKS,
  align = "center",
}: {
  links?: readonly { key: LegalUrlKey; label: string }[];
  align?: "center" | "left" | "right";
}): ReactElement {
  const [openError, setOpenError] = useState("");
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  const openLink = async (key: LegalUrlKey): Promise<void> => {
    const requestId = ++requestRef.current;
    setOpenError("");
    try {
      await tauriApi.openUrl(LEGAL_URLS[key]);
    } catch {
      if (requestId !== requestRef.current) return;
      setOpenError(
        "Moosewave couldn't open your browser. Check your default-browser settings and try again.",
      );
    }
  };

  return (
    <div className="legal-links-group">
      <nav
        className={`legal-links legal-links-${align}`}
        aria-label="Legal and support"
      >
        {links.map((link) => (
          <button
            key={link.key}
            type="button"
            className="auth-link"
            aria-label={`${link.label} — opens in your default browser`}
            onClick={() => void openLink(link.key)}
          >
            {link.label}
            <Icon name="arrow-up-right" size={11} />
          </button>
        ))}
      </nav>
      {openError ? (
        <p className="legal-links-error" role="alert">
          {openError}
        </p>
      ) : null}
    </div>
  );
}
