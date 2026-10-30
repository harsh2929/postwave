// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { LockKeyhole, TicketPercent } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Coupon-pool inventory and issuance are deliberately absent from
 * discounts.MountRoutes. Keep this saved-link destination useful and truthful
 * without probing endpoints that cannot succeed or presenting demo-only data
 * as production inventory.
 */
export default function CouponPoolDetailPage() {
  return (
    <PageShell className="max-w-4xl">
      <Breadcrumb
        className="[&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:items-center [&_a]:justify-center sm:[&_a]:min-h-0 sm:[&_a]:min-w-0"
        items={[
          { label: "Discount history", href: "/app/discounts" },
          { label: "Coupon pool" },
        ]}
      />

      <header className="max-w-2xl">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <TicketPercent className="h-4 w-4" aria-hidden />
            Coupon pools
          </div>
          <Badge variant="secondary">Release-held</Badge>
        </div>
        <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight md:text-3xl">
          Coupon pools are release-held
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          This saved route cannot load pool inventory because coupon-pool read,
          import, assignment, and status-change endpoints are not mounted in the
          production API.
        </p>
      </header>

      <Card role="status" className="overflow-hidden border-primary/20">
        <CardHeader className="bg-primary/[0.035]">
          <CardTitle as="h2" className="flex items-center gap-2">
            <LockKeyhole className="h-5 w-5 text-primary" aria-hidden />
            No inventory or issuance is being simulated
          </CardTitle>
          <CardDescription>
            A missing API response is not an empty pool and must not be shown as
            one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 pt-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <section
              className="rounded-lg border p-4"
              aria-labelledby="pool-held"
            >
              <h2 id="pool-held" className="text-sm font-semibold">
                Held operations
              </h2>
              <ul className="mt-2 space-y-1.5 text-sm leading-6 text-muted-foreground">
                <li>Pool inventory and code counts</li>
                <li>Code imports and manual assignments</li>
                <li>Pool status changes and issuance</li>
              </ul>
            </section>
            <section
              className="rounded-lg border p-4"
              aria-labelledby="discount-archive"
            >
              <h2 id="discount-archive" className="text-sm font-semibold">
                Available historical archive
              </h2>
              <ul className="mt-2 space-y-1.5 text-sm leading-6 text-muted-foreground">
                <li>Sanitized record labels and stored rule snapshots</li>
                <li>Stored redemption counters and PII-free event timing</li>
                <li>No redeemable codes, subscriber identity, or live state</li>
              </ul>
            </section>
          </div>
          <Button asChild variant="outline" className="min-h-11 sm:min-h-9">
            <Link href="/app/discounts">Back to discount history</Link>
          </Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}
