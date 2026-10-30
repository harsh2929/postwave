export const DEFAULT_MAX_FUNCTION_LINES = 300;
export const DEFAULT_MAX_COMPLEXITY = 50;

export function collectFunctionQualityFindings(
  observed,
  legacyBudgets,
  existingPaths,
) {
  const findings = [];
  const dimensions = [
    ["maxFunctionLines", DEFAULT_MAX_FUNCTION_LINES, "function-line"],
    ["maxComplexity", DEFAULT_MAX_COMPLEXITY, "complexity"],
  ];

  for (const [path, actual] of observed) {
    const budget = legacyBudgets.get(path);
    if (!budget) {
      findings.push(
        `${path} exceeds a default function-quality limit without a reviewed legacy ratchet`,
      );
      continue;
    }

    for (const [key, defaultLimit, label] of dimensions) {
      const actualValue = actual[key];
      const budgetValue = budget[key];
      if (actualValue == null && budgetValue == null) continue;
      if (actualValue == null) {
        findings.push(
          `${path} no longer exceeds the default ${label} limit ${defaultLimit}; remove its stale ${key} ratchet`,
        );
      } else if (budgetValue == null) {
        findings.push(
          `${path} has ${label} maximum ${actualValue} without a reviewed ${key} ratchet`,
        );
      } else if (actualValue > budgetValue) {
        findings.push(
          `${path} has ${label} maximum ${actualValue}, exact legacy ratchet ${budgetValue}`,
        );
      } else if (actualValue < budgetValue) {
        findings.push(
          `${path} has ${label} maximum ${actualValue} below exact legacy ratchet ${budgetValue}; lower it to ${actualValue}`,
        );
      }
    }
  }

  for (const [path, budget] of legacyBudgets) {
    if (!existingPaths.has(path)) {
      findings.push(`${path} has a legacy function-quality ratchet but no source file`);
      continue;
    }
    if (!observed.has(path)) {
      const dimensionsText = Object.keys(budget).join(", ");
      findings.push(
        `${path} is within all default function-quality limits; remove stale ratchets (${dimensionsText})`,
      );
    }
  }

  return findings.sort();
}
