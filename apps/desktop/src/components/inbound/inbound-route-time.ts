export function formatInboundRouteRelative(
  iso?: string | null,
  now = Date.now(),
): string {
  if (!iso) return "never";
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const absolute = Math.abs(now - timestamp);
  if (absolute < 60_000) return "just now";
  if (absolute < 3_600_000) return `${Math.round(absolute / 60_000)}m ago`;
  if (absolute < 86_400_000) return `${Math.round(absolute / 3_600_000)}h ago`;
  return `${Math.round(absolute / 86_400_000)}d ago`;
}

export function formatInboundRouteAbsolute(iso?: string | null): string {
  if (!iso) return "Time unavailable";
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? iso : new Date(timestamp).toLocaleString();
}
