// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { Check, Copy, HelpCircle, Wrench } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { copyToClipboard } from "@/lib/clipboard";
import {
  AUTH_PROTOCOL_INFO,
  type ProtocolInfo,
} from "@/lib/inbox-reality-helpers";
import type { AuthRecord, AuthStatus } from "@/lib/inbox-reality-types";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";

export type AuthProtocol = keyof typeof AUTH_PROTOCOL_INFO;

export interface AuthRowProps {
  label: string;
  record: AuthRecord;
  /** Sending domain — used to build a copyable recommended DNS record. */
  domain?: string;
}

const STATUS_GLYPH: Record<AuthStatus, string> = {
  ok: "✓",
  warn: "⚠",
  fail: "✗",
};

// Screen-reader-only status word so pass/warn/fail is never color+glyph only.
const STATUS_WORD: Record<AuthStatus, string> = {
  ok: "Passing",
  warn: "Warning",
  fail: "Failing",
};

const STATUS_VARIANT: Record<
  AuthStatus,
  "success" | "warning" | "destructive"
> = {
  ok: "success",
  warn: "warning",
  fail: "destructive",
};

function isKnownProtocol(label: string): label is AuthProtocol {
  return label in AUTH_PROTOCOL_INFO;
}

/**
 * A recommended DNS record for the protocols whose remediation is a DNS change
 * (DMARC enforcement, BIMI publication). Returns null for protocols whose fix
 * is not a single copyable record (SPF/DKIM/PTR depend on provider config).
 */
function recommendedRecord(
  protocol: AuthProtocol,
  domain: string,
): { type: string; name: string; value: string } | null {
  const d = domain || "yourdomain.example";
  if (protocol === "DMARC") {
    return {
      type: "TXT",
      name: `_dmarc.${d}`,
      value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${d}; pct=100`,
    };
  }
  if (protocol === "BIMI") {
    return {
      type: "TXT",
      name: `default._bimi.${d}`,
      value: `v=BIMI1; l=https://${d}/bimi-logo.svg;`,
    };
  }
  return null;
}

function ProtocolHelp({ label, info }: { label: string; info: ProtocolInfo }) {
  return (
    <Tooltip label={`${info.title} — ${info.what} ${info.why}`}>
      <a
        href={info.learnMore}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-11 w-11 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8"
        aria-label={`Learn more about ${label}: ${info.what}`}
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
      </a>
    </Tooltip>
  );
}

function CopyRecordButton({
  record,
}: {
  record: { type: string; name: string; value: string };
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const text = `${record.type} ${record.name} ${record.value}`;
    const result = await copyToClipboard(text);
    if (result === "copied") {
      setCopied(true);
      toast.success("Recommended DNS record copied");
      setTimeout(() => setCopied(false), 1600);
    } else {
      toast.error(
        result === "unavailable"
          ? "Clipboard unavailable — copy the record manually."
          : "Could not copy the record.",
      );
    }
  };
  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      className="inline-flex min-h-11 items-center gap-1 rounded border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8 sm:px-2 sm:text-[11px]"
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
      {copied ? "Copied" : "Copy record"}
    </button>
  );
}

export function AuthRow({ label, record, domain = "" }: AuthRowProps) {
  const needsFix = record.status === "warn" || record.status === "fail";
  const info = isKnownProtocol(label) ? AUTH_PROTOCOL_INFO[label] : null;
  const dnsRecord =
    needsFix && isKnownProtocol(label)
      ? recommendedRecord(label, domain)
      : null;

  return (
    <div className="flex flex-col gap-1 py-2 border-b last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <div className="flex items-center gap-1.5 min-w-[96px]">
        <Badge variant={STATUS_VARIANT[record.status]}>
          <span className="mr-1" aria-hidden>
            {STATUS_GLYPH[record.status]}
          </span>
          {label}
          <span className="sr-only">, {STATUS_WORD[record.status]}</span>
        </Badge>
        {info ? <ProtocolHelp label={label} info={info} /> : null}
      </div>
      <div className="flex-1 space-y-1.5 sm:text-right">
        <p className="text-xs text-muted-foreground">{record.detail}</p>
        {dnsRecord ? (
          <pre
            tabIndex={0}
            role="group"
            aria-label="Recommended DNS record"
            className="overflow-x-auto rounded bg-muted p-2 text-left font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {dnsRecord.type} {dnsRecord.name} → {dnsRecord.value}
          </pre>
        ) : null}
        {needsFix ? (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {dnsRecord ? <CopyRecordButton record={dnsRecord} /> : null}
            <Link
              href={asRoute("/app/settings/domain")}
              className={cn(
                "inline-flex min-h-11 items-center gap-1 rounded border px-3 text-xs font-medium sm:min-h-8 sm:px-2 sm:text-[11px]",
                "text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <Wrench className="h-3 w-3" aria-hidden />
              Fix in Settings
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
