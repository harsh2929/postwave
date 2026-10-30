// expo-haptics touches the native bridge at call time; under the jest routes
// runner there is no bridge (`__fbBatchedBridgeConfig is not set`), so every
// screen that imports src/lib/haptics.ts failed to load. Mirror the API the
// helper uses: the three async calls resolve, the enums keep their names.
const resolved = () => Promise.resolve();
module.exports = {
  impactAsync: jest.fn(resolved),
  notificationAsync: jest.fn(resolved),
  selectionAsync: jest.fn(resolved),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy", Soft: "soft", Rigid: "rigid" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
};
