// SPDX-License-Identifier: AGPL-3.0-only
//
// "Request an integration" affordance for missing/planned providers (INTG-049).
// There is no backend demand-signal endpoint, so this is honest about what it
// does: it opens a prefilled email to the product team rather than pretending
// to persist an in-app upvote. The dialog explains that and offers the mailto
// CTA (plus a copyable address for environments where mailto: is unavailable).
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyTextButton } from "@/components/copy-text-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const REQUEST_ADDRESS = "integrations@moosewave.com";
const MAX_PROVIDER_LENGTH = 120;

export function integrationRequestMailto(rawProvider: string): string | null {
  const provider = rawProvider.trim();
  if (!provider || provider.length > MAX_PROVIDER_LENGTH) return null;
  const subject = encodeURIComponent(`Integration request: ${provider}`);
  const body = encodeURIComponent(
    `Provider: ${provider}\nUse case: \nApproximate monthly volume: `,
  );
  return `mailto:${REQUEST_ADDRESS}?subject=${subject}&body=${body}`;
}

export function RequestIntegrationButton({
  defaultProvider = "",
}: {
  defaultProvider?: string;
}) {
  const providerId = useId();
  const providerHintId = useId();
  const providerErrorId = useId();
  const providerRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(defaultProvider);
  const [providerTouched, setProviderTouched] = useState(false);

  useEffect(() => {
    if (!open) {
      setProvider(defaultProvider);
      setProviderTouched(false);
    }
  }, [defaultProvider, open]);

  const providerName = provider.trim();
  const providerError = !providerName
    ? "Enter a provider name."
    : providerName.length > MAX_PROVIDER_LENGTH
      ? `Provider name must be ${MAX_PROVIDER_LENGTH} characters or fewer.`
      : null;
  const mailto = integrationRequestMailto(provider);

  const onCompose = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    if (!mailto) {
      event.preventDefault();
      setProviderTouched(true);
      providerRef.current?.focus();
      return;
    }
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-8"
        >
          <Sparkles className="mr-1.5 h-4 w-4" />
          Request an integration
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-w-md [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Request an integration</DialogTitle>
          <DialogDescription>
            Tell us what you need and we&apos;ll weigh it against the roadmap.
            This opens a prefilled email — we don&apos;t store requests in-app
            yet.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={providerId}>Provider name</Label>
          <Input
            ref={providerRef}
            id={providerId}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            onBlur={() => setProviderTouched(true)}
            onInvalid={() => setProviderTouched(true)}
            aria-invalid={providerTouched && providerError ? true : undefined}
            aria-describedby={
              providerTouched && providerError
                ? providerErrorId
                : providerHintId
            }
            placeholder="e.g. Acme CRM"
            maxLength={MAX_PROVIDER_LENGTH}
            required
          />
          {providerTouched && providerError ? (
            <p
              id={providerErrorId}
              role="alert"
              className="text-xs text-destructive"
            >
              {providerError}
            </p>
          ) : (
            <p id={providerHintId} className="text-xs text-muted-foreground">
              Enter the provider or service you want Moosewave to connect.
            </p>
          )}
        </div>
        <div className="min-w-0 rounded-md border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground">Request address</p>
          <p className="break-all text-sm font-medium">{REQUEST_ADDRESS}</p>
        </div>
        <DialogFooter className="sm:justify-between">
          <CopyTextButton
            value={REQUEST_ADDRESS}
            label="Copy address"
            copiedLabel="Address copied"
            className="min-h-11"
          />
          <Button asChild className="min-h-11">
            <a href={mailto ?? `#${providerId}`} onClick={onCompose}>
              Compose email
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
