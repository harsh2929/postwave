// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import {
  ArrowLeft,
  BadgeCheck,
  CircleOff,
  Fingerprint,
  HandCoins,
  Handshake,
  LockKeyhole,
  ReceiptText,
  ShieldCheck,
} from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const READINESS_ITEMS = [
  {
    icon: LockKeyhole,
    title: "Authority boundary",
    description:
      "Platform-operator authorization and tenant isolation must be independently verified.",
  },
  {
    icon: Fingerprint,
    title: "Attribution integrity",
    description:
      "Consent, trusted-origin handling, anti-tamper controls, and reversal behavior need approval.",
  },
  {
    icon: ReceiptText,
    title: "Commission contract",
    description:
      "Rates, currency, eligibility, versioning, and immutable calculation evidence need sign-off.",
  },
  {
    icon: HandCoins,
    title: "Payout safety",
    description:
      "Approved-only settlement, idempotency, reconciliation, tax checks, and audit receipts are required.",
  },
] as const;

const CLOSED_SURFACES = [
  "Partner enrollment",
  "Record administration",
  "Conversion moderation",
  "Payout execution",
] as const;

export function AffiliateProgramUnavailable({
  embedded = false,
  title = "Affiliate operations are unavailable",
  description = "The affiliate service is not part of the production runtime. This workspace intentionally loads no partner records and exposes no commercial or financial actions.",
}: {
  embedded?: boolean;
  title?: string;
  description?: string;
}) {
  const content = (
    <>
      <header className="max-w-3xl space-y-3">
        <Badge variant="warning" className="gap-1.5">
          <CircleOff aria-hidden="true" className="h-3.5 w-3.5" />
          Fail-closed
        </Badge>
        <div className="space-y-2">
          <h1 className="break-words font-display text-2xl font-semibold tracking-tight md:text-3xl">
            {title}
          </h1>
          <p className="max-w-2xl break-words text-sm leading-6 text-muted-foreground md:text-base">
            {description}
          </p>
        </div>
      </header>

      <Card className="overflow-hidden border-primary/20">
        <CardHeader className="border-b bg-primary/[0.035]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 gap-3">
              <span className="mt-0.5 rounded-lg border border-primary/15 bg-background p-2 text-primary">
                <ShieldCheck aria-hidden="true" className="h-5 w-5" />
              </span>
              <div className="space-y-1">
                <CardTitle>Production qualification required</CardTitle>
                <CardDescription className="max-w-2xl leading-5">
                  Availability requires a reviewed commercial contract and
                  end-to-end evidence for access, attribution, money movement,
                  privacy, and recovery behavior.
                </CardDescription>
              </div>
            </div>
            <Badge variant="outline" className="shrink-0">
              No API access
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          {READINESS_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <section
                key={item.title}
                className="rounded-lg border bg-muted/20 p-4"
              >
                <div className="flex items-center gap-2">
                  <Icon
                    aria-hidden="true"
                    className="h-4 w-4 text-muted-foreground"
                  />
                  <h2 className="text-sm font-semibold">{item.title}</h2>
                </div>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  {item.description}
                </p>
              </section>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Handshake
              aria-hidden="true"
              className="h-5 w-5 text-muted-foreground"
            />
            <CardTitle>Current surface status</CardTitle>
          </div>
          <CardDescription>
            Every affiliate operation remains unavailable until the complete
            contract is mounted, tested, and approved.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul
            className="grid gap-2 sm:grid-cols-2"
            aria-label="Closed surfaces"
          >
            {CLOSED_SURFACES.map((surface) => (
              <li
                key={surface}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-sm"
              >
                <span>{surface}</span>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <BadgeCheck aria-hidden="true" className="h-3.5 w-3.5" />
                  Closed
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            Source code, retained schemas, or draft screens do not establish an
            active affiliate program, commission entitlement, or payout
            obligation.
          </p>
        </CardContent>
      </Card>

      {!embedded ? (
        <Button
          asChild
          variant="outline"
          className="min-h-11 w-fit gap-2 sm:min-h-9"
        >
          <Link href="/app">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Return to dashboard
          </Link>
        </Button>
      ) : null}
    </>
  );

  return embedded ? content : <PageShell>{content}</PageShell>;
}
