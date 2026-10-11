import React, { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useSupabaseSession } from '@/lib/supabase';
import { signOfficePatientPhotoPage, useGetOfficePatientRecord } from '@workspace/api-client-react';
import { useQuery } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { LedgerCard, MetricCard, SectionHeader, EmptyState } from '@/components/ui/LedgerPrimitives';
import { PhotoLightbox, LightboxPhoto } from '@/components/ui/PhotoLightbox';
import { Image } from 'expo-image';
import { CoachReviewPanel } from '@/components/office/CoachReviewPanel';
import { DietFactsCard } from '@/components/office/DietFacts';
import { Button } from '@/components/payments/primitives';

export default function LivePatientDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { session, sessionLoading } = useSupabaseSession();

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const returnToRoster = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/patients');
    }
  };

  const renderHeader = (title: string, showRefresh = false, onRefresh?: () => void) => (
    <View style={[styles.header, { paddingTop: topPad + 8, backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border }]}>
      <Pressable
        testID="live-patient-back"
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={returnToRoster}
        style={({ pressed }) => [
          styles.headerBtn,
          { backgroundColor: pressed ? colors.accent : colors.card, borderColor: colors.border },
        ]}
      >
        <Feather name="arrow-left" size={16} color={colors.bodyText} />
      </Pressable>
      <View style={styles.headerTitleContainer}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
          {title}
        </Text>
      </View>
      {showRefresh ? (
        <Pressable
          testID="live-patient-refresh"
          accessibilityRole="button"
          accessibilityLabel="Refresh record"
          onPress={onRefresh}
          style={({ pressed }) => [
            styles.headerBtn,
            { backgroundColor: pressed ? colors.accent : colors.card, borderColor: colors.border },
          ]}
        >
          <Feather name="refresh-cw" size={16} color={colors.bodyText} />
        </Pressable>
      ) : (
        <View style={styles.headerSpacer} />
      )}
    </View>
  );

  if (sessionLoading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]} testID="live-patient-loading">
        {renderHeader('Loading...', false)}
        <View style={styles.center}>
          <ActivityIndicator color={colors.cobalt} size="large" />
        </View>
      </View>
    );
  }

  if (!session?.user?.id || !session?.access_token) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]} testID="live-patient-error">
        {renderHeader('Access Denied', false)}
        <View style={styles.center}>
          <EmptyState
            icon={<Feather name="lock" size={48} color={colors.subtleText} />}
            title="Sign-in Required"
            body="You must be signed in to view live patient records."
          />
        </View>
      </View>
    );
  }

  const rawId = Array.isArray(id) ? id[0] : id;
  const safeId = rawId ? encodeURIComponent(rawId) : '';

  if (!safeId) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]} testID="live-patient-error">
        {renderHeader('Error', false)}
        <View style={styles.center}>
          <EmptyState
            icon={<Feather name="alert-triangle" size={48} color={colors.subtleText} />}
            title="Invalid ID"
            body="No patient ID was provided."
          />
        </View>
      </View>
    );
  }

  return (
    <LivePatientData 
      key={`${session.user.id}:${safeId}`}
      patientId={safeId} 
      rawId={rawId}
      session={session} 
      renderHeader={renderHeader} 
      colors={colors}
      bottomPad={Platform.OS === 'web' ? 84 + 20 : insets.bottom + 84 + 20}
    />
  );
}

function LivePatientData({
  patientId,
  rawId,
  session,
  renderHeader,
  colors,
  bottomPad,
}: {
  patientId: string;
  rawId: string;
  session: Session;
  renderHeader: (title: string, showRefresh?: boolean, onRefresh?: () => void) => React.ReactNode;
  colors: ReturnType<typeof useColors>;
  bottomPad: number;
}) {
  const router = useRouter();
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const { data, error, isLoading, refetch } = useGetOfficePatientRecord(
    patientId,
    undefined,
    {
      query: {
        enabled: true,
        queryKey: ['office-patient', rawId, session.user.id],
        retry: (failureCount, err) => {
          const status = err.status;
          if (status && status >= 400 && status < 500) return false;
          return failureCount < 2;
        },
        staleTime: 60000,
        refetchInterval: 60000,
        gcTime: 0,
      },
      request: {
        headers: { Authorization: `Bearer ${session.access_token}` },
      },
    }
  );

  // Photo pages: ONE signing call per size instead of a redirect per <Image>.
  // Thumbnails load with the grid; medium only once the viewer opens. Either
  // page failing leaves the record's own (original) URLs in place.
  const photoIds = (data?.progressPhotos ?? []).filter(p => !!p.url).map(p => p.id);
  const thumbPage = useOfficePhotoPage(patientId, session, photoIds, 'thumb', true);
  const mediumPage = useOfficePhotoPage(patientId, session, photoIds, 'medium', lightboxOpen);

  if (isLoading && !error) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]} testID="live-patient-loading">
        {renderHeader('Loading...', false)}
        <View style={styles.center}>
          <ActivityIndicator color={colors.cobalt} size="large" />
        </View>
      </View>
    );
  }

  if (error) {
    const status = error.status;
    let title = 'Could not load record';
    let body = 'There was a problem fetching this patient.';
    let iconName: keyof typeof Feather.glyphMap = 'alert-circle';
    
    const isTerminal = status === 401 || status === 403 || status === 404 || status === 410;

    if (status === 401 || status === 403) {
      title = 'Access Denied';
      body = 'You do not have permission to view this patient record.';
      iconName = 'shield-off';
    } else if (status === 404) {
      title = 'Not Found';
      body = 'This patient record does not exist or is not in your office.';
      iconName = 'search';
    } else if (status === 410) {
      title = 'Deleted';
      body = 'This patient record has been deleted.';
      iconName = 'trash-2';
    }

    return (
      <View style={[styles.container, { backgroundColor: colors.background }]} testID="live-patient-error" accessibilityLiveRegion="polite">
        {renderHeader('Error', false)}
        <View style={styles.center}>
          <EmptyState 
            icon={<Feather name={iconName} size={48} color={colors.subtleText} />} 
            title={title} 
            body={body} 
          />
          {!isTerminal && (
            <Pressable 
              testID="live-patient-retry" 
              accessibilityRole="button"
              accessibilityLabel="Retry loading record"
              onPress={() => refetch()} 
              style={[styles.retryBtn, { backgroundColor: colors.cobalt }]}
            >
              <Text style={[styles.retryText, { color: colors.primaryForeground }]}>Retry</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  if (!data) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]} testID="live-patient-error">
        {renderHeader('No Data', true, () => refetch())}
        <View style={styles.center}>
          <EmptyState 
            icon={<Feather name="help-circle" size={48} color={colors.subtleText} />} 
            title="No Data" 
            body="The patient record is empty." 
          />
        </View>
      </View>
    );
  }

  const { identity, program } = data.patient;
  const engagement = data.engagement;

  const photos: LightboxPhoto[] = (data.progressPhotos || [])
    .filter(p => !!p.url)
    .map(p => ({
      key: p.id,
      // Viewer: the medium page when signed, else the record's original URL.
      uri: mediumPage.data?.get(p.id) ?? p.url!,
      label: p.label || 'Photo',
      caption: p.dateKey ? `Date: ${p.dateKey}` : undefined,
    }));
  const thumbFor = (id: string, original: string) => thumbPage.data?.get(id) ?? original;

  const weightHistory = [...(data.weights || [])].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  const checkIns = [...(data.checkIns || [])].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  const diaryEntries = [...(data.diary?.entries || [])].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  const waterHistory = [...(data.water || [])].sort((a, b) => b.dateKey.localeCompare(a.dateKey));

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]} testID="live-patient-record">
      {renderHeader(identity.name || 'Patient Record', true, () => refetch())}
      <ScrollView contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomPad }]}>
        
        {/* Identity & Program */}
        <View style={styles.section}>
          <Text style={[styles.detailText, { color: colors.subtleText }]}>{data.office.officeName} · Live patient record</Text>
          <Text testID="live-patient-name" style={[styles.title, { color: colors.foreground }]}>
            {identity.name}
          </Text>
          <Text style={[styles.subtitle, { color: colors.bodyText }]}>
            {identity.email || 'No email'} • {identity.phoneDisplay || identity.phone || 'No phone'}
          </Text>
          <Text style={[styles.detailText, { color: colors.subtleText }]}>
            Born {identity.dateOfBirth ?? 'Not recorded'} · Height {identity.height ?? 'Not recorded'}
          </Text>
          <Text style={[styles.detailText, { color: colors.subtleText }]}>
            Program started {program.startDate ?? 'Not recorded'}
          </Text>
          <Button
            label="Sell to patient"
            accessibilityLabel={`Sell to ${identity.name || 'patient'}`}
            testID="button-sell-to-patient"
            variant="primary"
            onPress={() => router.push({ pathname: '/sell-to-patient', params: { patientId: rawId, name: identity.name || 'Patient' } })}
            style={{ alignSelf: 'flex-start', marginTop: 12 }}
          />
        </View>

        <View style={styles.row}>
          <MetricCard
            style={styles.flex1}
            label="Current Weight (lbs)"
            value={program.currentWeight != null ? String(program.currentWeight) : '--'}
            change=""
            detail={program.startingWeight != null ? `Started at ${program.startingWeight} lbs` : 'No starting weight'}
          />
          <MetricCard
            style={styles.flex1}
            label="Goal Weight (lbs)"
            value={program.goalWeight != null ? String(program.goalWeight) : '--'}
            change=""
            detail={program.weightChange != null ? `Change: ${program.weightChange > 0 ? '+' : ''}${program.weightChange} lbs` : '--'}
          />
        </View>

        <View style={styles.row}>
          <MetricCard
            style={styles.flex1}
            label="Stage"
            value={program.stage ? program.stage.charAt(0).toUpperCase() + program.stage.slice(1) : '--'}
            change=""
            detail={program.week != null ? `Week ${program.week}` : '--'}
          />
          <MetricCard
            style={styles.flex1}
            label="Day"
            value={program.day != null ? String(program.day) : '--'}
            change=""
            detail={identity.activationStatus ?? '--'}
          />
        </View>

        {/* Diet & food preferences (read-only facts; actions live in the office web app) */}
        {!data.patient.closure && (
          <View style={styles.section}>
            <SectionHeader label="Diet & food preferences" />
            <DietFactsCard
              patientId={identity.id}
              facts={data.patient.diet}
              stage={program.stage ?? null}
              week={program.week ?? null}
            />
          </View>
        )}

        {/* Engagement Signals */}
        {engagement && (
          <View style={styles.section}>
            <SectionHeader label="Engagement Signals" />
            <LedgerCard>
              <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.infoLabel, { color: colors.bodyText }]}>As of Date</Text>
                <Text style={[styles.infoValue, { color: colors.foreground }]}>{engagement.asOfDate || '--'}</Text>
              </View>
              <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.infoLabel, { color: colors.bodyText }]}>Logged Days (Last 7)</Text>
                <Text style={[styles.infoValue, { color: colors.foreground }]}>{engagement.loggedDays7 ?? '--'}</Text>
              </View>
              <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.infoLabel, { color: colors.bodyText }]}>Meal Streak</Text>
                <Text style={[styles.infoValue, { color: colors.foreground }]}>{engagement.mealStreak ?? '--'}</Text>
              </View>
              <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.infoLabel, { color: colors.bodyText }]}>Avg Calories (Last 7)</Text>
                <Text style={[styles.infoValue, { color: colors.foreground }]}>{engagement.avgCalories7 ?? '--'}</Text>
              </View>
              <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.infoLabel, { color: colors.bodyText }]}>Avg Water (Last 7)</Text>
                <Text style={[styles.infoValue, { color: colors.foreground }]}>{engagement.avgWater7 ?? '--'} oz</Text>
              </View>
              <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.infoLabel, { color: colors.bodyText }]}>Check-in Streak</Text>
                <Text style={[styles.infoValue, { color: colors.foreground }]}>{engagement.checkInStreak ?? '--'}</Text>
              </View>
              <View style={[styles.infoRow, { borderBottomColor: colors.border, borderBottomWidth: 0 }]}>
                <Text style={[styles.infoLabel, { color: colors.bodyText }]}>Check-in Rate (30 Days)</Text>
                <Text style={[styles.infoValue, { color: colors.foreground }]}>{engagement.checkInRate30 != null ? `${engagement.checkInRate30}%` : '--'}</Text>
              </View>
            </LedgerCard>
          </View>
        )}

        {/* Diary Nutrition */}
        <View style={styles.section}>
          <SectionHeader label="Overall Nutrition" />
          {data.diary?.nutritionTotals?.overall ? (
            <LedgerCard>
              <View style={styles.nutritionGrid}>
                <View style={styles.nutItem}>
                  <Text style={[styles.nutVal, { color: colors.foreground }]}>{data.diary.nutritionTotals.overall.calories || 0}</Text>
                  <Text style={[styles.nutLbl, { color: colors.bodyText }]}>kcal</Text>
                </View>
                <View style={styles.nutItem}>
                  <Text style={[styles.nutVal, { color: colors.foreground }]}>{data.diary.nutritionTotals.overall.protein || 0}g</Text>
                  <Text style={[styles.nutLbl, { color: colors.bodyText }]}>Protein</Text>
                </View>
                <View style={styles.nutItem}>
                  <Text style={[styles.nutVal, { color: colors.foreground }]}>{data.diary.nutritionTotals.overall.carbs || 0}g</Text>
                  <Text style={[styles.nutLbl, { color: colors.bodyText }]}>Carbs</Text>
                </View>
                <View style={styles.nutItem}>
                  <Text style={[styles.nutVal, { color: colors.foreground }]}>{data.diary.nutritionTotals.overall.fat || 0}g</Text>
                  <Text style={[styles.nutLbl, { color: colors.bodyText }]}>Fat</Text>
                </View>
              </View>
            </LedgerCard>
          ) : (
            <Text style={[styles.emptyText, { color: colors.subtleText }]}>No nutrition totals available.</Text>
          )}
        </View>

        {/* Diary Entries */}
        <View style={styles.section}>
          <SectionHeader label="Diary Entries" />
          {diaryEntries.length > 0 ? (
            <LedgerCard>
              {diaryEntries.map((entry, i) => (
                <View key={entry.id || `${entry.dateKey}-${i}`} style={[styles.expandedRow, { borderBottomColor: colors.border, borderBottomWidth: i === diaryEntries.length - 1 ? 0 : StyleSheet.hairlineWidth }]}>
                  <Text style={[styles.infoValue, { color: colors.foreground }]}>
                    {typeof entry.name === 'string' && entry.name ? entry.name : 'Unnamed food'}
                  </Text>
                  <View style={styles.rowHeader}>
                    <Text style={[styles.infoLabel, { color: colors.bodyText }]}>
                      {entry.dateKey}{typeof entry.meal === 'string' ? ` · ${entry.meal}` : ''}
                    </Text>
                    <Text style={[styles.infoValue, { color: colors.foreground }]}>{entry.detail}</Text>
                  </View>
                  <Text style={[styles.detailText, { color: colors.subtleText }]}>
                    Qty: {entry.quantity} | {entry.calories} kcal | {entry.protein}g P | {entry.carbs}g C | {entry.fat}g F
                  </Text>
                </View>
              ))}
            </LedgerCard>
          ) : (
            <Text style={[styles.emptyText, { color: colors.subtleText }]}>No diary entries.</Text>
          )}
        </View>

        {/* Water History */}
        <View style={styles.section}>
          <SectionHeader label="Water History" />
          {waterHistory.length > 0 ? (
            <LedgerCard>
              {waterHistory.map((w, i) => (
                <View key={`${w.dateKey}-${i}`} style={[styles.infoRow, { borderBottomColor: colors.border, borderBottomWidth: i === waterHistory.length - 1 ? 0 : StyleSheet.hairlineWidth }]}>
                  <Text style={[styles.infoLabel, { color: colors.bodyText }]}>{w.dateKey}</Text>
                  <Text style={[styles.infoValue, { color: colors.foreground }]}>{w.oz} oz</Text>
                </View>
              ))}
            </LedgerCard>
          ) : (
            <Text style={[styles.emptyText, { color: colors.subtleText }]}>No water logs.</Text>
          )}
        </View>

        {/* Check-ins */}
        <View style={styles.section}>
          <SectionHeader label="Check-ins" />
          {checkIns.length > 0 ? (
            <LedgerCard>
              {checkIns.map((ci, i) => (
                <View key={ci.id} style={[styles.expandedRow, { borderBottomColor: colors.border, borderBottomWidth: i === checkIns.length - 1 ? 0 : StyleSheet.hairlineWidth }]}>
                  <View style={styles.rowHeader}>
                    <Text style={[styles.infoLabel, { color: colors.bodyText }]}>{ci.dateKey}</Text>
                    <Text style={[styles.infoValue, { color: colors.foreground }]}>
                      Mood: {ci.mood ?? '--'} {ci.weight != null ? ` • ${ci.weight} lbs` : ''}
                    </Text>
                  </View>
                  {ci.notes ? (
                    <Text style={[styles.noteText, { color: colors.foreground }]}>
                      {ci.notes}
                    </Text>
                  ) : null}
                  {ci.sideEffects?.length ? (
                    <Text style={[styles.noteText, { color: colors.subtleText }]}>
                      Side effects: {ci.sideEffects.filter((value): value is string => typeof value === 'string').join(', ')}
                    </Text>
                  ) : null}
                </View>
              ))}
            </LedgerCard>
          ) : (
            <Text style={[styles.emptyText, { color: colors.subtleText }]}>No check-ins.</Text>
          )}
        </View>

        {/* Weight History */}
        <View style={styles.section}>
          <SectionHeader label="Weight History" />
          {weightHistory.length > 0 ? (
            <LedgerCard>
              {weightHistory.map((w, i) => (
                <View key={`${w.dateKey}-${i}`} style={[styles.infoRow, { borderBottomColor: colors.border, borderBottomWidth: i === weightHistory.length - 1 ? 0 : StyleSheet.hairlineWidth }]}>
                  <Text style={[styles.infoLabel, { color: colors.bodyText }]}>{w.dateKey}</Text>
                  <Text style={[styles.infoValue, { color: colors.foreground }]}>{w.weight} lbs</Text>
                </View>
              ))}
            </LedgerCard>
          ) : (
            <Text style={[styles.emptyText, { color: colors.subtleText }]}>No weight records.</Text>
          )}
        </View>

        {/* Progress Photos */}
        <View style={styles.section}>
          <SectionHeader label="Progress Photos" />
          {photos.length > 0 ? (
            <View style={styles.photoGrid}>
              {photos.map((photo, i) => (
                <Pressable
                  key={photo.key}
                  testID={`live-patient-photo-${photo.key}`}
                  accessibilityRole="imagebutton"
                  accessibilityLabel={`View ${photo.label} photo`}
                  onPress={() => {
                    setLightboxIndex(i);
                    setLightboxOpen(true);
                  }}
                  style={[styles.photoWrap, { borderColor: colors.border, backgroundColor: colors.muted }]}
                >
                  <Image source={{ uri: thumbFor(photo.key, photo.uri) }} style={styles.thumbnail} contentFit="cover" />
                  <View style={[styles.photoLabelWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Text style={[styles.photoLabel, { color: colors.foreground }]} numberOfLines={1}>{photo.label}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : (
            <Text style={[styles.emptyText, { color: colors.subtleText }]}>No progress photos.</Text>
          )}
        </View>

        {/* Coach Review */}
        <CoachReviewPanel key={`${patientId}:${session.user.id}`} patientId={patientId} session={session} />

      </ScrollView>

      {/* Lightbox for Photos */}
      {photos.length > 0 && (
        <PhotoLightbox
          visible={lightboxOpen}
          photos={photos}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </View>
  );
}

/**
 * Signs one page of a patient's progress photos at a display size, keyed on
 * the exact id list so a new upload re-signs once. Failures are silent by
 * design: callers fall back to the record's original URLs.
 */
function useOfficePhotoPage(
  patientId: string,
  session: Session,
  photoIds: string[],
  variant: 'thumb' | 'medium',
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['office-patient-photo-page', patientId, session.user.id, variant, photoIds.join(',')],
    enabled: enabled && photoIds.length > 0,
    staleTime: 20 * 60 * 1000,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const map = new Map<string, string>();
      for (let i = 0; i < photoIds.length; i += 100) {
        const page = await signOfficePatientPhotoPage(
          patientId,
          { ids: photoIds.slice(i, i + 100), variant },
          undefined,
          { headers: { Authorization: `Bearer ${session.access_token}` } },
        );
        for (const item of page.urls) map.set(item.id, item.url);
      }
      return map;
    },
  });
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerSpacer: {
    width: 36,
    height: 36,
  },
  headerTitleContainer: {
    flex: 1,
    paddingHorizontal: 12,
  },
  headerTitle: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    textAlign: 'center',
  },
  scrollContent: {
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontFamily: fonts.serif,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  row: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  flex1: {
    flex: 1,
  },
  infoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  expandedRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  infoLabel: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
  },
  infoValue: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  detailText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  noteText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    marginTop: 4,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
  },
  nutritionGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 8,
  },
  nutItem: {
    alignItems: 'center',
  },
  nutVal: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
  },
  nutLbl: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    marginTop: 2,
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  photoWrap: {
    width: '47%',
    aspectRatio: 1,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    overflow: 'hidden',
  },
  thumbnail: {
    flex: 1,
    width: '100%',
  },
  photoLabelWrap: {
    padding: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  photoLabel: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: theme.radiusSm,
  },
  retryText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
});
