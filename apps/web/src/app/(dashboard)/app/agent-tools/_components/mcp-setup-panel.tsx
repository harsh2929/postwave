// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Plug, ShieldAlert } from "lucide-react";

import { GovernanceSection } from "@/components/governance/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_STATUS_COPY,
} from "@/lib/mcp-release-status";

/**
 * An honest parity surface for desktop's MCP setup area.
 *
 * The package manifests are private and the deployment/protocol boundary is
 * not qualified, so generating a command or accepting an API key here would
 * turn repository source into a works-now claim. Keep the destination visible,
 * but make the hold—and the absence of any credential transfer—unambiguous.
 */
export function McpSetupPanel() {
  return (
    <GovernanceSection
      icon={Plug}
      title="MCP client setup"
      description="Client configuration remains unavailable while the MCP distribution boundary is release-held."
    >
      <Alert variant="warning">
        <ShieldAlert aria-hidden="true" />
        <AlertTitle>Distribution is release-held</AlertTitle>
        <AlertDescription>
          <code>{MCP_RELEASE_HOLD_CODE}</code>. {MCP_RELEASE_STATUS_COPY}
        </AlertDescription>
      </Alert>

      <div
        className="mt-3 min-w-0 rounded-xl border bg-muted/20 p-3.5"
        role="note"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">No runnable setup is emitted</p>
          <Badge variant="outline">Source review only</Badge>
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          This page does not generate commands or configuration files, write to
          the clipboard, or accept an API key. Do not paste a credential here.
          Setup can be enabled only after an immutable package, supported
          transports, deployment ownership, and tenant-isolated authentication
          have all been qualified together.
        </p>
      </div>
    </GovernanceSection>
  );
}
