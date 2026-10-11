/**
 * "Read the full text" row: three inline links that open the legal sheet.
 * Shared by the consent screen and Account → Privacy & data so both open
 * the same reader for the same documents.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { LegalDocumentSheet } from '@/components/legal/LegalDocumentSheet';
import type { LegalDocumentSlug } from '@/lib/legal-documents';

const LINKS: readonly { slug: LegalDocumentSlug; label: string }[] = [
  { slug: 'terms', label: 'Terms of use' },
  { slug: 'privacy', label: 'Privacy policy' },
  { slug: 'health-data', label: 'Health data notice' },
];

interface LegalLinksProps {
  testIDPrefix: string;
  style?: object;
  /** Policy version the reader must show; see LegalDocumentSheet. */
  requiredVersion?: string | null;
}

export function LegalLinks({ testIDPrefix, style, requiredVersion = null }: LegalLinksProps) {
  const colors = useColors();
  const [open, setOpen] = useState<LegalDocumentSlug | null>(null);
  return (
    <View style={[styles.row, style]}>
      <Text style={[styles.lead, { color: colors.labelText }]}>Read the full text:</Text>
      {LINKS.map(link => (
        <Pressable
          key={link.slug}
          testID={`${testIDPrefix}-read-${link.slug}`}
          accessibilityRole="button"
          accessibilityLabel={`Read the full ${link.label}`}
          hitSlop={6}
          onPress={() => setOpen(link.slug)}
        >
          <Text style={[styles.link, { color: colors.primary }]}>{link.label}</Text>
        </Pressable>
      ))}
      <LegalDocumentSheet slug={open} onClose={() => setOpen(null)} requiredVersion={requiredVersion} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4 },
  lead: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  link: { fontSize: 12.5, fontFamily: 'Inter_600SemiBold', textDecorationLine: 'underline' },
});
