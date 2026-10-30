// SPDX-License-Identifier: AGPL-3.0-only

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { MessageSquareText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { SmsSenderProfile } from "@/lib/sms-api";
import {
  isValidIanaTimeZone,
  senderServicePlaceholder,
  SMS_TIMEZONES,
} from "./page-helpers";
import {
  senderRegistrationEvidenceLocked,
  type SmsSenderDraft,
} from "./sms-registration-drafts";

interface SmsSenderProfileFormProps {
  pending: string | null;
  sender: SmsSenderDraft;
  setSender: Dispatch<SetStateAction<SmsSenderDraft>>;
  onSubmitSender: (event: FormEvent<HTMLFormElement>) => void;
}

export function SmsSenderProfileForm({
  pending,
  sender,
  setSender,
  onSubmitSender,
}: SmsSenderProfileFormProps) {
  const timezoneValid =
    !sender.quiet_hours_enabled ||
    isValidIanaTimeZone(sender.quiet_hours_timezone);
  const timezoneOptions = SMS_TIMEZONES.includes(sender.quiet_hours_timezone)
    ? SMS_TIMEZONES
    : [sender.quiet_hours_timezone, ...SMS_TIMEZONES];
  const registrationEvidenceLocked = senderRegistrationEvidenceLocked(sender);
  const registrationStatusControlId = registrationEvidenceLocked
    ? "registration_status_evidence"
    : "registration_status";

  return (
    <form className="space-y-3" onSubmit={onSubmitSender}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="sender_provider">Provider</Label>
          <Select
            id="sender_provider"
            value={sender.provider}
            onChange={(e) =>
              setSender((current) => ({
                ...current,
                provider: e.target.value as SmsSenderProfile["provider"],
              }))
            }
          >
            <option value="twilio">Twilio</option>
            <option value="telnyx">Telnyx</option>
            <option value="bandwidth">Bandwidth</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="sender_country">Country</Label>
          <Select
            id="sender_country"
            value={sender.country}
            onChange={(e) =>
              setSender((current) => ({
                ...current,
                country: e.target.value as SmsSenderProfile["country"],
              }))
            }
          >
            <option value="US">US</option>
            <option value="CA">Canada</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="sender_type">Type</Label>
          <Select
            id="sender_type"
            value={sender.sender_type}
            onChange={(e) =>
              setSender((current) => ({
                ...current,
                sender_type: e.target.value as SmsSenderProfile["sender_type"],
              }))
            }
          >
            <option value="10dlc">10DLC</option>
            <option value="toll_free">Toll-free</option>
            <option value="short_code">Short code</option>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="phone_number">Phone number</Label>
        <Input
          id="phone_number"
          placeholder="+14155551212"
          value={sender.phone_number}
          onChange={(e) =>
            setSender((current) => ({
              ...current,
              phone_number: e.target.value,
            }))
          }
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="messaging_service_sid">
          Service/Profile/Application ID
        </Label>
        <Input
          id="messaging_service_sid"
          placeholder={senderServicePlaceholder(sender.provider)}
          value={sender.messaging_service_sid}
          onChange={(e) =>
            setSender((current) => ({
              ...current,
              messaging_service_sid: e.target.value,
            }))
          }
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={registrationStatusControlId}>Registration status</Label>
        {registrationEvidenceLocked ? (
          <p
            id={registrationStatusControlId}
            role="status"
            className="rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis"
          >
            Stored carrier evidence is read-only and is not presented as
            provider-certified here. Profile saving is held to avoid clearing or
            rewriting it ({" "}
            <code className="[overflow-wrap:anywhere]">
              sms_registration_evidence_authority_required
            </code>
            ).
          </p>
        ) : (
          <Select
            id={registrationStatusControlId}
            value={sender.registration_status || "not_started"}
            onChange={(e) =>
              setSender((current) => ({
                ...current,
                registration_status: e.target.value,
              }))
            }
          >
            <option value="not_started">Not started</option>
            <option value="draft">Draft (not carrier-approved)</option>
          </Select>
        )}
      </div>
      <div className="rounded-md border bg-muted/20 p-3">
        <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={sender.quiet_hours_enabled}
            onChange={(e) =>
              setSender((current) => ({
                ...current,
                quiet_hours_enabled: e.target.checked,
              }))
            }
          />
          Enforce quiet hours for this sender
        </label>
        {sender.quiet_hours_enabled ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="quiet_hours_timezone">Timezone</Label>
              <Select
                id="quiet_hours_timezone"
                value={sender.quiet_hours_timezone}
                aria-invalid={!timezoneValid}
                onChange={(e) =>
                  setSender((current) => ({
                    ...current,
                    quiet_hours_timezone: e.target.value,
                  }))
                }
              >
                {timezoneOptions.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
              {!timezoneValid ? (
                <p className="text-xs text-destructive">
                  “{sender.quiet_hours_timezone}” is not a valid IANA timezone —
                  quiet hours cannot be enforced until this is corrected.
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="quiet_hours_start">Start</Label>
              <Input
                id="quiet_hours_start"
                type="time"
                value={sender.quiet_hours_start}
                onChange={(e) =>
                  setSender((current) => ({
                    ...current,
                    quiet_hours_start: e.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quiet_hours_end">End</Label>
              <Input
                id="quiet_hours_end"
                type="time"
                value={sender.quiet_hours_end}
                onChange={(e) =>
                  setSender((current) => ({
                    ...current,
                    quiet_hours_end: e.target.value,
                  }))
                }
              />
            </div>
          </div>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          When an outbound path is available, its authoritative send gate also
          checks the configured local window.
        </p>
      </div>
      <Button
        type="submit"
        disabled={pending === "sender" || registrationEvidenceLocked}
      >
        <MessageSquareText className="mr-2 h-4 w-4" />
        Save sender
      </Button>
    </form>
  );
}
