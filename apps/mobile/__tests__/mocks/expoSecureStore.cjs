// expo-secure-store calls the native bridge on import; the jest routes runner
// has none. An in-memory store keeps the helper's contract (get/set/delete,
// plus the sync variants and availability probe) without a keychain.
const store = new Map();
module.exports = {
  getItemAsync: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
  setItemAsync: jest.fn(async (key, value) => { store.set(key, value); }),
  deleteItemAsync: jest.fn(async (key) => { store.delete(key); }),
  getItem: jest.fn((key) => (store.has(key) ? store.get(key) : null)),
  setItem: jest.fn((key, value) => { store.set(key, value); }),
  isAvailableAsync: jest.fn(async () => true),
  canUseBiometricAuthentication: jest.fn(() => false),
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  __reset: () => store.clear(),
};
