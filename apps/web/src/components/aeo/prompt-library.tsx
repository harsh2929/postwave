// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createAeoPrompt,
  deleteAeoPrompt,
  toggleAeoPrompt,
  type AEOPrompt,
  type AEOPromptCategory,
} from "@/lib/aeo-api";
import { apiErrorMessage } from "@/lib/api";

import { PROMPT_CATEGORIES } from "./aeo-format";

const MIN_PROMPT_LENGTH = 4;

export interface PromptLibraryProps {
  prompts: AEOPrompt[];
  canWrite: boolean;
  gateDescribedBy: string;
  writeDeniedReason: string | null;
  /** Invalidate prompts (and probes after a delete, which cascades). */
  onChanged: (cascade: "prompts" | "prompts+probes") => void;
}

/** Prompt rotation library — list, add with category, toggle, delete. */
export function PromptLibrary({
  prompts,
  canWrite,
  gateDescribedBy,
  writeDeniedReason,
  onChanged,
}: PromptLibraryProps) {
  const uid = useId();
  const [text, setText] = useState("");
  const [category, setCategory] = useState<AEOPromptCategory>("discovery");

  const add = useMutation({
    mutationFn: createAeoPrompt,
    onSuccess: () => {
      setText("");
      toast.success("Prompt added");
      onChanged("prompts");
    },
    onError: (err: unknown) => {
      toast.error("Add prompt failed", { description: apiErrorMessage(err) });
    },
  });

  const toggle = useMutation({
    mutationFn: (p: AEOPrompt) => toggleAeoPrompt(p.id, !p.enabled),
    onSuccess: () => onChanged("prompts"),
    onError: (err: unknown, p) => {
      toast.error(`${p.enabled ? "Disable" : "Enable"} prompt failed`, {
        description: apiErrorMessage(err),
      });
    },
  });

  const remove = useMutation({
    mutationFn: deleteAeoPrompt,
    onSuccess: () => {
      toast.success("Prompt deleted");
      onChanged("prompts+probes");
    },
  });

  function onSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = text.trim();
    if (!canWrite || add.isPending || trimmed.length < MIN_PROMPT_LENGTH) {
      return;
    }
    add.mutate({ category, prompt_text: trimmed });
  }

  const describedBy = canWrite ? undefined : gateDescribedBy;
  const writeTitle = writeDeniedReason ?? undefined;
  const tooShort = text.trim().length < MIN_PROMPT_LENGTH;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Prompt rotation</CardTitle>
        <CardDescription>
          The questions each probe pass asks the engines.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="space-y-3" onSubmit={onSubmit}>
          <fieldset
            disabled={!canWrite}
            className="grid gap-3 sm:grid-cols-3"
          >
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-category`}>Prompt category</Label>
              <Select
                id={`${uid}-category`}
                value={category}
                onChange={(e) =>
                  setCategory(e.currentTarget.value as AEOPromptCategory)
                }
                aria-describedby={describedBy}
              >
                {PROMPT_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${uid}-text`}>Prompt</Label>
              <Input
                id={`${uid}-text`}
                value={text}
                placeholder="Best email marketing platform for ecommerce?"
                onChange={(e) => setText(e.currentTarget.value)}
                aria-describedby={describedBy}
              />
            </div>
          </fieldset>
          <Button
            type="submit"
            variant="outline"
            disabled={!canWrite || add.isPending || tooShort}
            loading={add.isPending}
            title={writeTitle}
            aria-describedby={describedBy}
          >
            {add.isPending ? "Adding…" : "Add prompt"}
          </Button>
        </form>

        {prompts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No prompts yet. Add a discovery-style prompt to start probing.
          </p>
        ) : (
          <TableContainer aria-label="Prompt rotation library">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Prompt</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prompts.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="capitalize">{p.category}</TableCell>
                    <TableCell>{p.prompt_text}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.source}
                    </TableCell>
                    <TableCell>
                      <Checkbox
                        checked={p.enabled}
                        disabled={!canWrite || toggle.isPending}
                        aria-label={`${p.enabled ? "Disable" : "Enable"} prompt: ${p.prompt_text}`}
                        title={writeTitle}
                        aria-describedby={describedBy}
                        onChange={() => toggle.mutate(p)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <ConfirmDialog
                        trigger={
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={!canWrite || remove.isPending}
                            title={writeTitle}
                            aria-describedby={describedBy}
                          >
                            Delete
                          </Button>
                        }
                        title="Delete this prompt and its probes?"
                        description={`"${p.prompt_text}" is removed from the rotation, and every probe recorded for it is deleted with it. Past mention and citation rates that came from those probes will change.`}
                        confirmLabel="Delete prompt and its probes"
                        onConfirm={() =>
                          remove.mutateAsync(p.id).then(() => undefined)
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </CardContent>
    </Card>
  );
}
