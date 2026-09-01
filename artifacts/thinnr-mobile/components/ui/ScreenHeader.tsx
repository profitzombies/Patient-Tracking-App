/**
 * Safe-area-aware screen header for all THINNR tab screens.
 * Shows page title, search icon, notification icon, and SJ avatar.
 * Heritage language: paper surface, hairline bottom rule, serif page title.
 */
import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';

interface ScreenHeaderAction {
  icon: keyof typeof Feather.glyphMap;
  /** Accessible name — icon-only buttons MUST carry one. */
  label: string;
  onPress: () => void;
  testID?: string;
}

interface ScreenHeaderProps {
  title: string;
  onSearch?: (query: string) => void;
  /** Optional screen-specific action rendered ahead of the shared icons. */
  action?: ScreenHeaderAction;
}

export function ScreenHeader({ title, onSearch, action }: ScreenHeaderProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const toggleSearch = () => {
    Haptics.selectionAsync();
    if (searchOpen) {
      setQuery('');
      onSearch?.('');
    }
    setSearchOpen(v => !v);
  };

  const handleChangeText = (text: string) => {
    setQuery(text);
    onSearch?.(text);
  };

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.paperCardAlt,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          paddingTop: topPad,
        },
      ]}
    >
      <View style={styles.inner}>
        {/* Brand mark */}
        <View style={styles.brandRow}>
          <View style={[styles.brandMark, { backgroundColor: colors.navy }]}>
            <Text style={[styles.brandMarkText, { color: colors.brandMarkText }]}>TH</Text>
          </View>
          {!searchOpen && (
            <Text style={[styles.title, { color: colors.navy }]}>{title}</Text>
          )}
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          {searchOpen && (
            <TextInput
              autoFocus
              placeholder="Search..."
              placeholderTextColor={colors.subtleText}
              value={query}
              onChangeText={handleChangeText}
              style={[
                styles.searchInput,
                {
                  color: colors.foreground,
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                },
              ]}
              testID="header-search-input"
            />
          )}
          {action && !searchOpen && (
            <Pressable
              testID={action.testID}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={() => {
                Haptics.selectionAsync();
                action.onPress();
              }}
              style={({ pressed }) => [
                styles.iconBtn,
                { borderColor: colors.cobalt, backgroundColor: pressed ? colors.accent : colors.card },
              ]}
            >
              <Feather name={action.icon} size={16} color={colors.cobalt} />
            </Pressable>
          )}
          <Pressable
            testID="header-search-btn"
            onPress={toggleSearch}
            style={({ pressed }) => [
              styles.iconBtn,
              { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
            ]}
          >
            <Feather name={searchOpen ? 'x' : 'search'} size={16} color={colors.bodyText} />
          </Pressable>
          <Pressable
            testID="header-notifications-btn"
            onPress={() => Haptics.selectionAsync()}
            style={({ pressed }) => [
              styles.iconBtn,
              { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
            ]}
          >
            <Feather name="bell" size={16} color={colors.bodyText} />
          </Pressable>
          {/* SJ Avatar — opens the persona switcher */}
          <Pressable
            testID="header-avatar-btn"
            onPress={() => {
              Haptics.selectionAsync();
              router.push('/persona');
            }}
            style={({ pressed }) => [
              styles.avatar,
              { backgroundColor: colors.cobalt },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={[styles.avatarText, { color: colors.primaryForeground }]}>SJ</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** Bottom synthetic data disclaimer, placed inside scroll content */
export function SyntheticDisclaimer() {
  const colors = useColors();
  return (
    <View style={[styles.disclaimer, { borderTopWidth: 1, borderTopColor: colors.divider }]}>
      <Text style={[styles.disclaimerText, { color: colors.labelText }]}>
        SYNTHETIC DEMO DATA  •  NOT MEDICAL ADVICE
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    zIndex: 10,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    paddingTop: 10,
    minHeight: 44,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  brandMark: {
    width: 30,
    height: 30,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 16,
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: 0.2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  searchInput: {
    height: 32,
    width: 140,
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 10,
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  iconBtn: {
    width: 32,
    height: 32,
    borderWidth: 1,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  disclaimer: {
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  disclaimerText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.6,
    fontFamily: 'Inter_700Bold',
  },
});
