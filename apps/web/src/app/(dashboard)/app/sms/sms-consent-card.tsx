// SPDX-License-Identifier: AGPL-3.0-only

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SmsList } from "@/lib/sms-api";
import { E164_PATTERN, listOptionLabel } from "./page-helpers";

export type SmsConsentAction = "revoked";

export interface SmsConsentDraft {
  list_id: string;
  phone_e164: string;
  proof_text: string;
  action: "revoked";
  source: "manual";
}

interface SmsConsentCardProps {
  draft: SmsConsentDraft;
  lists: SmsList[];
  pending: string | null;
  setDraft: Dispatch<SetStateAction<SmsConsentDraft>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
}

export function SmsConsentCard({
  draft,
  lists,
  pending,
  setDraft,
  onSubmit,
}: SmsConsentCardProps) {
  // A recorded opt-out is one-way from here: the card's own note says only a
  // verified inbound START/UNSTOP can restore carrier consent, and the parent
  // clears the phone field on success, so a single mistyped-but-valid E.164
  // number silently suppresses the wrong recipient with nothing left on screen
  // to identify them. The inverse, lesser action (removing a manual
  // suppression hold, sms-suppressions-card.tsx) already gates on typing the
  // number back, so this one echoes the number and gates the same way.
  // Snapshot the number at submit time: the parent clears the field on success,
  // so reading the live draft would blank the dialog's own echo mid-close.
  const [confirmPhone, setConfirmPhone] = useState<string | null>(null);
  const pendingSubmitRef = useRef<FormEvent<HTMLFormElement> | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Consent</CardTitle>
        <CardDescription>
          Record an operator opt-out for a US/Canada SMS recipient.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p
          role="note"
          className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
        >
          Manual/API opt-in, help, and bulk-import authority is unavailable.
          Only a verified inbound START or UNSTOP event may restore carrier
          consent; this form cannot make texting lawful.
        </p>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            // Native `required`/`pattern` validation has already passed by the
            // time this fires, so the number shown in the dialog is the exact
            // one that will be suppressed.
            event.preventDefault();
            pendingSubmitRef.current = event;
            setConfirmPhone(draft.phone_e164.trim());
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="consent_list">SMS list</Label>
            <Select
              id="consent_list"
              value={draft.list_id}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  list_id: e.target.value,
                }))
              }
              required
            >
              <option value="" disabled>
                Select list
              </option>
              {lists.map((item) => (
                <option key={item.id} value={item.id}>
                  {listOptionLabel(item)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="consent_phone">Phone</Label>
            <Input
              id="consent_phone"
              type="tel"
              inputMode="tel"
              pattern={E164_PATTERN}
              placeholder="+14155551212"
              value={draft.phone_e164}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  phone_e164: e.target.value,
                }))
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="proof_text">Operator revocation reason</Label>
            <Textarea
              id="proof_text"
              value={draft.proof_text}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  proof_text: e.target.value,
                }))
              }
              rows={3}
              maxLength={500}
              required
              placeholder="Why this recipient must be opted out"
            />
          </div>
          <Button
            ref={submitButtonRef}
            type="submit"
            variant="destructive"
            disabled={pending === "consent"}
          >
            Record opt-out
          </Button>
        </form>
      </CardContent>

      {confirmPhone !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setConfirmPhone(null);
              pendingSubmitRef.current = null;
            }
          }}
          title="Record an operator opt-out for this number?"
          description={`${confirmPhone} stops receiving SMS from this workspace. Only a verified inbound START or UNSTOP from that number can restore carrier consent — you cannot undo this from here, and the phone field is cleared once it is recorded.`}
          confirmLabel="Record opt-out"
          confirmationToken={confirmPhone}
          returnFocusRef={submitButtonRef}
          onConfirm={async () => {
            const submitted = pendingSubmitRef.current;
            if (!submitted) return;
            pendingSubmitRef.current = null;
            await onSubmit(submitted);
          }}
        />
      ) : null}
    </Card>
  );
}
