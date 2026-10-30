// SPDX-License-Identifier: AGPL-3.0-only

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useEffect, useState } from "react";
import { ListChecks, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { type SmsList, type SmsListInput } from "@/lib/sms-api";
import { CardLoadError } from "./sms-card-states";

export interface SmsListDraft {
  name: string;
  description: string;
  keyword: string;
}

interface SmsListsCardProps {
  draft: SmsListDraft;
  lists: SmsList[];
  loading: boolean;
  loadError?: string | null;
  pending: string | null;
  setDraft: Dispatch<SetStateAction<SmsListDraft>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRetry?: () => void;
  onEditList?: (id: string, input: SmsListInput) => void | Promise<void>;
  onDeleteList?: (id: string) => void | Promise<void>;
}

export function SmsListsCard({
  draft,
  lists,
  loading,
  loadError,
  pending,
  setDraft,
  onSubmit,
  onRetry,
  onEditList,
  onDeleteList,
}: SmsListsCardProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<SmsListDraft>({
    name: "",
    description: "",
    keyword: "",
  });
  // The row revision an edit was submitted against. onEditList reports a
  // rejected save (name too long, unsafe characters, keyword over 64) through a
  // toast and resolves either way, so a resolved promise is no evidence the
  // write landed — closing on it threw away everything the operator had typed.
  // updated_at moves only on a successful UPDATE and, unlike the typed values,
  // it survives the server's own normalization (it uppercases keywords), so it
  // is the honest success signal here.
  const [submittedRevision, setSubmittedRevision] = useState<{
    id: string;
    updatedAt: string;
  } | null>(null);
  const editSaved =
    submittedRevision !== null &&
    lists.some(
      (row) =>
        row.id === submittedRevision.id &&
        row.updated_at !== submittedRevision.updatedAt,
    );

  useEffect(() => {
    if (!editSaved || !submittedRevision) return;
    setEditId((current) =>
      current === submittedRevision.id ? null : current,
    );
    setSubmittedRevision(null);
  }, [editSaved, submittedRevision]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">SMS Lists</CardTitle>
        <CardDescription>
          {lists.length} audience{lists.length === 1 ? "" : "s"} ready for
          consent gates
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={onSubmit}
        >
          <div className="space-y-2">
            <Label htmlFor="list_name">Name</Label>
            <Input
              id="list_name"
              value={draft.name}
              onChange={(e) =>
                setDraft((current) => ({ ...current, name: e.target.value }))
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="list_keyword">Keyword</Label>
            <Input
              id="list_keyword"
              value={draft.keyword}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  keyword: e.target.value,
                }))
              }
            />
          </div>
          <Button
            className="self-end"
            type="submit"
            disabled={pending === "list"}
          >
            Save list
          </Button>
          {/* Keep description in the rendered form so createSmsList receives a
              user-controlled value instead of the draft's initial empty string. */}
          <div className="space-y-2 sm:col-span-3">
            <Label htmlFor="list_description">Description</Label>
            <Input
              id="list_description"
              placeholder="Optional - what this audience is for"
              value={draft.description}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  description: e.target.value,
                }))
              }
            />
          </div>
        </form>
        <div className="space-y-2">
          {lists.map((item) => {
            const open = openId === item.id;
            const count = item.recipient_count ?? 0;
            return (
              <div key={item.id} className="rounded-md border text-sm">
                <div className="flex items-center justify-between gap-2 p-3">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : item.id)}
                  >
                    <span className="block font-medium">{item.name}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Users className="h-3.5 w-3.5" aria-hidden />
                      {count.toLocaleString()} opted-in recipient
                      {count === 1 ? "" : "s"}
                      {item.description ? ` · ${item.description}` : ""}
                    </span>
                  </button>
                  {item.keyword ? (
                    <Badge variant="secondary">{item.keyword}</Badge>
                  ) : null}
                </div>
                {open ? (
                  <div className="space-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
                    <div>
                      <span className="font-medium text-foreground">
                        Recipients:
                      </span>{" "}
                      {count.toLocaleString()} opted-in
                    </div>
                    {item.keyword ? (
                      <div>
                        <span className="font-medium text-foreground">
                          Keyword:
                        </span>{" "}
                        {item.keyword}
                      </div>
                    ) : null}
                    <div className="pt-1">
                      <span className="font-medium text-foreground">
                        Members
                      </span>
                      <p className="mt-1 rounded-md border border-dashed p-2">
                        Member evidence is release-held
                        (sms_evidence_read_release_held). No roster request was
                        sent.
                      </p>
                    </div>

                    {editId === item.id ? (
                      <div className="mt-2 space-y-2 rounded-md border p-2">
                        <Input
                          aria-label="List name"
                          value={editDraft.name}
                          onChange={(e) =>
                            setEditDraft((s) => ({
                              ...s,
                              name: e.target.value,
                            }))
                          }
                          placeholder="List name"
                        />
                        <Input
                          aria-label="Keyword"
                          value={editDraft.keyword}
                          onChange={(e) =>
                            setEditDraft((s) => ({
                              ...s,
                              keyword: e.target.value,
                            }))
                          }
                          placeholder="Keyword (optional)"
                        />
                        <Input
                          aria-label="Description"
                          value={editDraft.description}
                          onChange={(e) =>
                            setEditDraft((s) => ({
                              ...s,
                              description: e.target.value,
                            }))
                          }
                          placeholder="Description (optional)"
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setSubmittedRevision(null);
                              setEditId(null);
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={
                              !editDraft.name.trim() ||
                              pending === `list-edit:${item.id}`
                            }
                            onClick={async () => {
                              if (!onEditList) {
                                setEditId(null);
                                return;
                              }
                              setSubmittedRevision({
                                id: item.id,
                                updatedAt: item.updated_at,
                              });
                              await onEditList(item.id, {
                                name: editDraft.name.trim(),
                                description: editDraft.description.trim(),
                                keyword: editDraft.keyword.trim(),
                                sender_profile_id: "",
                              });
                            }}
                          >
                            Save
                          </Button>
                        </div>
                        {submittedRevision?.id === item.id &&
                        pending !== `list-edit:${item.id}` &&
                        !editSaved ? (
                          <p role="alert" className="text-destructive">
                            This list was not updated. Your edits are still
                            here — fix what the error named and save again.
                          </p>
                        ) : null}
                      </div>
                    ) : onEditList || onDeleteList ? (
                      <div className="mt-2 flex justify-end gap-2">
                        {onEditList ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSubmittedRevision(null);
                              setEditDraft({
                                name: item.name,
                                description: item.description ?? "",
                                keyword: item.keyword ?? "",
                              });
                              setEditId(item.id);
                            }}
                          >
                            Edit
                          </Button>
                        ) : null}
                        {onDeleteList ? (
                          <ConfirmDialog
                            title="Delete this SMS list?"
                            description={`"${item.name}" and its opt-in roster will be removed. Campaigns that used it keep their history. This cannot be undone.`}
                            confirmLabel="Delete"
                            confirmVariant="destructive"
                            onConfirm={() => onDeleteList(item.id)}
                            trigger={
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="text-destructive hover:text-destructive"
                              >
                                Delete
                              </Button>
                            }
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {loadError && lists.length === 0 ? (
            <CardLoadError
              message="SMS lists could not be loaded."
              onRetry={onRetry}
            />
          ) : !loading && lists.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="No SMS lists yet"
              description="Create a keyword-gated audience above to start collecting opt-ins for consent-checked sends."
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
