/**
 * Platform seams the billing screens share: opening an external page
 * (receipts, carrier tracking) and a destructive confirmation.
 */
import { Alert, Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

export async function openExternal(url: string): Promise<void> {
  if (Platform.OS !== 'web') {
    await WebBrowser.openBrowserAsync(url);
    return;
  }
  const opened = typeof window !== 'undefined' ? window.open(url, '_blank', 'noopener') : null;
  if (!opened) await Linking.openURL(url);
}

export function confirmDestructive(input: { title: string; message: string; confirmLabel: string; keepLabel: string }, proceed: () => void): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${input.title}\n\n${input.message}`)) proceed();
    return;
  }
  Alert.alert(input.title, input.message, [
    { text: input.keepLabel, style: 'cancel' },
    { text: input.confirmLabel, style: 'destructive', onPress: proceed },
  ]);
}
