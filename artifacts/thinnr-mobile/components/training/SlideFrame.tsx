/**
 * Native rendition of the web portal's typographic "workbook slide" frame.
 *
 * No video files exist anywhere in the demo, so a lesson's chapters step
 * through these 16:9 slides instead of footage. The palette rotates through
 * cream / navy / cobalt deterministically from the video id + chapter index
 * (same djb2 selection as the web), so the same chapter shows the same slide
 * on every surface.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { formatClock, slidePaletteFor, type TrainingVideo } from '@/lib/training';

interface SlideFrameProps {
  video: TrainingVideo;
  chapterIndex: number;
}

export function SlideFrame({ video, chapterIndex }: SlideFrameProps) {
  const colors = useColors();
  const chapterCount = Math.max(1, video.chapters.length);
  const safeIndex = Math.min(Math.max(0, chapterIndex), chapterCount - 1);
  // Defensive: seeded videos always carry chapters, but a chapterless video
  // still renders a title slide instead of crashing.
  const chapter = video.chapters[safeIndex] ?? { id: 'title', at: 0, title: video.title };

  const palette = slidePaletteFor(video.id, safeIndex);
  const frame =
    palette === 'navy'
      ? {
          bg: colors.navy,
          fg: '#fdfcf9', // paper, for contrast on the navy slide
          accent: colors.accent,
          soft: 'rgba(253, 252, 249, 0.65)',
          border: colors.navy,
        }
      : palette === 'cobalt'
        ? {
            bg: colors.accent,
            fg: colors.navy,
            accent: colors.cobalt,
            soft: colors.navyLight,
            border: colors.border,
          }
        : {
            bg: colors.card,
            fg: colors.navy,
            accent: colors.cobalt,
            soft: colors.subtleText,
            border: colors.border,
          };

  return (
    <View
      testID="slide-frame"
      style={[styles.frame, { backgroundColor: frame.bg, borderColor: frame.border }]}
    >
      <View style={styles.topRow}>
        <Text style={[styles.kicker, { color: frame.soft }]}>THINNR · OFFICE TRAINING</Text>
        <Text style={[styles.clock, { color: frame.soft }]}>{formatClock(chapter.at)}</Text>
      </View>
      <View style={styles.middle}>
        <Text style={[styles.number, { color: frame.accent }]}>
          {String(safeIndex + 1).padStart(2, '0')}
        </Text>
        <View style={[styles.rule, { backgroundColor: frame.accent }]} />
        <Text numberOfLines={2} style={[styles.chapterTitle, { color: frame.fg }]}>
          {chapter.title}
        </Text>
      </View>
      <View style={styles.bottomRow}>
        <Text numberOfLines={1} style={[styles.videoTitle, { color: frame.soft }]}>
          {video.title}
        </Text>
        <Text style={[styles.counter, { color: frame.soft }]}>
          {String(safeIndex + 1).padStart(2, '0')} / {String(chapterCount).padStart(2, '0')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    aspectRatio: 16 / 9,
    borderWidth: 1,
    borderRadius: 7,
    padding: 14,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  kicker: {
    fontSize: 8,
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  clock: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.4,
  },
  middle: {
    gap: 7,
  },
  number: {
    fontSize: 30,
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: 0.5,
  },
  rule: {
    height: 2,
    width: '18%',
    opacity: 0.85,
  },
  chapterTitle: {
    fontSize: 16,
    lineHeight: 21,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  videoTitle: {
    fontSize: 9,
    fontFamily: 'Inter_500Medium',
    flexShrink: 1,
  },
  counter: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.6,
  },
});
