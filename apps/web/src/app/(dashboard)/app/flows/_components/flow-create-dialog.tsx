// SPDX-License-Identifier: AGPL-3.0-only
//
// "New flow" starter gallery (FLOW-032) with a name prompt (FLOW-036). Replaces
// the old behaviour of silently creating a blank "Untitled flow" and jumping
// straight into the editor. The operator picks a starter (blank / welcome /
// nurture / win-back / abandoned-cart) and names it before the flow is created.
"use client";

import { useState } from "react";
import { GitBranch, Plus } from "lucide-react";

import { FLOW_STARTERS, type FlowStarter } from "@/lib/flow-starters";
import type { FlowInput } from "@/lib/flows-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function FlowCreateDialog({
  onCreate,
  pending,
  disabled = false,
  disabledReason,
}: {
  /** Build the input from the chosen starter + name, then create. */
  onCreate: (input: FlowInput) => void;
  pending: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<FlowStarter>(FLOW_STARTERS[0]);
  const [name, setName] = useState("");

  function submit() {
    if (pending || disabled) return;
    const built = selected.build();
    const finalName =
      name.trim() ||
      (selected.key === "blank" ? "Untitled flow" : selected.name);
    onCreate({ ...built, name: finalName });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setSelected(FLOW_STARTERS[0]);
          setName("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          New flow
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create a flow</DialogTitle>
          <DialogDescription>
            Start from a proven journey or a blank canvas. You can change
            everything after.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {FLOW_STARTERS.map((starter) => {
              const isSelected = starter.key === selected.key;
              return (
                <button
                  key={starter.key}
                  type="button"
                  onClick={() => setSelected(starter)}
                  aria-pressed={isSelected}
                  disabled={pending || disabled}
                  className={cn(
                    "flex min-h-11 flex-col gap-1 rounded-lg border p-3 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
                    isSelected
                      ? "border-primary bg-accent ring-1 ring-primary"
                      : "border-border hover:border-primary/50 hover:bg-accent/50",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <GitBranch
                      className="h-4 w-4 text-muted-foreground"
                      aria-hidden
                    />
                    {starter.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {starter.description}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-flow-name">Flow name</Label>
            <Input
              id="new-flow-name"
              value={name}
              placeholder={
                selected.key === "blank" ? "Untitled flow" : selected.name
              }
              onChange={(e) => setName(e.target.value)}
              disabled={pending || disabled}
            />
          </div>

          <DialogFooter>
            <Button type="submit" loading={pending} disabled={disabled}>
              Create flow
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
