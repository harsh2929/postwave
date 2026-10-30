/**
 * The only native Modal seam product surfaces should need.
 *
 * React Native's built-in `fade` and `slide` animations do not consult the
 * operating-system Reduce Motion preference. Keeping that decision here makes
 * it impossible for an individual sheet to forget the accessibility setting:
 * callers still choose the appropriate normal-motion transition, while this
 * component collapses it to `none` when the user asks the OS to avoid motion.
 */
import { Modal, type ModalProps } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

export function ReducedMotionModal({
  animationType = "none",
  ...props
}: ModalProps) {
  const reducedMotion = useReducedMotion();

  return (
    <Modal
      {...props}
      animationType={reducedMotion ? "none" : animationType}
    />
  );
}
