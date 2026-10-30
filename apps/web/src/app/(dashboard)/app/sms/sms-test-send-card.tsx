// SPDX-License-Identifier: AGPL-3.0-only

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  SmsCreditPreview,
  SmsList,
  SmsSenderProfile,
} from "@/lib/sms-api";
import { E164_PATTERN, listOptionLabel, SMS_BODY_MAX } from "./page-helpers";
import { SmsCharCount } from "./sms-char-count";

export interface SmsTestSendDraft {
  sender_profile_id: string;
  list_id: string;
  to: string;
  body: string;
  media_url: string;
}

interface SmsTestSendCardProps {
  activeSender: SmsSenderProfile | undefined;
  creditPreview: SmsCreditPreview | null;
  credits: number;
  draft: SmsTestSendDraft;
  dispatchAvailable: boolean;
  dispatchUnavailableReason?: string;
  lists: SmsList[];
  pending: string | null;
  segments: number;
  senders: SmsSenderProfile[];
  setDraft: Dispatch<SetStateAction<SmsTestSendDraft>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function SmsTestSendCard({
  activeSender,
  draft,
  dispatchAvailable,
  dispatchUnavailableReason,
  lists,
  pending,
  segments,
  senders,
  setDraft,
  onSubmit,
}: SmsTestSendCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Test Send</CardTitle>
        <CardDescription>
          {segments} text segment{segments === 1 ? "" : "s"} · local estimate
          only; no balance, entitlement, reservation, or delivery evidence
          {activeSender ? ` · ${activeSender.registration_status}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!dispatchAvailable ? (
          <p
            className="mb-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis"
            role="status"
          >
            {dispatchUnavailableReason ?? "SMS test dispatch is unavailable."}
          </p>
        ) : null}
        <form
          className="space-y-3"
          onSubmit={(event) => {
            if (!dispatchAvailable) {
              event.preventDefault();
              return;
            }
            onSubmit(event);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="test_sender">Sender</Label>
            <Select
              id="test_sender"
              value={draft.sender_profile_id}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  sender_profile_id: e.target.value,
                }))
              }
              required
            >
              <option value="" disabled>
                Select sender
              </option>
              {senders.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.phone_number || item.messaging_service_sid}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="test_list">SMS list</Label>
            <Select
              id="test_list"
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
            <Label htmlFor="test_to">Recipient</Label>
            <Input
              id="test_to"
              type="tel"
              inputMode="tel"
              pattern={E164_PATTERN}
              placeholder="+14155551212"
              value={draft.to}
              onChange={(e) =>
                setDraft((current) => ({ ...current, to: e.target.value }))
              }
              required
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="test_body">Message</Label>
              <SmsCharCount body={draft.body} max={SMS_BODY_MAX} />
            </div>
            <Textarea
              id="test_body"
              value={draft.body}
              onChange={(e) =>
                setDraft((current) => ({ ...current, body: e.target.value }))
              }
              rows={5}
              maxLength={SMS_BODY_MAX}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="test_media_url">MMS media URL</Label>
            <Input
              id="test_media_url"
              type="url"
              placeholder="https://cdn.example.com/test.jpg"
              value={draft.media_url}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  media_url: e.target.value,
                }))
              }
            />
            <p className="text-xs text-muted-foreground">
              MMS readiness is unverified while{" "}
              <code>sms_mms_readiness_release_held</code> is active.
            </p>
          </div>
          <Button
            type="submit"
            disabled={!dispatchAvailable || pending === "send"}
          >
            <Send className="mr-2 h-4 w-4" />
            Send test
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
