/**
 * Full-text reader for the Terms of Use, Privacy Policy and Health data
 * notice. Opens as a page sheet over the consent screen and Account; shows
 * the bundled copy immediately and, when that is not the required policy
 * version, swaps in the server copy of that version (or labels what it has
 * as outdated). Renders the shared markdown subset natively (no WebView), so
 * it reads the same offline as online.
 */
import React, { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  draftNotice,
  formatEffectiveDate,
  inlineText,
  parseLegalMarkdown,
  type LegalBlock,
  type LegalInline,
} from '@workspace/legal-documents';
import { AppModal } from '@/components/ui/AppModal';
import { PageScrollView } from '@/components/ui/PageScrollView';
import { useColors } from '@/hooks/useColors';
import {
  bundledLegalDocuments,
  loadLegalDocuments,
  type LegalDocumentSlug,
  type LoadedLegalDocuments,
} from '@/lib/legal-documents';

interface LegalDocumentSheetProps {
  /** Which document to show; null keeps the sheet closed. */
  slug: LegalDocumentSlug | null;
  onClose: () => void;
  /**
   * The policy version the patient is (or was) asked to agree to. The sheet
   * shows the copy carrying exactly that version when it can, and labels any
   * other copy as outdated. Null (no account state) → newest copy available.
   */
  requiredVersion?: string | null;
}

export function LegalDocumentSheet({ slug, onClose, requiredVersion = null }: LegalDocumentSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [loaded, setLoaded] = useState<LoadedLegalDocuments>(() => bundledLegalDocuments(requiredVersion));
  const visible = slug !== null;

  // Resolve once per open: no network when the bundled copy is the required
  // version; otherwise the API, falling back to the best copy on hand.
  useEffect(() => {
    if (!visible) return;
    let active = true;
    loadLegalDocuments(requiredVersion).then(result => { if (active) setLoaded(result); });
    return () => { active = false; };
  }, [visible, requiredVersion]);

  const document = slug ? loaded.bundle.documents.find(entry => entry.slug === slug) ?? null : null;
  const blocks = document ? parseLegalMarkdown(document.markdown) : [];
  const heading = blocks.find(block => block.type === 'heading' && block.level === 1);
  const title = heading && heading.type === 'heading' ? inlineText(heading.inlines) : document?.title ?? '';
  const notice = draftNotice(loaded.bundle.status);
  const outdated = !loaded.current && requiredVersion !== null
    ? `This is the version ${loaded.bundle.version} text. The current version (${requiredVersion}) could not be loaded — connect to the internet and open this again to read what you are agreeing to.`
    : null;
  const topPad = Platform.OS === 'web' ? 16 : insets.top + 8;

  return (
    <AppModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      testID="legal-sheet"
    >
      <View style={[styles.page, { backgroundColor: colors.background, paddingTop: topPad }]} testID={slug ? `legal-sheet-${slug}` : undefined}>
        <View style={[styles.bar, { borderBottomColor: colors.border }]}>
          <Text style={[styles.brand, { color: colors.navy }]}>THINNR</Text>
          <Pressable
            testID="legal-sheet-close"
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={10}
            onPress={onClose}
            style={({ pressed }) => [styles.close, { borderColor: colors.border, backgroundColor: colors.card, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[styles.closeText, { color: colors.navy }]}>Done</Text>
          </Pressable>
        </View>
        <PageScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]} testID="legal-sheet-scroll">
          <Text testID="legal-sheet-title" style={[styles.title, { color: colors.navy }]}>{title}</Text>
          <Text testID="legal-sheet-version" style={[styles.version, { color: colors.labelText }]}>
            Effective {formatEffectiveDate(loaded.bundle.effectiveDate)} · version {loaded.bundle.version}
            {loaded.source === 'server' ? ' · latest' : ''}
          </Text>
          {outdated ? (
            <View
              testID="legal-sheet-outdated"
              accessibilityRole="alert"
              style={[styles.notice, { backgroundColor: colors.warnBg, borderColor: colors.warnBorder, borderRadius: colors.radiusSm }]}
            >
              <Text style={[styles.noticeText, { color: colors.warnText }]}>{outdated}</Text>
            </View>
          ) : null}
          {notice ? (
            <View
              testID="legal-sheet-draft"
              accessibilityRole="text"
              style={[styles.notice, { backgroundColor: colors.warnBg, borderColor: colors.warnBorder, borderRadius: colors.radiusSm }]}
            >
              <Text style={[styles.noticeText, { color: colors.warnText }]}>{notice}</Text>
            </View>
          ) : null}
          {blocks.map((block, index) => <Block key={index} block={block} />)}
        </PageScrollView>
      </View>
    </AppModal>
  );
}

function Inlines({ inlines, color }: { inlines: LegalInline[]; color: string }) {
  const colors = useColors();
  return (
    <>
      {inlines.map((inline, index) => {
        if (inline.href) {
          const href = inline.href;
          return (
            <Text
              key={index}
              accessibilityRole="link"
              style={[styles.link, { color: colors.primary }]}
              onPress={() => { void Linking.openURL(href); }}
            >
              {inline.text}
            </Text>
          );
        }
        return (
          <Text key={index} style={inline.bold ? [styles.bold, { color: colors.foreground }] : { color }}>
            {inline.text}
          </Text>
        );
      })}
    </>
  );
}

function Block({ block }: { block: LegalBlock }) {
  const colors = useColors();
  if (block.type === 'heading') {
    if (block.level === 1) return null; // carried by the sheet title
    return (
      <Text
        testID="legal-sheet-body"
        accessibilityRole="header"
        style={[block.level === 2 ? styles.h2 : styles.h3, { color: colors.navy }]}
      >
        <Inlines inlines={block.inlines} color={colors.navy} />
      </Text>
    );
  }
  if (block.type === 'list') {
    return (
      <View style={styles.list}>
        {block.items.map((item, index) => (
          <View key={index} style={styles.listItem}>
            <Text style={[styles.bullet, { color: colors.labelText }]}>{block.ordered ? `${index + 1}.` : '•'}</Text>
            <Text testID="legal-sheet-body" style={[styles.body, styles.listText, { color: colors.bodyText }]}>
              <Inlines inlines={item} color={colors.bodyText} />
            </Text>
          </View>
        ))}
      </View>
    );
  }
  return (
    <Text testID="legal-sheet-body" style={[styles.body, { color: colors.bodyText }]}>
      <Inlines inlines={block.inlines} color={colors.bodyText} />
    </Text>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  brand: { fontSize: 18, fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: 3 },
  close: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  closeText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  content: { paddingHorizontal: 22, paddingTop: 18, maxWidth: 560, width: '100%', alignSelf: 'center' },
  title: { fontSize: 26, lineHeight: 32, fontFamily: 'PlayfairDisplay_700Bold' },
  version: { fontSize: 11, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.4, marginTop: 8 },
  notice: { borderWidth: 1, padding: 12, marginTop: 14 },
  noticeText: { fontSize: 12.5, lineHeight: 18, fontFamily: 'Inter_500Medium' },
  h2: { fontSize: 19, lineHeight: 25, fontFamily: 'PlayfairDisplay_700Bold', marginTop: 22 },
  h3: { fontSize: 15, lineHeight: 21, fontFamily: 'Inter_700Bold', marginTop: 14 },
  body: { fontSize: 14.5, lineHeight: 22, fontFamily: 'Inter_400Regular', marginTop: 12 },
  bold: { fontFamily: 'Inter_600SemiBold' },
  link: { fontFamily: 'Inter_600SemiBold', textDecorationLine: 'underline' },
  list: { marginTop: 6 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 6 },
  bullet: { width: 22, fontSize: 14.5, lineHeight: 22, fontFamily: 'Inter_600SemiBold', marginTop: 12 },
  listText: { flex: 1 },
});
