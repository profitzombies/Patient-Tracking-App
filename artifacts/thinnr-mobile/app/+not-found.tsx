/**
 * Fallback for unknown routes. The card itself lives in
 * components/NotFoundCard so the staff route guard can show the same screen
 * for routes an office's kind does not include.
 */
import { Stack } from 'expo-router';
import { NotFoundCard } from '@/components/NotFoundCard';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Oops!' }} />
      <NotFoundCard />
    </>
  );
}
