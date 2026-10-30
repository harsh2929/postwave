export interface RuntimeFeatureProbe {
  colorMix: boolean;
  containerQueries: boolean;
  inert: boolean;
  secureCrypto: boolean;
}

export const REQUIRED_DESKTOP_RUNTIME = {
  macosWebKit: "16.2",
  windowsWebView2: "111",
} as const;

export function runtimeCompatibilityIssues(
  probe: RuntimeFeatureProbe,
): string[] {
  const issues: string[] = [];
  if (!probe.colorMix) issues.push("CSS color mixing");
  if (!probe.containerQueries) issues.push("CSS container queries");
  if (!probe.inert) issues.push("accessible modal isolation");
  if (!probe.secureCrypto) issues.push("secure browser cryptography");
  return issues;
}

export function detectRuntimeCompatibilityIssues(): string[] {
  try {
    const supports =
      typeof CSS !== "undefined" && typeof CSS.supports === "function"
        ? CSS.supports.bind(CSS)
        : () => false;
    return runtimeCompatibilityIssues({
      colorMix: supports(
        "color",
        "color-mix(in srgb, rgb(0 0 0) 50%, rgb(255 255 255))",
      ),
      containerQueries: supports("container-type", "inline-size"),
      inert:
        typeof HTMLElement !== "undefined" && "inert" in HTMLElement.prototype,
      secureCrypto:
        typeof crypto !== "undefined" &&
        typeof crypto.subtle !== "undefined" &&
        typeof crypto.getRandomValues === "function",
    });
  } catch {
    return runtimeCompatibilityIssues({
      colorMix: false,
      containerQueries: false,
      inert: false,
      secureCrypto: false,
    });
  }
}
