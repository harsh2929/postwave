import { type ReactElement, useMemo } from "react";

import type { AgencyChild } from "../../lib/api-client";

interface Props {
  children: AgencyChild[];
  hasMore: boolean;
}

export function AgencyStatStrip({ children, hasMore }: Props): ReactElement {
  const counts = useMemo(() => {
    let agencyMode = 0;
    let selfMode = 0;
    let brandingOn = 0;
    let markupTotal = 0;
    for (const child of children) {
      if (child.billing_mode === "parent") agencyMode += 1;
      else selfMode += 1;
      if (child.whitelabel_enabled) brandingOn += 1;
      markupTotal += child.reseller_markup_bps;
    }
    return {
      agencyMode,
      selfMode,
      brandingOn,
      averageMarkup:
        children.length > 0 ? markupTotal / children.length / 100 : null,
    };
  }, [children]);

  const cards = [
    {
      label: "Loaded workspaces",
      value: children.length.toLocaleString(),
      detail: hasMore
        ? "Current cursor window · more available"
        : "Complete verified cursor walk",
    },
    {
      label: "Stored agency mode",
      value: counts.agencyMode.toLocaleString(),
      detail: `${counts.selfMode.toLocaleString()} stored as child mode · not payer proof`,
    },
    {
      label: "Branding preference on",
      value: counts.brandingOn.toLocaleString(),
      detail: "Audit-portal projection only · release-held",
    },
    {
      label: "Average stored markup",
      value:
        counts.averageMarkup === null
          ? "—"
          : `${counts.averageMarkup.toFixed(2)}%`,
      detail: "Unweighted across loaded relationship rows",
    },
  ];

  return (
    <section className="agency-stat-strip" aria-label="Loaded roster summary">
      {cards.map((card) => (
        <article key={card.label} className="agency-stat-card">
          <span>{card.label}</span>
          <strong className="tabular">{card.value}</strong>
          <small>{card.detail}</small>
        </article>
      ))}
    </section>
  );
}
