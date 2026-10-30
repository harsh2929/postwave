/**
 * lib/telemetryConsentStore.ts — Keychain storage for the telemetry consent
 * decision.
 *
 * One item, read at launch by lib/telemetry (PostHog) and, through its
 * `getOptOut`, by lib/sentry. This file owns WHERE the decision is kept, under
 * what protection class, in what format, and the one-time migration of an item
 * a legacy build wrote. What the session does with a decision stays in
 * lib/telemetry.ts.
 */
import * as SecureStore from "expo-secure-store";

const SS_OPTOUT = "postwave_telemetry_optout";

/**
 * The same protection class every other SecureStore write in this app uses
 * (lib/pushDeviceStore, lib/secureVault, store/authSecureStorage, ...).
 *
 * Without it the consent flag defaults to a class that is included in an
 * encrypted iTunes/Finder backup, so restoring one person's backup onto a
 * second handset carried their telemetry decision with it — a consent record
 * that migrated to a device its owner never opted in on. `THIS_DEVICE_ONLY`
 * keeps the item off the backup and out of iCloud Keychain entirely.
 */
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * The stored decision carries a format tag, and the tag is what makes the
 * class upgrade below a ONE-TIME migration rather than a cost paid on every
 * launch.
 *
 * Items written by a build that predates `SECURE_OPTIONS` still carry the old,
 * backup-eligible class. The class is fixed when an item is added, and a read
 * cannot see it — expo-secure-store's read query never names
 * kSecAttrAccessible — so the value itself has to say which build wrote it.
 * A value with no format tag was written by a legacy build: readOptOut re-adds
 * it once, tagged, under the current class. A tagged value was written by this
 * build or a later one and is left alone. A tag this build cannot parse is read
 * as a withdrawal but not rewritten, so a downgrade does not destroy the newer
 * build's record.
 *
 * A per-process flag used to stand in for the tag. It reset on every launch,
 * so every launch with a stored decision paid a delete and a write on the very
 * read that gates PostHog and Sentry at boot.
 */
const STORED_FORMAT = "v2:";
const STORED_GRANT = `${STORED_FORMAT}0`;
const STORED_WITHDRAWAL = `${STORED_FORMAT}1`;
/** Any build's format tag. A legacy build wrote a bare "0" or "1". */
const FORMAT_TAG = /^v\d+:/;
/** A legacy build's grant. Its withdrawal was "1". */
const LEGACY_GRANT = "0";

function encodeDecision(optOut: boolean): string {
  return optOut ? STORED_WITHDRAWAL : STORED_GRANT;
}

/**
 * The one-time migration while it is in flight, shared by every reader. Two
 * readers run at launch: Sentry's consent check (app/_layout.tsx) and
 * telemetry's init() (useAppBootstrap). A read that lands between the
 * migration's delete and its re-add finds no record, which turns that system
 * off for the launch although a decision is recorded. A reader that arrives
 * mid-migration therefore waits for it, and a reader that found the same
 * legacy item joins it rather than deleting the item a second time.
 * writeOptOut reads through here first, so a decision made mid-migration
 * lands after the migration, not under it.
 */
let migration: Promise<void> | null = null;

/**
 * The stored decision: opted out unless an explicit grant is recorded. Never
 * throws — a decision that cannot be read is treated as no decision.
 */
export async function readOptOut(): Promise<boolean> {
  // Never read while the migration has the item deleted (see `migration`).
  while (migration) await migration;
  let stored: string | null;
  try {
    stored = await SecureStore.getItemAsync(SS_OPTOUT, SECURE_OPTIONS);
  } catch {
    // A locked keychain surfaces as a THROW rather than null. (An item under a
    // different accessibility class does not: reads never match on the class,
    // so a legacy item reads back normally.) Consent that cannot be read is
    // not consent: treat it as not set and stay silent.
    return true;
  }
  if (stored === null) return true;
  // Only an explicit grant is consent. Anything else — including a format a
  // LATER build wrote, read after a downgrade — fails towards not sending.
  const optOut = stored !== STORED_GRANT && stored !== LEGACY_GRANT;
  if (!FORMAT_TAG.test(stored)) {
    // Awaited, not fired and forgotten: a detached rewrite could land after a
    // concurrent writeOptOut and put the old decision back.
    migration ??= migrateLegacyItem(optOut).finally(() => {
      migration = null;
    });
    await migration;
  }
  return optOut;
}

async function migrateLegacyItem(optOut: boolean): Promise<void> {
  try {
    // DELETE, THEN WRITE. A plain setItemAsync cannot change an existing
    // item's protection class: expo-secure-store sets kSecAttrAccessible only
    // on the SecItemAdd path, and for an item that already exists it falls
    // through to `update()`, which passes a dictionary containing
    // kSecValueData ALONE (SecureStoreModule.swift). The class the old build
    // wrote survives, so the upgrade silently did nothing on exactly the
    // devices that needed it — the ones carrying an item written before this
    // fix. Deleting first means the write takes the Add path and the
    // requested class is applied.
    //
    // A crash between the two lands on "no stored decision", which readOptOut
    // treats as opted OUT. Losing the record fails towards not sending
    // telemetry, which is the safe direction for a consent flag — and with
    // the tag, that window opens once per install rather than every launch.
    await SecureStore.deleteItemAsync(SS_OPTOUT, SECURE_OPTIONS);
    await SecureStore.setItemAsync(
      SS_OPTOUT,
      encodeDecision(optOut),
      SECURE_OPTIONS,
    );
  } catch {
    // The decision is still honoured for this session. An item the delete
    // did not reach stays untagged under its old class, so the next read
    // tries again.
  }
}

/**
 * Records a decision. Rejects when the keychain refuses the write, so the
 * caller can tell the user it was not saved.
 */
export async function writeOptOut(optOut: boolean): Promise<void> {
  // Bring a legacy item across first. For an item that already exists the
  // write below takes SecItemUpdate, which keeps whatever class the item has —
  // and a tagged value would then hide a legacy-class item from the one-time
  // migration for good.
  await readOptOut();
  await SecureStore.setItemAsync(
    SS_OPTOUT,
    encodeDecision(optOut),
    SECURE_OPTIONS,
  );
}
