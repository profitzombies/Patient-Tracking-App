/**
 * Fallback for unknown routes, in the Heritage language: paper background,
 * serif title on a soft-radius card, cobalt primary action.
 */
import { Link, Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

const CARD_SHADOW = '0 8px 20px rgba(40, 55, 74, 0.07)';

export default function NotFoundScreen() {
  const colors = useColors();

  return (
    <>
      <Stack.Screen options={{ title: 'Oops!' }} />
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderRadius: colors.radius,
              boxShadow: CARD_SHADOW,
            },
          ]}
        >
          <View style={{ height: 3, alignSelf: 'stretch', backgroundColor: colors.cobalt, marginBottom: 20 }} />
          <Text style={[styles.title, { color: colors.navy }]}>
            This screen doesn&apos;t exist.
          </Text>

          <Link href="/" asChild>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
                Go to home screen!
              </Text>
            </Pressable>
          </Link>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    overflow: 'hidden',
    paddingHorizontal: 24,
    paddingBottom: 24,
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    lineHeight: 31,
    fontFamily: 'PlayfairDisplay_700Bold',
    textAlign: 'center',
  },
  button: {
    marginTop: 20,
    minHeight: 44,
    paddingVertical: 13,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
    fontFamily: 'Inter_700Bold',
  },
});
