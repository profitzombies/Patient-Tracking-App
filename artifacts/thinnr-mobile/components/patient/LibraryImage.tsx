/**
 * Fixed-frame image treatment for Library cards.
 *
 * A card must not jump when an image is slow, missing, or unavailable.  The
 * placeholder stays in the frame until expo-image reports a real `onLoad`;
 * neither a timer nor the presence of a URI is treated as proof that an image
 * rendered.  Failed loads intentionally keep the accessible placeholder
 * visible instead of inventing a replacement image.
 */
import React, { useState, type ComponentProps } from 'react';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useColors } from '@/hooks/useColors';

export type LibraryImageStatus = 'loading' | 'loaded' | 'error';
export type LibraryImageSource = NonNullable<ComponentProps<typeof Image>['source']>;

/**
 * Kept as a tiny pure helper so route/UI regression checks can verify the
 * important contract without mounting native image primitives.
 */
export function isLibraryImagePlaceholderVisible(status: LibraryImageStatus): boolean {
  return status !== 'loaded';
}

export function LibraryImagePlaceholder({
  status,
  label,
  testID = 'library-image-placeholder',
}: {
  status: Exclude<LibraryImageStatus, 'loaded'>;
  label: string;
  testID?: string;
}) {
  const colors = useColors();
  const loading = status === 'loading';
  return (
    <View
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel={loading ? `Loading image for ${label}` : `Image unavailable for ${label}`}
      style={[StyleSheet.absoluteFill, styles.placeholder, { backgroundColor: colors.sidebarBg }]}
    >
      <Feather name={loading ? 'image' : 'x-circle'} size={20} color={colors.subtleText} />
      <Text style={[styles.placeholderText, { color: colors.subtleText }]}>
        {loading ? 'Loading image…' : 'Image unavailable'}
      </Text>
    </View>
  );
}

function LibraryImageContent({
  source,
  label,
  testID,
}: {
  source?: LibraryImageSource | null;
  label: string;
  testID: string;
}) {
  const [status, setStatus] = useState<LibraryImageStatus>(source ? 'loading' : 'error');

  return (
    <>
      {source ? (
        <Image
          testID={testID}
          source={source}
          accessible={false}
          style={[StyleSheet.absoluteFill, status === 'loaded' ? styles.imageVisible : styles.imageHidden]}
          contentFit="cover"
          transition={0}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
        />
      ) : null}
      {isLibraryImagePlaceholderVisible(status) ? (
        <LibraryImagePlaceholder
          status={status === 'loading' ? 'loading' : 'error'}
          label={label}
        />
      ) : null}
    </>
  );
}

export function LibraryImage({
  source,
  label,
  sourceKey,
  style,
  testID = 'library-image',
}: {
  source?: LibraryImageSource | null;
  /** Human-readable name used only by the accessible placeholder. */
  label: string;
  /**
   * Stable identity for the card's source.  Recipe cards pass the recipe id
   * or photo URI rather than an object literal, so a parent re-render cannot
   * restart a genuine in-flight image load.
   */
  sourceKey: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const sourceFingerprint =
    typeof source === 'string' || typeof source === 'number'
      ? String(source)
      : source && typeof source === 'object' && 'uri' in source
        ? String(source.uri ?? '')
        : '';
  const loadKey = `${sourceKey}:${sourceFingerprint}`;
  return (
    <View testID={`${testID}-frame`} style={[styles.frame, style]}>
      {/*
       * Keying the load state by source identity unmounts the old expo-image
       * before the new one can receive an onLoad. This prevents a slow old
       * request from resolving a changed recipe card (and prevents a one
       * frame flash of the old image while React effects catch up).
       */}
      <LibraryImageContent key={loadKey} source={source} label={label} testID={testID} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    position: 'relative',
    overflow: 'hidden',
    width: '100%',
    height: 108,
  },
  imageVisible: {
    opacity: 1,
  },
  imageHidden: {
    opacity: 0,
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  placeholderText: {
    fontSize: 9,
    fontFamily: 'Inter_500Medium',
  },
});