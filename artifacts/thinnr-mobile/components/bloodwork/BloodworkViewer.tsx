import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import type { BloodworkDetail } from '@workspace/api-client-react';
import { getGetBloodworkFilePageUrl } from '@workspace/api-client-react';
import { AppModal } from '@/components/ui/AppModal';
import { ZoomableImage } from '@/components/bloodwork/ZoomableImage';
import { useColors } from '@/hooks/useColors';
import { resolveBloodworkSourceUrl } from '@/lib/bloodwork-url';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BloodworkSourcePageSkeleton } from '@/components/bloodwork/BloodworkSkeletons';

interface BloodworkViewerProps {
  visible: boolean;
  onClose: () => void;
  reportDetail: BloodworkDetail | null;
  token: string;
  patientId: string;
  officeId?: string;
  initialIndex?: number;
}

export function BloodworkViewer({
  visible,
  onClose,
  reportDetail,
  token,
  patientId,
  officeId,
  initialIndex = 0,
}: BloodworkViewerProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomInset = Platform.OS === 'web' ? Math.max(insets.bottom, 34) : insets.bottom;
  const [index, setIndex] = useState(initialIndex);
  const [webUri, setWebUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const pageRequestRef = useRef(0);

  const pages = useMemo(() => {
    if (!reportDetail) return [];
    return [...reportDetail.files]
      .sort((a, b) => a.position - b.position)
      .flatMap((file, fileIndex) => Array.from({ length: file.pageCount }, (_, offset) => ({
        key: `${file.id}:${offset + 1}`,
        url: resolveBloodworkSourceUrl(getGetBloodworkFilePageUrl(
          patientId,
          reportDetail.report.id,
          file.id,
          offset + 1,
          officeId ? { office: officeId } : undefined,
        )),
        label: reportDetail.report.kind === 'pdf' ? `Page ${offset + 1}` : `Image ${fileIndex + 1}`,
      })));
  }, [officeId, patientId, reportDetail]);

  useEffect(() => {
    if (visible) setIndex(Math.min(initialIndex, Math.max(0, pages.length - 1)));
  }, [initialIndex, pages.length, visible]);

  const page = pages[index];
  const tooLarge = pages.length > 100;
  const pageKey = page?.key ?? null;
  const pageUrl = page?.url ?? null;
  const imageIdentity = `${pageKey ?? 'source'}:${pageUrl ?? ''}:${retryNonce}:${token}`;
  const imageIdentityRef = useRef(imageIdentity);
  // Update during render so a late native image event from the previous
  // rendered image is rejected even before the next effect runs.
  imageIdentityRef.current = imageIdentity;
  useEffect(() => {
    const requestId = ++pageRequestRef.current;
    const requestIdentity = imageIdentity;
    setError(null);
    setWebUri(null);
    setPageLoading(Boolean(visible && pageKey && pageUrl && !tooLarge));
    if (!visible || !pageKey || !pageUrl || tooLarge) {
      setPageLoading(false);
      return;
    }
    if (!token) {
      setPageLoading(false);
      setError('Source access is unavailable. Refresh your sign-in and try again.');
      return;
    }
    if (Platform.OS !== 'web') return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void fetch(pageUrl, {
      headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-store' },
      cache: 'no-store',
      signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(`The source page could not be loaded (${response.status}).`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) throw new Error('The source page returned an unsupported file.');
      const nextObjectUrl = URL.createObjectURL(await response.blob());
      if (
        controller.signal.aborted
        || requestId !== pageRequestRef.current
        || imageIdentityRef.current !== requestIdentity
      ) {
        URL.revokeObjectURL(nextObjectUrl);
        return;
      }
      objectUrl = nextObjectUrl;
      setWebUri(nextObjectUrl);
    }).catch(reason => {
      if (!controller.signal.aborted && requestId === pageRequestRef.current && imageIdentityRef.current === requestIdentity) {
        setPageLoading(false);
        setError(reason instanceof Error ? reason.message : 'The source page could not be loaded.');
      }
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageIdentity, pageKey, pageUrl, retryNonce, token, tooLarge, visible]);

  const uri = Platform.OS === 'web' ? webUri : page?.url ?? null;
  const imageLoading = !tooLarge && !error && pageLoading;

  return (
    <AppModal visible={visible} onRequestClose={onClose} animationType="fade" transparent>
      <View style={styles.root}>
        <View style={[styles.top, { paddingTop: topInset }]}>
          <Text style={styles.title}>{reportDetail?.report.title ?? 'Bloodwork source'}</Text>
          <Pressable testID="bloodwork-viewer-close" onPress={onClose} style={styles.control} accessibilityLabel="Close bloodwork viewer">
            <Feather name="x" size={22} color={colors.navy} />
          </Pressable>
        </View>
        {tooLarge ? (
          <Text style={styles.error}>This document exceeds the 100-page in-app viewing limit.</Text>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.error}>{error}</Text>
            <Pressable testID="bloodwork-source-retry" onPress={() => setRetryNonce(value => value + 1)} style={styles.retry}>
              <Text style={{ color: colors.cobalt }}>Try again</Text>
            </Pressable>
          </View>
        ) : !uri ? (
          imageLoading ? <BloodworkSourcePageSkeleton /> : <ActivityIndicator color={colors.cobalt} style={styles.center} />
        ) : (
          <>
            {imageLoading ? <BloodworkSourcePageSkeleton /> : null}
            <View style={imageLoading ? styles.hiddenImage : styles.loadedImage}>
              <ZoomableImage
                key={`${page?.key ?? 'source'}:${retryNonce}`}
                uri={uri}
                headers={Platform.OS === 'web' ? undefined : { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-store' }}
                label={`${page?.label ?? ''} · ${index + 1} of ${pages.length}`}
                cachePolicy="none"
                onLoadStart={() => {
                  if (imageIdentityRef.current === imageIdentity) setPageLoading(true);
                }}
                onLoad={() => {
                  if (imageIdentityRef.current === imageIdentity) setPageLoading(false);
                }}
                onError={() => {
                  if (imageIdentityRef.current === imageIdentity) {
                    setPageLoading(false);
                    setError('The source page could not be displayed. Try loading it again.');
                  }
                }}
              />
            </View>
          </>
        )}
        {!tooLarge && pages.length > 1 ? (
          <View style={[styles.pager, { paddingBottom: Math.max(bottomInset, 12) }]}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous source page" disabled={index === 0} onPress={() => setIndex(value => value - 1)} style={[styles.control, index === 0 && styles.disabled]}>
              <Feather name="chevron-left" size={22} color={colors.navy} />
            </Pressable>
            <Text style={styles.pageText}>{index + 1} / {pages.length}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Next source page" disabled={index === pages.length - 1} onPress={() => setIndex(value => value + 1)} style={[styles.control, index === pages.length - 1 && styles.disabled]}>
              <Feather name="chevron-right" size={22} color={colors.navy} />
            </Pressable>
          </View>
        ) : null}
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111820' },
  top: { minHeight: 64, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fdfcf9' },
  title: { color: '#203b64', fontSize: 15, fontFamily: 'Inter_600SemiBold', flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  error: { color: '#ffffff', padding: 24, textAlign: 'center', fontSize: 14 },
  retry: { padding: 12, backgroundColor: '#fdfcf9', borderRadius: 8 },
  pager: { flexShrink: 0, paddingTop: 8, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 12 },
  control: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: '#fdfcf9' },
  disabled: { opacity: 0.4 },
  pageText: { color: '#ffffff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  hiddenImage: { ...StyleSheet.absoluteFill, opacity: 0 },
  loadedImage: { flex: 1, width: '100%' },
});