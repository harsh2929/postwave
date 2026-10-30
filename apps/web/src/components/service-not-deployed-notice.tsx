// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * The one way a surface says "this feature isn't set up in this environment".
 *
 * Shown when a read answers 503 service_not_deployed (lib/service-
 * availability.ts). That answer describes the deployment, not a failure, so
 * this is a neutral status, never a red error, and it deliberately has no
 * Retry: asking again cannot change which services an environment runs.
 *
 * Give it an `id` and point the aria-describedby of every disabled action
 * that needs the missing service at it, so the reason a control is off is
 * read with the control.
 *
 * No hooks and no "use client": server pages (Inbox Reality, Sequences) and
 * client pages render the same element.
 */
export function ServiceNotDeployedNotice({
  id,
  title,
  children,
  className,
}: {
  id?: string;
  /** "<Feature> isn't set up in this environment" — written from the reader's side. */
  title: ReactNode;
  /** What the reader can't do here, and what still works. No service names. */
  children: ReactNode;
  className?: string;
}) {
  return (
    <Alert
      id={id}
      role="status"
      data-state="service-not-deployed"
      className={className}
    >
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
