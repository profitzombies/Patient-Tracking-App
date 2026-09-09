import React, { useRef } from 'react';
import { View, StyleSheet, Pressable, Text, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

interface ZoomableImageProps {
  uri: string;
  headers?: Record<string, string>;
  label?: string;
  cachePolicy?: 'none' | 'disk';
  onError?: () => void;
}

export function ZoomableImage({ uri, headers, label, cachePolicy = 'none', onError }: ZoomableImageProps) {
  const colors = useColors();
  const [scale, setScale] = React.useState(1);
  const scrollRef = useRef<ScrollView>(null);

  const zoomIn = () => setScale(s => Math.min(s + 0.5, 4));
  const zoomOut = () => setScale(s => Math.max(s - 0.5, 1));
  const reset = () => setScale(1);

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        horizontal
        style={styles.imageContainer}
        contentContainerStyle={{ minWidth: `${scale * 100}%` }}
        showsHorizontalScrollIndicator={scale > 1}
      >
        <ScrollView
          nestedScrollEnabled
          contentContainerStyle={{ minHeight: `${scale * 100}%`, minWidth: '100%' }}
          showsVerticalScrollIndicator={scale > 1}
        >
          <Image
            source={{ uri, headers }}
            style={[styles.webImage, { width: `${scale * 100}%`, height: `${scale * 100}%` }]}
            contentFit="contain"
            cachePolicy={cachePolicy}
            onError={onError}
          />
        </ScrollView>
      </ScrollView>
      <View style={styles.controls}>
        <Pressable onPress={zoomOut} style={[styles.btn, { backgroundColor: colors.card }]}>
          <Feather name="minus" size={20} color={colors.navy} />
        </Pressable>
        <Pressable onPress={reset} style={[styles.btn, { backgroundColor: colors.card }]}>
          <Feather name="refresh-ccw" size={16} color={colors.navy} />
        </Pressable>
        <Pressable onPress={zoomIn} style={[styles.btn, { backgroundColor: colors.card }]}>
          <Feather name="plus" size={20} color={colors.navy} />
        </Pressable>
      </View>
      {label && (
        <Text style={[styles.label, { color: colors.card }]}>{label} - Zoom: {Math.round(scale * 100)}%</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' },
  imageContainer: { flex: 1, width: '100%', overflow: 'hidden' },
  webImage: { minWidth: 300, minHeight: 500 },
  controls: {
    position: 'absolute',
    bottom: 40,
    flexDirection: 'row',
    gap: 16,
    padding: 8,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  btn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  label: { position: 'absolute', top: 16, left: 16, fontSize: 14, fontFamily: 'Inter_600SemiBold', backgroundColor: 'rgba(0,0,0,0.5)', padding: 4, borderRadius: 4 },
});
