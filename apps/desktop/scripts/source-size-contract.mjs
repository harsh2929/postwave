// Pure source-size contract helpers. Keeping the policy separate from the
// filesystem runner makes the fail-closed behavior inexpensive to test.

export function countSourceLines(source) {
  if (source.length === 0) return 0;
  return source.split(/\r\n|\r|\n/).length;
}

export function collectSourceSizeFindings(
  rows,
  {
    fileBudgets,
    defaultTypeScriptMax,
    defaultCssMax,
  },
) {
  const findings = [];
  const seen = new Set();

  for (const row of rows) {
    if (seen.has(row.rel)) {
      findings.push(`${row.rel} was measured more than once`);
      continue;
    }
    seen.add(row.rel);

    const defaultBudget = row.rel.endsWith(".css")
      ? defaultCssMax
      : defaultTypeScriptMax;
    const exactBudget = fileBudgets.get(row.rel);

    if (exactBudget == null) {
      if (row.lines > defaultBudget) {
        findings.push(
          `${row.rel} has ${row.lines} lines, default budget ${defaultBudget}; split the file or add a reviewed exact legacy ratchet`,
        );
      }
      continue;
    }

    if (row.lines <= defaultBudget) {
      findings.push(
        `${row.rel} is within the default budget ${defaultBudget}; remove its stale legacy ratchet`,
      );
    } else if (row.lines > exactBudget) {
      findings.push(
        `${row.rel} has ${row.lines} lines, exact legacy budget ${exactBudget}`,
      );
    } else if (row.lines < exactBudget) {
      findings.push(
        `${row.rel} has ${row.lines} lines below exact legacy budget ${exactBudget}; lower the ratchet to ${row.lines}`,
      );
    }
  }

  for (const rel of fileBudgets.keys()) {
    if (!seen.has(rel)) {
      findings.push(
        `${rel} has an exact legacy budget but no matching source file; remove the stale entry`,
      );
    }
  }

  return findings.sort();
}
