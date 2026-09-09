/**
 * PhotoLightbox — a full-screen photo viewer that pages between a small set
 * of photos.
 *
 * Deliberately generic: it knows about a list of {uri, label, caption} and
 * nothing about where the photos came from, so any screen with thumbnails
 * too small to judge (the guided session's review step today, the Progress
 * grid next) can hand it a list and an index.
 *
 * Paging is swipe-first (a horizontal paging ScrollView) with explicit
 * Previous / Next controls beside the caption, because a swipe is invisible
 * to a screen reader and awkward with a mouse in the web preview. The
 * position ("2 of 3") and the angle label stay on screen the whole time,
 * and every page change is announced.
 *
 * It renders inside AppModal, so the platform back gesture (Android) and
 * Escape (web) close it for free, and web keeps the fit-to-iPhone canvas.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { ZoomableImage } from '@/components/bloodwork/ZoomableImage';
import { AppModal } from '@/components/ui/AppModal';
import { overlayTopPad } from '@/constants/layout';
import { useAppWindowDimensions } from '@/hooks/useAppWindowDimensions';

/**
 * Backdrop behind the photo — opaque, not a scrim: the screen underneath is
 * a bright cream review sheet, and any bleed-through reads as a rendering
 * fault next to a photo the patient is trying to judge.
 */
const LIGHTBOX_BACKDROP = '#0B1017';

export interface LightboxPhoto {
  /** Stable identity for the page (angle, photo id, …). */
  key: string;
  uri: string;
  /** Optional headers for authenticated native fetches. */
  headers?: Record<string, string>;
  /** Short name shown under the photo and spoken on every page change. */
  label: string;
  /** Optional second line (date, status, weight …). */
  caption?: string;
}

interface PhotoLightboxProps {
  visible: boolean;
  photos: readonly LightboxPhoto[];
  /** Index into `photos`; clamped, so a shrinking list cannot strand it. */
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /**
   * Optional control for the photo on screen — e.g. the guided session's
   * "Reshoot" toggle. Rendered in the footer, below the caption.
   */
  renderAction?: (photo: LightboxPhoto, index: number) => React.ReactNode;
  /** Accessible name for the close control. */
  closeLabel?: string;
  testID?: string;
}

export function PhotoLightbox({
  visible,
  photos,
  index,
  onIndexChange,
  onClose,
  renderAction,
  closeLabel = 'Close the photo viewer',
  testID = 'photo-lightbox',
}: PhotoLightboxProps) {
  const insets = useSafeAreaInsets();
  const { width } = useAppWindowDimensions();
  const scrollRef = useRef<ScrollView | null>(null);
  const announcedRef = useRef<string | null>(null);

  // A page is exactly the pager's own box. It has to be MEASURED, not
  // assumed: a horizontal paging ScrollView sizes its content to its
  // children, so a page with a percentage height collapses to nothing.
  const [box, setBox] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const count = photos.length;
  const position = count === 0 ? 0 : Math.min(Math.max(index, 0), count - 1);
  const current = photos[position] ?? null;
  // Before the first layout pass, fall back to the window (and finally to
  // the reference iPhone width) so the scroll offsets are never NaN.
  const pageWidth = box.width > 0 ? box.width : width > 0 ? width : 393;
  const pageHeight = box.height > 0 ? box.height : undefined;

  const handleLayout = useCallback(
    (event: { nativeEvent?: { layout?: { width?: number; height?: number } } }) => {
      const layout = event?.nativeEvent?.layout;
      const nextWidth = layout?.width ?? 0;
      const nextHeight = layout?.height ?? 0;
      setBox(prev =>
        prev.width === nextWidth && prev.height === nextHeight
          ? prev
          : { width: nextWidth, height: nextHeight },
      );
    },
    [],
  );

  // Opening, and every page change, is spoken — the swipe itself tells a
  // screen-reader user nothing about what is now on screen.
  useEffect(() => {
    if (!visible || !current) {
      announcedRef.current = null;
      return;
    }
    const message = `${current.label} photo. ${position + 1} of ${count}.`;
    if (announcedRef.current === message) return;
    announcedRef.current = message;
    AccessibilityInfo.announceForAccessibility(message);
  }, [visible, current, position, count]);

  // Keep the pager on the current page when the index moves from outside
  // (opening at a chosen photo, or the Previous / Next controls).
  useEffect(() => {
    if (!visible) return;
    scrollRef.current?.scrollTo({ x: position * pageWidth, animated: false });
  }, [visible, position, pageWidth]);

  const handleMomentumEnd = useCallback(
    (event: { nativeEvent?: { contentOffset?: { x?: number } } }) => {
      const x = event?.nativeEvent?.contentOffset?.x ?? 0;
      const landed = Math.min(Math.max(Math.round(x / pageWidth), 0), Math.max(count - 1, 0));
      if (landed !== position) onIndexChange(landed);
    },
    [count, onIndexChange, pageWidth, position],
  );

  const step = useCallback(
    (delta: number) => {
      const next = position + delta;
      if (next < 0 || next >= count) return;
      onIndexChange(next);
    },
    [count, onIndexChange, position],
  );

  if (count === 0 || !current) return null;

  const atFirst = position === 0;
  const atLast = position === count - 1;

  return (
    <AppModal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View
        testID={testID}
        style={[
          styles.backdrop,
          {
            paddingTop: overlayTopPad(insets.top),
            paddingBottom: Math.max(insets.bottom, 14),
          },
        ]}
      >
        <View style={styles.header}>
          <Text testID={`${testID}-position`} style={styles.position}>
            {position + 1} of {count}
          </Text>
          <Pressable
            testID={`${testID}-close`}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
            onPress={onClose}
            hitSlop={10}
            style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.65 }]}
          >
            <Feather name="x" size={22} color="#FFFFFF" />
          </Pressable>
        </View>

        <ScrollView
          testID={`${testID}-pager`}
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleMomentumEnd}
          onLayout={handleLayout}
          style={styles.pager}
        >
          {photos.map((photo, photoIndex) => (
            <View
              key={photo.key}
              testID={`${testID}-page-${photo.key}`}
              style={[styles.page, { width: pageWidth, height: pageHeight }]}
              accessible
              accessibilityLabel={`${photo.label} photo, ${photoIndex + 1} of ${count}`}
            >
              <ZoomableImage
                uri={photo.uri}
                headers={photo.headers}
                cachePolicy={photo.headers ? "none" : "disk"}
              />
            </View>
          ))}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            testID={`${testID}-prev`}
            accessibilityRole="button"
            accessibilityLabel="Show the previous photo"
            aria-disabled={atFirst}
            accessibilityState={{ disabled: atFirst }}
            onPress={() => step(-1)}
            hitSlop={10}
            style={({ pressed }) => [
              styles.stepBtn,
              atFirst && styles.stepBtnOff,
              pressed && !atFirst && { opacity: 0.7 },
            ]}
          >
            <Feather name="chevron-left" size={22} color="#FFFFFF" />
          </Pressable>
          <View style={styles.captionWrap}>
            <Text testID={`${testID}-label`} style={styles.label}>
              {current.label}
            </Text>
            {current.caption ? (
              <Text testID={`${testID}-caption`} style={styles.caption}>
                {current.caption}
              </Text>
            ) : null}
          </View>
          <Pressable
            testID={`${testID}-next`}
            accessibilityRole="button"
            accessibilityLabel="Show the next photo"
            aria-disabled={atLast}
            accessibilityState={{ disabled: atLast }}
            onPress={() => step(1)}
            hitSlop={10}
            style={({ pressed }) => [
              styles.stepBtn,
              atLast && styles.stepBtnOff,
              pressed && !atLast && { opacity: 0.7 },
            ]}
          >
            <Feather name="chevron-right" size={22} color="#FFFFFF" />
          </Pressable>
        </View>

        {renderAction ? (
          <View testID={`${testID}-action`} style={styles.actionRow}>
            {renderAction(current, position)}
          </View>
        ) : null}
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: LIGHTBOX_BACKDROP,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 18,
    paddingRight: 8,
  },
  position: {
    color: '#DDE5EF',
    fontSize: 12,
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  closeBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pager: {
    flex: 1,
  },
  page: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 6,
  },
  stepBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnOff: {
    opacity: 0.28,
  },
  captionWrap: {
    flex: 1,
    alignItems: 'center',
  },
  label: {
    color: '#FFFFFF',
    fontSize: 20,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  caption: {
    color: '#B9C6D6',
    fontSize: 12,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  actionRow: {
    alignItems: 'center',
    paddingTop: 10,
    paddingHorizontal: 18,
  },
});
