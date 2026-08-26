/**
 * Lightweight markdown renderer for AI Support replies.
 *
 * The support persona answers in comprehensive markdown — headings, bullet
 * and numbered lists, bold — unlike the coach's plain texting style. The
 * operations web page renders it with react-markdown; on mobile this small
 * renderer covers the structures the persona actually produces and shows
 * anything else as literal text (never raw HTML). It re-parses the partial
 * text on every streamed delta, so an unclosed `**` simply renders raw
 * until its closer arrives — same behavior as the web page.
 */
import React, { useMemo } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullet'; items: string[] }
  | { kind: 'numbered'; items: { marker: string; text: string }[] }
  | { kind: 'rule' };

const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*\u2022]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let bullets: string[] | null = null;
  let numbered: { marker: string; text: string }[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
      paragraph = [];
    }
  };
  const flushLists = () => {
    if (bullets) {
      blocks.push({ kind: 'bullet', items: bullets });
      bullets = null;
    }
    if (numbered) {
      blocks.push({ kind: 'numbered', items: numbered });
      numbered = null;
    }
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) {
      flushParagraph();
      flushLists();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushLists();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    if (RULE.test(line)) {
      flushParagraph();
      flushLists();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      if (numbered) flushLists();
      bullets = bullets ?? [];
      bullets.push(bullet[1]);
      continue;
    }
    const item = NUMBERED.exec(line);
    if (item) {
      flushParagraph();
      if (bullets) flushLists();
      numbered = numbered ?? [];
      numbered.push({ marker: `${item[1]}.`, text: item[2] });
      continue;
    }
    if (bullets || numbered) {
      // A wrapped continuation line belongs to the item above it.
      if (bullets) bullets[bullets.length - 1] += ` ${line.trim()}`;
      if (numbered) numbered[numbered.length - 1].text += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushLists();
  return blocks;
}

/** Splits `**bold**` and `` `code` `` spans; everything else stays literal. */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function InlineText({
  text,
  style,
  boldColor,
  codeBackground,
}: {
  text: string;
  style: (object | undefined)[];
  boldColor: string;
  codeBackground: string;
}) {
  const parts = text.split(INLINE);
  return (
    <Text style={style}>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return (
            <Text key={index} style={[styles.bold, { color: boldColor }]}>
              {part.slice(2, -2)}
            </Text>
          );
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return (
            <Text key={index} style={[styles.code, { backgroundColor: codeBackground }]}>
              {part.slice(1, -1)}
            </Text>
          );
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </Text>
  );
}

export function SupportMarkdown({ text }: { text: string }) {
  const colors = useColors();
  const blocks = useMemo(() => parseBlocks(text), [text]);

  return (
    <View style={styles.stack}>
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return (
            <Text
              key={index}
              style={[
                block.level <= 2 ? styles.headingLarge : styles.headingSmall,
                { color: colors.navy },
                index > 0 && styles.headingSpacing,
              ]}
            >
              {block.text}
            </Text>
          );
        }
        if (block.kind === 'rule') {
          return (
            <View key={index} style={[styles.rule, { backgroundColor: colors.border }]} />
          );
        }
        if (block.kind === 'bullet') {
          return (
            <View key={index} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={itemIndex} style={styles.listRow}>
                  <View style={[styles.bulletMark, { backgroundColor: colors.cobalt }]} />
                  <InlineText
                    text={item}
                    style={[styles.body, styles.listText, { color: colors.navy }]}
                    boldColor={colors.navy}
                    codeBackground={colors.paperCardAlt}
                  />
                </View>
              ))}
            </View>
          );
        }
        if (block.kind === 'numbered') {
          return (
            <View key={index} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={itemIndex} style={styles.listRow}>
                  <Text style={[styles.numberMark, { color: colors.cobalt }]}>
                    {item.marker}
                  </Text>
                  <InlineText
                    text={item.text}
                    style={[styles.body, styles.listText, { color: colors.navy }]}
                    boldColor={colors.navy}
                    codeBackground={colors.paperCardAlt}
                  />
                </View>
              ))}
            </View>
          );
        }
        return (
          <InlineText
            key={index}
            text={block.text}
            style={[styles.body, { color: colors.navy }]}
            boldColor={colors.navy}
            codeBackground={colors.paperCardAlt}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: 8,
  },
  body: {
    fontSize: 14.5,
    lineHeight: 21,
    fontFamily: 'Inter_400Regular',
  },
  bold: {
    fontFamily: 'Inter_700Bold',
  },
  code: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 13,
  },
  headingLarge: {
    fontSize: 15.5,
    lineHeight: 21,
    fontFamily: 'Inter_700Bold',
  },
  headingSmall: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: 'Inter_600SemiBold',
  },
  headingSpacing: {
    marginTop: 4,
  },
  rule: {
    height: 1,
    marginVertical: 2,
  },
  list: {
    gap: 6,
  },
  listRow: {
    flexDirection: 'row',
    gap: 9,
  },
  bulletMark: {
    width: 4,
    height: 4,
    borderRadius: 1,
    marginTop: 8.5,
  },
  numberMark: {
    fontSize: 13.5,
    lineHeight: 21,
    fontFamily: 'Inter_600SemiBold',
    minWidth: 18,
  },
  listText: {
    flex: 1,
  },
});
