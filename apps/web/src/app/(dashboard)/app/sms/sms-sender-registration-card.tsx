// SPDX-License-Identifier: AGPL-3.0-only

import type { Dispatch, FormEvent, SetStateAction } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { SmsSenderProfile } from "@/lib/sms-api";
import type { A2PGeneratableField } from "./sms-a2p-campaign-registration-fields";
import type {
  SmsBrandRegistrationDraft,
  SmsCampaignRegistrationDraft,
  SmsSenderDraft,
} from "./sms-registration-drafts";
import { SmsSenderProfileForm } from "./sms-sender-profile-form";

export type {
  SmsBrandRegistrationDraft,
  SmsCampaignRegistrationDraft,
  SmsSenderDraft,
} from "./sms-registration-drafts";

interface SmsSenderRegistrationCardProps {
  brandRegistration: SmsBrandRegistrationDraft;
  campaignRegistration: SmsCampaignRegistrationDraft;
  pending: string | null;
  registrationProvider: SmsSenderProfile["provider"];
  sender: SmsSenderDraft;
  senders: SmsSenderProfile[];
  selectedSenderId: string;
  setBrandRegistration: Dispatch<SetStateAction<SmsBrandRegistrationDraft>>;
  setCampaignRegistration: Dispatch<
    SetStateAction<SmsCampaignRegistrationDraft>
  >;
  setSender: Dispatch<SetStateAction<SmsSenderDraft>>;
  onSelectSender: (senderId: string) => void;
  onGenerateA2PField: (field: A2PGeneratableField) => void | Promise<void>;
  onPollRegistration: () => void | Promise<void>;
  onSubmitBrand: () => void | Promise<void>;
  onSubmitCampaignRegistration: () => void | Promise<void>;
  onSubmitSender: (event: FormEvent<HTMLFormElement>) => void;
}

export function SmsSenderRegistrationCard({
  pending,
  sender,
  senders,
  selectedSenderId,
  setSender,
  onSelectSender,
  onSubmitSender,
}: SmsSenderRegistrationCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">SMS Sender</CardTitle>
        <CardDescription>
          Edit non-authoritative sender metadata. Carrier registration evidence
          cannot be supplied or certified from this page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {senders.length > 1 ? (
          <div className="mb-4 space-y-2">
            <Label htmlFor="active_sender">Editing sender</Label>
            <Select
              id="active_sender"
              value={selectedSenderId}
              onChange={(e) => onSelectSender(e.target.value)}
            >
              {senders.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.phone_number || item.messaging_service_sid || item.id} ·{" "}
                  {item.registration_status === "not_started" ||
                  item.registration_status === "draft"
                    ? item.registration_status
                    : "registration evidence locked"}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <SmsSenderProfileForm
          pending={pending}
          sender={sender}
          setSender={setSender}
          onSubmitSender={onSubmitSender}
        />
        <div className="mt-6 space-y-4 border-t pt-4">
          <div>
            <div className="text-sm font-medium">
              A2P registration automation is release-held
            </div>
            <p className="text-xs text-muted-foreground">
              A2P carrier registration is unavailable until durable
              idempotency, reconciliation, and minimized provider receipts are
              deployed. No sender read, brand submission, campaign submission,
              or provider status polling request is started from this panel;
              sender profile editing above remains available. Release
              boundary:{" "}
              <code className="font-mono">
                sms_a2p_registration_release_held
              </code>
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
