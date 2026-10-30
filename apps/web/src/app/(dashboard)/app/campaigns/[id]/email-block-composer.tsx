// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  composeEmailBlocks,
  getEmailBlockCatalog,
  type EmailBlockInstance,
} from "@/lib/workspace-ops-api";

export function EmailBlockComposer({
  identity,
  subject,
  onApply,
}: {
  identity: MeResponse;
  subject: string;
  onApply: (mjml: string) => void;
}) {
  const canWrite =
    !identity.viewer_mode && roleCanWrite(effectiveAuthRole(identity));
  const [catalog, setCatalog] = useState<
    Awaited<ReturnType<typeof getEmailBlockCatalog>> | null
  >(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState("");
  const [instances, setInstances] = useState<EmailBlockInstance[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ mjml: string; warnings: string[] } | null>(null);
  const [dirty, setDirty] = useState(true);
  const sequence = useRef(0);

  const loadCatalog = async () => {
    const request = ++sequence.current;
    setLoading(true);
    setCatalogError(null);
    try {
      const next = await getEmailBlockCatalog();
      if (request !== sequence.current) return;
      setCatalog(next);
      setSelected(next.blocks[0]?.id ?? "");
    } catch (caught) {
      if (request === sequence.current) {
        setCatalogError(
          caught instanceof Error ? caught.message : "Block catalog failed.",
        );
      }
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    void loadCatalog();
    return () => {
      sequence.current += 1;
    };
  }, []);

  const catalogById = useMemo(
    () => new Map((catalog?.blocks ?? []).map((block) => [block.id, block])),
    [catalog?.blocks],
  );

  const markChanged = (next: EmailBlockInstance[]) => {
    sequence.current += 1;
    setInstances(next);
    setResult(null);
    setError(null);
    setDirty(true);
    setPending(false);
  };

  const add = () => {
    const block = catalogById.get(selected);
    if (!block || instances.length >= 100) return;
    markChanged([
      ...instances,
      { block_id: block.id, config: { ...block.defaults } },
    ]);
  };

  async function compose() {
    if (!canWrite || !catalog || instances.length === 0 || pending) return;
    const request = ++sequence.current;
    const snapshot = instances.map((instance) => ({
      block_id: instance.block_id,
      config: { ...instance.config },
    }));
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const fresh = await whoamiFresh();
      if (
        fresh.user_id !== identity.user_id ||
        fresh.tenant_id !== identity.tenant_id ||
        fresh.viewer_mode ||
        !roleCanWrite(effectiveAuthRole(fresh))
      ) {
        throw new Error(
          "Workspace or campaign authority changed. Refresh before composing.",
        );
      }
      const composed = await composeEmailBlocks({
        brand: catalog.brand,
        blocks: snapshot,
        subject,
      });
      if (request !== sequence.current) return;
      setResult(composed);
      setDirty(false);
    } catch (caught) {
      if (request === sequence.current) {
        setError(
          caught instanceof Error ? caught.message : "Block composition failed.",
        );
      }
    } finally {
      if (request === sequence.current) setPending(false);
    }
  }

  return (
    <section aria-labelledby="server-block-composer" className="grid gap-3 rounded-md border bg-card p-4">
      <div>
        <h3 id="server-block-composer" className="text-sm font-semibold">Catalog block composer</h3>
        <p className="text-xs text-muted-foreground">
          Build ordered server catalog blocks and apply the composed MJML to this campaign. Composition does not send the campaign.
        </p>
      </div>
      {loading ? <p role="status" className="text-sm text-muted-foreground">Loading block catalog…</p> : null}
      {catalogError ? (
        <div role="alert" className="flex items-center justify-between gap-3 text-sm text-destructive">
          <span>{catalogError}</span>
          <Button type="button" variant="outline" onClick={() => void loadCatalog()}>Retry catalog</Button>
        </div>
      ) : null}
      {catalog ? (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid min-w-64 gap-1">
              <Label htmlFor="catalog-block-type">Block type</Label>
              <Select id="catalog-block-type" value={selected} disabled={!canWrite || pending} onChange={(event) => setSelected(event.target.value)}>
                {catalog.blocks.map((block) => <option key={block.id} value={block.id}>{block.name}</option>)}
              </Select>
            </div>
            <Button type="button" variant="outline" disabled={!canWrite || pending || !selected || instances.length >= 100} onClick={add}>Add block</Button>
          </div>
          <div className="grid gap-3">
            {instances.map((instance, index) => {
              const block = catalogById.get(instance.block_id);
              if (!block) return null;
              return (
                <fieldset key={`${instance.block_id}-${index}`} className="grid gap-2 rounded-md border p-3" disabled={!canWrite || pending}>
                  <legend className="px-1 text-sm font-medium">{index + 1}. {block.name}</legend>
                  {block.fields.map((field) => (
                    <div key={field.key} className="grid gap-1">
                      <Label htmlFor={`catalog-${index}-${field.key}`}>{field.label}</Label>
                      {field.type === "bool" ? (
                        <Input
                          id={`catalog-${index}-${field.key}`}
                          type="checkbox"
                          checked={instance.config[field.key] === true}
                          onChange={(event) => {
                            const next = [...instances];
                            next[index] = { ...instance, config: { ...instance.config, [field.key]: event.target.checked } };
                            markChanged(next);
                          }}
                        />
                      ) : field.type === "select" ? (
                        <Select
                          id={`catalog-${index}-${field.key}`}
                          value={String(instance.config[field.key] ?? "")}
                          onChange={(event) => {
                            const next = [...instances];
                            next[index] = { ...instance, config: { ...instance.config, [field.key]: event.target.value } };
                            markChanged(next);
                          }}
                        >
                          {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                        </Select>
                      ) : (
                        <Input
                          id={`catalog-${index}-${field.key}`}
                          type={field.type === "number" ? "number" : "text"}
                          maxLength={2_000}
                          value={String(instance.config[field.key] ?? "")}
                          onChange={(event) => {
                            const value = field.type === "number" ? Number(event.target.value) : event.target.value;
                            const next = [...instances];
                            next[index] = { ...instance, config: { ...instance.config, [field.key]: value } };
                            markChanged(next);
                          }}
                        />
                      )}
                      {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
                    </div>
                  ))}
                  <Button type="button" variant="ghost" onClick={() => markChanged(instances.filter((_, itemIndex) => itemIndex !== index))}>Remove block</Button>
                </fieldset>
              );
            })}
          </div>
          {!canWrite ? <p className="text-sm text-muted-foreground">Editor access outside viewer mode is required to compose campaign MJML.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!canWrite || pending || instances.length === 0} loading={pending} onClick={() => void compose()}>
              {pending ? "Composing…" : "Compose MJML"}
            </Button>
            <Button type="button" variant="outline" disabled={!canWrite || pending || dirty || !result} onClick={() => result && onApply(result.mjml)}>
              Apply composed MJML
            </Button>
          </div>
          <div aria-live="polite" aria-busy={pending}>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {result ? (
              <div className="grid gap-2">
                <p className="text-sm text-muted-foreground">Composition is current for {instances.length} block(s). Review it in the MJML field before saving.</p>
                {result.warnings.length ? <ul className="list-disc pl-5 text-sm text-muted-foreground">{result.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul> : null}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
