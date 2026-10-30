// SPDX-License-Identifier: AGPL-3.0-only

const UNSAFE_URL_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/u;

/** Allow only public HTTPS image origins for tenant-controlled hosted chrome. */
export function isSafePublicHttpsAssetURL(value: string): boolean {
  if (value === "") return true;
  if (
    value.trim() !== value ||
    value.length > 2_048 ||
    UNSAFE_URL_TEXT.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      parsed.username === "" &&
      parsed.password === "" &&
      !isObviousPrivateHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** Pick the higher-contrast black/white label for any verified six-digit hex. */
export function preferredContrastingTextColor(
  background: string,
): "#000000" | "#FFFFFF" {
  if (!HEX_COLOR.test(background)) return "#000000";
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(background.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4),
  );
  const luminance =
    0.2126 * Number(linear[0]) +
    0.7152 * Number(linear[1]) +
    0.0722 * Number(linear[2]);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;
  return whiteContrast >= blackContrast ? "#FFFFFF" : "#000000";
}

function isObviousPrivateHost(raw: string): boolean {
  const host = raw
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  if (host.includes(":")) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb") ||
      host.startsWith("ff")
    );
  }
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return !host.includes(".");
  }
  const [first = -1, second = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}
