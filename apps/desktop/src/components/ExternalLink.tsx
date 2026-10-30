import type {
  AnchorHTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";

import { safeOpenExternalUrl, tauriApi } from "../lib/tauri";

interface ExternalLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "target" | "rel"
> {
  href: string;
  onOpenError?: (error: Error) => void;
}

/**
 * One external-intent boundary for renderer links. The anchor keeps native
 * link semantics (copy address, context menu), while activation is routed
 * through the same scheme/credential validator as programmatic opens.
 */
export function ExternalLink({
  href,
  onClick,
  onOpenError,
  children,
  ...rest
}: ExternalLinkProps): ReactElement {
  const safe = safeOpenExternalUrl(href);
  const activate = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (!safe) {
      onOpenError?.(new Error("Refused to open an unsafe external URL"));
      return;
    }
    void tauriApi.openUrl(safe).catch((error: unknown) => {
      onOpenError?.(
        error instanceof Error
          ? error
          : new Error("Could not open the external URL"),
      );
    });
  };

  return (
    <a
      {...rest}
      href={safe ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      aria-disabled={safe ? rest["aria-disabled"] : true}
      onClick={activate}
    >
      {children}
    </a>
  );
}
