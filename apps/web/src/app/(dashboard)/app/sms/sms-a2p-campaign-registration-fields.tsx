// SPDX-License-Identifier: AGPL-3.0-only

import type { Dispatch, SetStateAction } from "react";
import { RefreshCw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SmsCampaignRegistrationDraft } from "./sms-registration-drafts";

export type A2PGeneratableField =
  | "description"
  | "message_flow"
  | "message_samples";

interface SmsA2pCampaignRegistrationFieldsProps {
  campaignRegistration: SmsCampaignRegistrationDraft;
  pending: string | null;
  setCampaignRegistration: Dispatch<
    SetStateAction<SmsCampaignRegistrationDraft>
  >;
  onGenerateField: (field: A2PGeneratableField) => void | Promise<void>;
  onPollRegistration: () => void | Promise<void>;
  onSubmitCampaignRegistration: () => void | Promise<void>;
}

export function SmsA2pCampaignRegistrationFields({
  campaignRegistration,
  pending,
  setCampaignRegistration,
  onGenerateField,
  onPollRegistration,
  onSubmitCampaignRegistration,
}: SmsA2pCampaignRegistrationFieldsProps) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <CampaignTextInput
          id="a2p_usecase"
          label="Use case"
          value={campaignRegistration.usecase}
          field="usecase"
          setCampaignRegistration={setCampaignRegistration}
        />
        <CampaignTextInput
          id="a2p_vertical"
          label="Vertical"
          value={campaignRegistration.vertical}
          field="vertical"
          setCampaignRegistration={setCampaignRegistration}
        />
      </div>
      <CampaignTextarea
        id="a2p_description"
        label="Campaign description"
        rows={2}
        value={campaignRegistration.description}
        field="description"
        setCampaignRegistration={setCampaignRegistration}
        aiField="description"
        pending={pending}
        onGenerateField={onGenerateField}
      />
      <CampaignTextarea
        id="a2p_message_flow"
        label="Opt-in message flow"
        rows={2}
        value={campaignRegistration.message_flow}
        field="message_flow"
        setCampaignRegistration={setCampaignRegistration}
        aiField="message_flow"
        pending={pending}
        onGenerateField={onGenerateField}
      />
      <CampaignTextarea
        id="a2p_message_samples"
        label="Message samples"
        rows={3}
        placeholder="One sample per line"
        value={campaignRegistration.message_samples}
        field="message_samples"
        setCampaignRegistration={setCampaignRegistration}
        aiField="message_samples"
        pending={pending}
        onGenerateField={onGenerateField}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <CampaignTextInput
          id="a2p_terms"
          label="Terms URL"
          value={campaignRegistration.terms_and_conditions_link}
          field="terms_and_conditions_link"
          setCampaignRegistration={setCampaignRegistration}
        />
        <CampaignTextInput
          id="a2p_privacy"
          label="Privacy URL"
          value={campaignRegistration.privacy_policy_link}
          field="privacy_policy_link"
          setCampaignRegistration={setCampaignRegistration}
        />
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <CampaignCheckbox
          label="Opt-in required"
          checked={campaignRegistration.subscriber_opt_in}
          field="subscriber_opt_in"
          setCampaignRegistration={setCampaignRegistration}
        />
        <CampaignCheckbox
          label="Uses links"
          checked={campaignRegistration.has_embedded_links}
          field="has_embedded_links"
          setCampaignRegistration={setCampaignRegistration}
        />
        <CampaignCheckbox
          label="Uses phone numbers"
          checked={campaignRegistration.has_embedded_phone}
          field="has_embedded_phone"
          setCampaignRegistration={setCampaignRegistration}
        />
        <CampaignCheckbox
          label="Number pool"
          checked={campaignRegistration.number_pool}
          field="number_pool"
          setCampaignRegistration={setCampaignRegistration}
        />
        <CampaignCheckbox
          label="Affiliate marketing"
          checked={campaignRegistration.affiliate_marketing}
          field="affiliate_marketing"
          setCampaignRegistration={setCampaignRegistration}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void onSubmitCampaignRegistration()}
          disabled={pending === "campaign-registration"}
        >
          Submit Campaign
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void onPollRegistration()}
          disabled={pending === "registration-poll"}
        >
          Poll Status
        </Button>
      </div>
    </div>
  );
}

function CampaignTextInput({
  field,
  id,
  label,
  setCampaignRegistration,
  value,
}: {
  field: keyof SmsCampaignRegistrationDraft;
  id: string;
  label: string;
  setCampaignRegistration: Dispatch<
    SetStateAction<SmsCampaignRegistrationDraft>
  >;
  value: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) =>
          setCampaignRegistration((current) => ({
            ...current,
            [field]: e.target.value,
          }))
        }
      />
    </div>
  );
}

function CampaignTextarea({
  field,
  id,
  label,
  placeholder,
  rows,
  setCampaignRegistration,
  value,
  aiField,
  pending,
  onGenerateField,
}: {
  field: keyof SmsCampaignRegistrationDraft;
  id: string;
  label: string;
  placeholder?: string;
  rows: number;
  setCampaignRegistration: Dispatch<
    SetStateAction<SmsCampaignRegistrationDraft>
  >;
  value: string;
  aiField: A2PGeneratableField;
  pending: string | null;
  onGenerateField: (field: A2PGeneratableField) => void | Promise<void>;
}) {
  const busy = pending === `a2p-ai:${aiField}`;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          onClick={() => void onGenerateField(aiField)}
          disabled={pending !== null}
        >
          {busy ? (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          )}
          Draft with AI
        </Button>
      </div>
      <Textarea
        id={id}
        value={value}
        onChange={(e) =>
          setCampaignRegistration((current) => ({
            ...current,
            [field]: e.target.value,
          }))
        }
        rows={rows}
        placeholder={placeholder}
      />
    </div>
  );
}

function CampaignCheckbox({
  checked,
  field,
  label,
  setCampaignRegistration,
}: {
  checked: boolean;
  field: keyof SmsCampaignRegistrationDraft;
  label: string;
  setCampaignRegistration: Dispatch<
    SetStateAction<SmsCampaignRegistrationDraft>
  >;
}) {
  return (
    <label className="flex items-center gap-2">
      <Checkbox
        checked={checked}
        onChange={(e) =>
          setCampaignRegistration((current) => ({
            ...current,
            [field]: e.target.checked,
          }))
        }
      />
      {label}
    </label>
  );
}
