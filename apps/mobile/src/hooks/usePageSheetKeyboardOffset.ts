import { useCallback, useState } from "react";
import {
  Platform,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";

/**
 * usePageSheetKeyboardOffset — the `keyboardVerticalOffset` a
 * KeyboardAvoidingView inside an iOS `presentationStyle="pageSheet"` modal
 * needs so that it lifts its content FAR ENOUGH.
 *
 * WHY. RN's KeyboardAvoidingView lifts by
 * `frame.y + frame.height - (keyboard.screenY - keyboardVerticalOffset)`.
 * `frame` is its onLayout frame, relative to its PARENT; `screenY` is in
 * SCREEN coordinates. The two agree only when the parent starts at the top of
 * the screen. A pageSheet is a view controller presented in the SAME window,
 * and on an iPhone it is a card whose top edge sits ~50-60pt below the top of
 * the screen — so without an offset the lift comes out short by exactly that
 * drop, and the bottom of whatever the avoider holds (a footer's Confirm row)
 * stays under the keyboard.
 *
 * WHY NOT `measureInWindow`. Under Fabric, measurement stops at the Modal's
 * host shadow node (a RootNodeKind node — LayoutableShadowNode.cpp), so every
 * view inside the sheet measures sheet-local: y = 0 however far down the card
 * starts. It would read as a fix and change nothing on a device.
 *
 * HOW. The modal root is exactly as big as the card, and an iPhone sheet is
 * anchored to the window's bottom, so its top edge is the window height minus
 * the sheet height. Where a card is NOT bottom-anchored (an iPad's floating
 * card), that difference is an upper bound on its top edge: the lift can come
 * out long, never short. Android presents a Modal full-window and has no
 * sheet, so it gets no offset; nor does a sheet that has not laid out yet.
 *
 * Put `onSheetLayout` on the modal's outermost view (the one that fills the
 * card) and pass `keyboardVerticalOffset` to the avoider inside it.
 */
export function usePageSheetKeyboardOffset(): {
  onSheetLayout: (event: LayoutChangeEvent) => void;
  keyboardVerticalOffset: number;
} {
  const { height: windowHeight } = useWindowDimensions();
  const [sheetHeight, setSheetHeight] = useState(0);
  const onSheetLayout = useCallback((event: LayoutChangeEvent) => {
    setSheetHeight(event.nativeEvent.layout.height);
  }, []);
  return {
    onSheetLayout,
    keyboardVerticalOffset: pageSheetKeyboardOffset(
      Platform.OS,
      windowHeight,
      sheetHeight,
    ),
  };
}

/** How far below the window's top edge a bottom-anchored sheet starts. */
export function pageSheetKeyboardOffset(
  os: string,
  windowHeight: number,
  sheetHeight: number,
): number {
  if (os !== "ios") return 0;
  if (!(sheetHeight > 0) || !(windowHeight > sheetHeight)) return 0;
  return windowHeight - sheetHeight;
}
