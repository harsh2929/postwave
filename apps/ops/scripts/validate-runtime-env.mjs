#!/usr/bin/env node

const required = [
  "OPS_API_ORIGIN",
  "OPS_API_ALLOWED_HOSTS",
  "OPS_PUBLIC_ORIGIN",
  "OPS_RUNBOOK_BASE_URL",
];

for (const name of required) {
  if (!process.env[name]?.trim()) fail(`${name} is required`);
}

const api = productionURL("OPS_API_ORIGIN", true);
productionURL("OPS_PUBLIC_ORIGIN", true);
productionURL("OPS_RUNBOOK_BASE_URL", false);

const allowed = new Set(
  process.env.OPS_API_ALLOWED_HOSTS.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
if (!allowed.has(api.host.toLowerCase())) {
  fail("OPS_API_ORIGIN host is not present in OPS_API_ALLOWED_HOSTS");
}

function productionURL(name, originOnly) {
  let url;
  try {
    url = new URL(process.env[name]);
  } catch {
    fail(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:") fail(`${name} must use HTTPS`);
  if (url.username || url.password || url.search || url.hash) {
    fail(`${name} must not contain credentials, a query, or a fragment`);
  }
  if (originOnly && url.pathname !== "/" && url.pathname !== "") {
    fail(`${name} must be an origin without a path`);
  }
  return url;
}

function fail(message) {
  console.error(`Invalid ops runtime configuration: ${message}`);
  process.exit(78);
}
