import React, { useEffect } from "react";
import { AccessibilityInfo, Platform, StyleSheet, View } from "react-native";
import { useColors } from "@/hooks/useColors";

/** Static bubbles match the transcript, without a shimmer or artificial delay. */
export function CoachTranscriptSkeleton({ older = false }: { older?: boolean }) {
  const colors = useColors();
  const label = older ? "Loading older messages" : "Loading conversation";
  useEffect(() => {
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(label);
  }, [label]);
  return (
    <View testID={older ? "coach-older-loading" : "coach-transcript-loading"}
      accessibilityRole="progressbar" accessibilityLabel={label}
      accessibilityLiveRegion="polite" aria-busy={true} style={styles.container}>
      {(older ? [false] : [false, true, false]).map((user, index) => (
        <View key={index} accessible={false} style={[styles.bubble, {
          alignSelf: user ? "flex-end" : "flex-start", width: user ? "70%" : "91%",
          backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius,
        }]}>
          {[100, 91, 64].slice(0, user ? 2 : 3).map(width => (
            <View key={width} style={[styles.line, { width: `${width}%`, backgroundColor: colors.track }]} />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 16, paddingVertical: 8 },
  bubble: { gap: 12, padding: 18, borderWidth: 1 },
  line: { height: 13, borderRadius: 4 },
});