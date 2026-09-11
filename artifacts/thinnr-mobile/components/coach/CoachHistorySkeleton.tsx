import React from "react";
import { View, StyleSheet, Platform } from "react-native";

type CoachHistorySkeletonProps = {
  backgroundColor: string;
  borderColor: string;
  placeholderColor: string;
  radius: number;
  loadMore?: boolean;
};

const SKELETON_ROWS = 5;

/**
 * A deliberately static loading state. Keeping this as shapes rather than an
 * animated shimmer makes the history screen quiet and honors reduced motion
 * without needing a separate animation preference check.
 */
export function CoachHistorySkeleton({
  backgroundColor,
  borderColor,
  placeholderColor,
  radius,
  loadMore = false,
}: CoachHistorySkeletonProps) {
  return (
    <View
      testID={loadMore ? "history-loading-more" : "history-loading"}
      style={!loadMore && styles.loading}
      accessibilityRole="progressbar"
      accessibilityLabel={loadMore ? "Loading more conversations" : "Loading chat history"}
      accessibilityLiveRegion={Platform.OS === "ios" ? undefined : "polite"}
      aria-busy={true}
      aria-live="polite"
    >
      <View testID="history-skeleton" style={[styles.list, loadMore && { paddingHorizontal: 0 }]}>
        {Array.from({ length: loadMore ? 2 : SKELETON_ROWS }, (_, index) => (
          <View
            key={index}
            testID="history-skeleton-row"
            style={[
              styles.row,
              { backgroundColor, borderColor, borderRadius: radius },
            ]}
            accessible={false}
          >
            <View style={styles.rowTop}>
              <View style={styles.rowMain}>
              <View
                testID="history-skeleton-title"
                style={[styles.titlePlaceholder, { backgroundColor: placeholderColor }]}
              />
              <View
                testID="history-skeleton-date"
                style={[styles.datePlaceholder, { backgroundColor: placeholderColor }]}
              />
              </View>
              <View
                testID="history-skeleton-chevron"
                style={[styles.chevronPlaceholder, { backgroundColor: placeholderColor }]}
              />
            </View>
            <View style={[styles.actionRow, { borderTopColor: borderColor }]}>
              <View style={[styles.datePlaceholder, { width: "56%", backgroundColor: placeholderColor }]} />
              <View style={[styles.datePlaceholder, { width: 44, backgroundColor: placeholderColor }]} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
  },
  list: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 12,
  },
  row: {
    borderWidth: 1,
    overflow: "hidden",
  },
  rowTop: {
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  actionRow: {
    borderTopWidth: 1,
    minHeight: 40,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowMain: {
    flex: 1,
  },
  titlePlaceholder: {
    width: "72%",
    height: 16,
    borderRadius: 4,
    marginBottom: 10,
  },
  datePlaceholder: {
    width: "34%",
    height: 12,
    borderRadius: 4,
  },
  chevronPlaceholder: {
    width: 10,
    height: 18,
    borderRadius: 4,
    marginLeft: 12,
  },
});