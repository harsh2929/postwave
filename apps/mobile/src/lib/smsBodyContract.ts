/** Canonical private-inbox body limits shared by display decoding and replies. */
export const SMS_INBOX_BODY_MAX_UTF8_BYTES = 16_384;
export const SMS_INBOX_BODY_MAX_CODE_POINTS = 4_800;

/** Mobile intentionally offers a narrower composer than the storage contract. */
export const SMS_REPLY_PRODUCT_MAX_CODE_POINTS = 1_600;

export function isValidSmsInboxBody(
  value: string,
  options: { allowEmpty?: boolean; maxCodePoints?: number } = {},
): boolean {
  if (!options.allowEmpty && value.trim().length === 0) return false;
  if (value.includes("\u0000") || !hasOnlyUnicodeScalars(value)) return false;
  return (
    Array.from(value).length <=
      (options.maxCodePoints ?? SMS_INBOX_BODY_MAX_CODE_POINTS) &&
    smsUtf8Bytes(value) <= SMS_INBOX_BODY_MAX_UTF8_BYTES
  );
}

export function isValidSmsReplyBody(value: string): boolean {
  return isValidSmsInboxBody(value.trim(), {
    maxCodePoints: SMS_REPLY_PRODUCT_MAX_CODE_POINTS,
  });
}

export function smsUtf8Bytes(value: string): number {
  let bytes = 0;
  for (const point of value) {
    const code = point.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
