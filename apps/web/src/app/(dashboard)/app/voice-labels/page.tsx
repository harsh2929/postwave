// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";

import { ServiceNotDeployedNotice } from "@/components/service-not-deployed-notice";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import {
  effectiveAuthRole,
  whoami,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";

import { LabelForm } from "./_label-form";
import { LabelsList } from "./_labels-list";

const ADMIN_ROLES: ReadonlySet<AuthRole> = new Set(["owner", "admin"]);

/**
 * Operator UI for /v1/voice/labels.
 *
 * Layout: left half = submission form, right half = recent labels.
 *
 * Gated to owner|admin at the route level. The backend independently
 * enforces admin-only on DELETE + /export.json — this guard just keeps
 * the page out of the navigation for non-admins (we still trust the
 * server, never the client, for authority).
 */
export default function VoiceLabelsPage(): JSX.Element {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accessAttempt, setAccessAttempt] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  // A labels read or save answered 503 service_not_deployed: this environment
  // doesn't run voice labeling. The whole page says so once, and the form and
  // list switch their actions off instead of offering a retry.
  const [notDeployed, setNotDeployed] = useState(false);
  const notDeployedId = useId();
  const markNotDeployed = useCallback(() => setNotDeployed(true), []);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoadError(null);
    void whoami()
      .then((res) => {
        if (active) {
          setMe(res);
          setLoadError(null);
          setLoaded(true);
        }
      })
      .catch((err) => {
        if (!active) return;
        // 401/403 — the dashboard layout will redirect on its own
        // render-cycle; we just stop trying.
        if (
          err instanceof ApiError &&
          (err.status === 401 || err.status === 403)
        ) {
          setMe(null);
          setLoaded(true);
          return;
        }
        setLoadError("Could not verify your access to voice labels.");
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [accessAttempt]);

  if (!loaded) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8">
        <header>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Voice labels
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Loading…</p>
        </header>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8">
        <header>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Voice labels
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Train the in-house voice scoring model by labeling writing samples.
          </p>
        </header>
        <Card role="alert">
          <CardHeader>
            <CardTitle>Access check failed</CardTitle>
            <CardDescription>{loadError}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setAccessAttempt((value) => value + 1)}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Viewer mode downgrades an owner to viewer server-side, so the held role
  // (me.role) still reads "owner" while every POST/DELETE on
  // /api/v1/voice/labels is refused. Gate on the effective role, or the
  // form renders and each save 403s on all five axes.
  const viewerMode = me?.viewer_mode === true;
  const effectiveRole = me ? effectiveAuthRole(me) : null;
  const isAdmin =
    effectiveRole !== null && !viewerMode && ADMIN_ROLES.has(effectiveRole);

  if (!isAdmin) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8">
        <header>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Voice labels
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Train the in-house voice scoring model by labeling writing samples.
          </p>
        </header>
        <Card>
          <CardHeader>
            <CardTitle>
              {viewerMode
                ? "Voice labeling is paused in viewer mode"
                : "Voice labeling is admin-only"}
            </CardTitle>
            <CardDescription>
              {viewerMode
                ? "This session is acting in viewer mode, so submitting, deleting and exporting labels are all refused. Leave viewer mode from the account menu to label samples again."
                : "Submitting and managing labels requires an owner or admin role. If you need access, ask your workspace owner to upgrade your role from Team settings."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/app">Back to dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Voice labels
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Label writing samples on five voice axes. The calibration trainer
          consumes the export feed nightly.
        </p>
      </header>

      {notDeployed ? (
        <ServiceNotDeployedNotice
          id={notDeployedId}
          title="Voice labeling isn't set up in this environment"
        >
          Samples can&apos;t be labeled, listed or exported here, so the form
          and export are switched off.
        </ServiceNotDeployedNotice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Submit a label</CardTitle>
            <CardDescription>
              Paste a sample and rate it on every axis from 0.00 to 1.00.
              Submitting records one row per axis.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LabelForm
              onSubmitted={() => setRefreshToken((n) => n + 1)}
              notDeployed={notDeployed}
              notDeployedId={notDeployedId}
              onServiceNotDeployed={markNotDeployed}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent labels</CardTitle>
            <CardDescription>
              Filter by axis. Delete and export are admin-gated on the server.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LabelsList
              refreshToken={refreshToken}
              notDeployed={notDeployed}
              notDeployedId={notDeployedId}
              onServiceNotDeployed={markNotDeployed}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
