/**
 * TabBarIcon — minimal SVG glyph set so the tab bar doesn't depend on
 * vector-icon font fetches. Trades icon variety for zero-asset cold
 * start; if we want @expo/vector-icons later it slots in here.
 */
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { View } from "react-native";

export type IconName =
  | "home"
  | "users"
  | "send"
  | "settings"
  | "check"
  | "mic"
  | "link"
  | "more"
  | "log"
  | "signout"
  | "chevron"
  | "help"
  | "search"
  | "bell"
  | "card"
  | "image";

export function TabBarIcon({
  name,
  color,
  size = 24,
  accessibilityLabel,
}: {
  name: IconName;
  color: string;
  size?: number;
  accessibilityLabel?: string;
}) {
  const accessibilityProps = accessibilityLabel
    ? {
        accessibilityRole: "image" as const,
        accessibilityLabel,
      }
    : {
        accessible: false,
        accessibilityElementsHidden: true,
        importantForAccessibility: "no" as const,
      };
  return (
    <View {...accessibilityProps}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        {name === "home" && (
          <Path
            d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"
            stroke={color}
            strokeWidth={1.7}
            strokeLinejoin="round"
          />
        )}
        {name === "users" && (
          <>
            <Circle cx={9} cy={8} r={3.4} stroke={color} strokeWidth={1.7} />
            <Path
              d="M3 20c0-3 2.7-5 6-5s6 2 6 5"
              stroke={color}
              strokeWidth={1.7}
              strokeLinecap="round"
            />
            <Circle
              cx={17.5}
              cy={9.5}
              r={2.5}
              stroke={color}
              strokeWidth={1.7}
            />
            <Path
              d="M15.5 14.5c2.5.4 4.5 2 4.5 4.5"
              stroke={color}
              strokeWidth={1.7}
              strokeLinecap="round"
            />
          </>
        )}
        {name === "send" && (
          <Path
            d="M3 11 21 4l-7 17-3-7-8-3z"
            stroke={color}
            strokeWidth={1.7}
            strokeLinejoin="round"
          />
        )}
        {name === "search" && (
          <>
            <Circle cx={10.5} cy={10.5} r={6.5} stroke={color} strokeWidth={1.7} />
            <Path
              d="M15.5 15.5 21 21"
              stroke={color}
              strokeWidth={1.7}
              strokeLinecap="round"
            />
          </>
        )}
        {name === "bell" && (
          <Path
            d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 0 0 4 0"
            stroke={color}
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {name === "image" && (
          <>
            {/* Frame + horizon + sun: the conventional "picture" glyph, which
                is what an asset library holds. */}
            <Rect x={3} y={4.5} width={18} height={15} rx={2.5} stroke={color} strokeWidth={1.7} />
            <Path d="M3.5 16l4.5-4.5 3.5 3.5 3-3 6 6" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
            <Circle cx={9} cy={9} r={1.6} stroke={color} strokeWidth={1.7} />
          </>
        )}
        {name === "card" && (
          <>
            <Rect x={3} y={5} width={18} height={14} rx={2.5} stroke={color} strokeWidth={1.7} />
            <Path d="M3 9.5h18" stroke={color} strokeWidth={1.7} />
          </>
        )}
        {name === "check" && (
          <>
            <Path
              d="M5 12.5 10 17.5 19 8"
              stroke={color}
              strokeWidth={1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <Circle cx={12} cy={12} r={9.5} stroke={color} strokeWidth={1.5} />
          </>
        )}
        {name === "settings" && (
          <>
            <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={1.7} />
            <Path
              d="M19.4 14a7.97 7.97 0 0 0 0-4l2-1.5-2-3.5-2.4 1a8 8 0 0 0-3.5-2L13 1.5h-2L10.5 4a8 8 0 0 0-3.5 2l-2.4-1-2 3.5L4.6 10a8 8 0 0 0 0 4l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 3.5 2l.5 2.5h2l.5-2.5a8 8 0 0 0 3.5-2l2.4 1 2-3.5z"
              stroke={color}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          </>
        )}
        {name === "mic" && (
          <>
            <Rect
              x={9}
              y={3}
              width={6}
              height={11}
              rx={3}
              stroke={color}
              strokeWidth={1.7}
            />
            <Path
              d="M5.5 11a6.5 6.5 0 0 0 13 0"
              stroke={color}
              strokeWidth={1.7}
              strokeLinecap="round"
            />
            <Path
              d="M12 17.5V21"
              stroke={color}
              strokeWidth={1.7}
              strokeLinecap="round"
            />
          </>
        )}
        {name === "link" && (
          <>
            <Path
              d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"
              stroke={color}
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <Path
              d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1-1"
              stroke={color}
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
        {name === "more" && (
          <>
            <Circle cx={5} cy={12} r={1.7} fill={color} />
            <Circle cx={12} cy={12} r={1.7} fill={color} />
            <Circle cx={19} cy={12} r={1.7} fill={color} />
          </>
        )}
        {name === "log" && (
          <>
            <Path
              d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"
              stroke={color}
              strokeWidth={1.7}
              strokeLinejoin="round"
            />
            <Path
              d="M8 10h8M8 14h8M8 18h5"
              stroke={color}
              strokeWidth={1.7}
              strokeLinecap="round"
            />
          </>
        )}
        {name === "signout" && (
          <>
            <Path
              d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"
              stroke={color}
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <Path
              d="m16 8 4 4-4 4M20 12H10"
              stroke={color}
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
        {name === "chevron" && (
          <Path
            d="m9 6 6 6-6 6"
            stroke={color}
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {name === "help" && (
          <>
            <Circle cx={12} cy={12} r={9.5} stroke={color} strokeWidth={1.5} />
            <Path
              d="M9.2 9.3a2.8 2.8 0 0 1 5.4 1c0 1.8-2.6 2.2-2.6 4"
              stroke={color}
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <Circle cx={12} cy={17} r={1} fill={color} />
          </>
        )}
      </Svg>
    </View>
  );
}
