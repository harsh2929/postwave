// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Check, Minus } from "lucide-react";
import { toast } from "sonner";

import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  effectiveAuthRole,
  sendVerificationEmail,
  whoami,
  type AuthRole,
} from "@/lib/auth-api";
import { canReadAdminData } from "@/lib/admin-read-authority";
import { qk, STALE } from "@/lib/query-keys";
import { TeamRoster } from "./team-roster";

// The audit-scope matrix sits below the roster and brings its own roles API,
// mutation and confirmation, so it loads after first paint and keeps the
// route's initial JavaScript inside the bundle budget. The fallback is the
// matrix's own loading card.
const RoleScopeMatrix = dynamic(
  () => import("./role-scope-matrix").then((module) => module.RoleScopeMatrix),
  {
    loading: () => (
      <Card>
        <CardHeader>
          <CardTitle>Audit-scope access</CardTitle>
          <CardDescription>Loading role matrix…</CardDescription>
        </CardHeader>
      </Card>
    ),
  },
);

const ROLES: Array<{ value: AuthRole; label: string; description: string }> = [
  {
    value: "owner",
    label: "Owner",
    description: "Full access, billing, and workspace control.",
  },
  {
    value: "admin",
    label: "Admin",
    description: "Full workspace write and administration access.",
  },
  {
    value: "editor",
    label: "Editor",
    description: "Read-only under the current session scope policy.",
  },
  {
    value: "viewer",
    label: "Viewer",
    description: "Read-only access across the workspace.",
  },
];

const PERMISSIONS = [
  {
    capability: "View workspace data",
    owner: true,
    admin: true,
    editor: true,
    viewer: true,
  },
  {
    capability: "Send campaigns",
    owner: true,
    admin: true,
    editor: false,
    viewer: false,
  },
  {
    capability: "Edit subscribers",
    owner: true,
    admin: true,
    editor: false,
    viewer: false,
  },
  {
    capability: "Manage automations",
    owner: true,
    admin: true,
    editor: false,
    viewer: false,
  },
  {
    capability: "Manage team and billing",
    owner: true,
    admin: true,
    editor: false,
    viewer: false,
  },
  {
    capability: "Manage API keys",
    owner: true,
    admin: true,
    editor: false,
    viewer: false,
  },
];

export default function TeamSettingsPage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const me = meQuery.data ?? null;
  const tenantId = me?.tenant_id ?? "anon";
  const role = me?.viewer_mode ? "viewer" : me ? effectiveAuthRole(me) : null;
  const canAdmin = Boolean(meQuery.isSuccess && canReadAdminData(me));
  const error =
    meQuery.error instanceof Error
      ? meQuery.error.message
      : meQuery.error
        ? "Could not load team."
        : null;

  return (
    <div className="space-y-6 [&_button]:min-h-11 [&_button]:min-w-11 sm:[&_button]:min-h-0 sm:[&_button]:min-w-0">
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            {/* The full workspace roster lives in <TeamRoster/> below; this
                card stays focused on the current session's own identity +
                verification state. */}
            <CardTitle>Your membership</CardTitle>
            <CardDescription>
              Your authenticated workspace user and role status.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div
            role="region"
            aria-label="Team members"
            tabIndex={0}
            className="border rounded-md overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th scope="col" className="text-left px-3 py-2 font-medium">
                    Email
                  </th>
                  <th scope="col" className="text-left px-3 py-2 font-medium">
                    Role
                  </th>
                  <th scope="col" className="text-left px-3 py-2 font-medium">
                    Workspace
                  </th>
                  <th scope="col" className="text-right px-3 py-2 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {me ? (
                  <tr className="border-t">
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                      {me.email}
                    </td>
                    <td className="px-3 py-2 capitalize whitespace-nowrap">
                      {labelForRole(me.role)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {me.workspace_name}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        <Badge
                          variant={me.email_verified ? "success" : "warning"}
                        >
                          {me.email_verified ? "Verified" : "Email pending"}
                        </Badge>
                        {!me.email_verified ? <ResendVerification /> : null}
                      </div>
                    </td>
                  </tr>
                ) : (
                  // Distinguish error vs loading: once whoami() fails, `me`
                  // stays null forever, so don't keep showing a spinner that
                  // never resolves — show an error row that matches the banner.
                  <tr className="border-t">
                    <td
                      colSpan={4}
                      className="px-3 py-6 text-center text-muted-foreground"
                    >
                      {error
                        ? "Could not load your membership."
                        : "Loading team..."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* SETC-010: live roster + copy-link invitations, backed by
          /api/v1/workspace/members + /api/v1/workspace/invites. */}
      <TeamRoster
        key={`${tenantId}:${me?.user_id ?? "anon"}:${role ?? "none"}:${me?.viewer_mode ? "viewer" : "durable"}`}
        canWrite={canAdmin}
        callerCanOwner={role === "owner"}
        tenantId={tenantId}
        role={role}
        identityReady={meQuery.isSuccess && Boolean(me)}
        identity={me}
      />

      <RoleScopeMatrix
        canWrite={canAdmin}
        identityLoading={meQuery.isLoading}
        identityReady={meQuery.isSuccess && Boolean(me)}
        role={role}
        tenantId={tenantId}
        userId={me?.user_id ?? "anon"}
        viewerMode={Boolean(me?.viewer_mode)}
        identity={me}
      />

      <Card>
        <CardHeader>
          <CardTitle>Permission matrix</CardTitle>
          <CardDescription>
            Built-in role capabilities for this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            role="region"
            aria-label="Permission matrix"
            tabIndex={0}
            className="border rounded-md overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th scope="col" className="text-left px-3 py-2 font-medium">
                    Capability
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Owner
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Admin
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Editor
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Viewer
                  </th>
                </tr>
              </thead>
              <tbody>
                {PERMISSIONS.map((p) => (
                  <tr key={p.capability} className="border-t">
                    <td className="px-3 py-2">{p.capability}</td>
                    <td className="px-3 py-2 text-center">
                      <PermissionCell allowed={p.owner} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <PermissionCell allowed={p.admin} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <PermissionCell allowed={p.editor} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <PermissionCell allowed={p.viewer} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Surface the previously-dead ROLES.description copy as a legend so
              each built-in role's scope is explained, not just shown as a grid. */}
          <dl className="mt-4 space-y-2">
            {ROLES.map((role) => (
              <div
                key={role.value}
                className="flex flex-col gap-0.5 text-sm sm:flex-row sm:gap-2"
              >
                <dt className="font-medium">{role.label}</dt>
                <dd className="text-muted-foreground">{role.description}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function PermissionCell({ allowed }: { allowed: boolean }) {
  return allowed ? (
    <span className="inline-flex text-success" title="Allowed">
      <Check className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">Allowed</span>
    </span>
  ) : (
    <span className="inline-flex text-muted-foreground/50" title="Not allowed">
      <Minus className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">Not allowed</span>
    </span>
  );
}

function ResendVerification() {
  const [sending, setSending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [, setTick] = useState(0);
  const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  const onCooldown = remaining > 0;

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    // Stop the ticker when the window closes. `cooldownUntil` does not change
    // as time passes, so the effect never re-runs on its own — without this the
    // interval kept re-rendering once a second for as long as the page stayed
    // open, long after the countdown had finished.
    const id = setInterval(() => {
      setTick((t) => t + 1);
      if (Date.now() >= cooldownUntil) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  async function resend() {
    if (sending || onCooldown) return;
    setSending(true);
    try {
      await sendVerificationEmail();
      toast.success("Verification email sent. Check your inbox.");
      setCooldownUntil(Date.now() + 60_000);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not resend verification.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={sending || onCooldown}
      onClick={() => void resend()}
    >
      {sending
        ? "Sending…"
        : onCooldown
          ? `Resend in ${remaining}s`
          : "Resend verification"}
    </Button>
  );
}

function labelForRole(role: AuthRole): string {
  return ROLES.find((item) => item.value === role)?.label ?? role;
}
