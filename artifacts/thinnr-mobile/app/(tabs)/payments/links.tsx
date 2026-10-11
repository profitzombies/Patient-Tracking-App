import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { PaymentsScreen, type PaymentsLive } from '@/components/payments/PaymentsScreen';
import { Field, RadioGroup, Sheet, Toggle } from '@/components/payments/dialogs';
import { Body, Button, DetailList, Empty, ErrorBox, InlineNotice, LoadingBox, Panel, StatusPill } from '@/components/payments/primitives';
import { useOfficeBillingMutation, useOfficeLinks, useOfficePrices } from '@/hooks/useOfficeBilling';
import { useColors } from '@/hooks/useColors';
import { officeBilling } from '@/lib/office-billing-api';
import { formatDate, formatDateTime } from '@/lib/office-billing-format';
import type { OfficePrice, PatientSearchHit, PaymentLink, PaymentLinkInput, PaymentLinkUpdate } from '@/lib/office-billing-types';

const TITLE = 'Payment links';
const SUB = 'Share an office link or create a link locked to one patient.';
type Expiry = '' | '24' | '168' | '720';

export default function PaymentLinksScreen() {
  return (
    <PaymentsScreen
      section="links"
      title={TITLE}
      sub={SUB}
      live={(ctx) => <LinksQuery ctx={ctx} />}
    />
  );
}

function LinksQuery({ ctx }: { ctx: PaymentsLive }) {
  const links = useOfficeLinks(ctx.userId);
  const prices = useOfficePrices(ctx.userId);
  if (links.isPending || prices.isPending) return <LoadingBox label="Loading links…" testID="links-loading" />;
  if (links.isError || !links.data || prices.isError || !prices.data) {
    return <ErrorBox error={links.error ?? prices.error} retry={() => { void links.refetch(); void prices.refetch(); }} testID="links-error" />;
  }
  return <LinksView ctx={ctx} links={links.data.items} products={prices.data.products} />;
}

function LinksView({ ctx, links, products }: { ctx: PaymentsLive; links: PaymentLink[]; products: OfficePrice[] }) {
  const colors = useColors();
  const [q, setQ] = useState('');
  const [patients, setPatients] = useState<PatientSearchHit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [expires, setExpires] = useState<Expiry>('');
  const [single, setSingle] = useState(false);
  const [limit, setLimit] = useState('');
  const [productId, setProductId] = useState('');
  const [editing, setEditing] = useState<PaymentLink | null>(null);
  const [deactivating, setDeactivating] = useState<PaymentLink | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editExpiry, setEditExpiry] = useState('');
  const [editLimit, setEditLimit] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [validation, setValidation] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const offered = useMemo(() => products.filter((p) => p.active && p.offered && p.sell_price_cents != null), [products]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setPatients([]);
      setSearchError(null);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      officeBilling.searchPatients(q.trim(), { userId: ctx.userId }).then(
        (result) => { if (active) { setPatients(result.items); setSearchError(null); } },
        (error: unknown) => { if (active) { setPatients([]); setSearchError(error instanceof Error ? error.message : 'Patient search failed.'); } },
      );
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [ctx, q]);

  const create = useOfficeBillingMutation(ctx.userId, (body: PaymentLinkInput, scope) => officeBilling.createLink(body, scope), {
    onSuccess: ({ link }) => {
      setNotice({ tone: 'good', text: 'Link created. Share it with the payer.' });
      void Share.share({ message: link.url });
    },
    onError: (error) => setNotice({ tone: 'bad', text: `Link not created. ${error.message}` }),
  });
  const update = useOfficeBillingMutation(ctx.userId, ({ id, body }: { id: string; body: PaymentLinkUpdate }, scope) => officeBilling.updateLink(id, body, scope), {
    onSuccess: () => { setEditing(null); setNotice({ tone: 'good', text: 'Link updated' }); },
    onError: (error) => setNotice({ tone: 'bad', text: `Link not updated. ${error.message}` }),
  });
  const deactivate = useOfficeBillingMutation(ctx.userId, (id: string, scope) => officeBilling.deactivateLink(id, scope), {
    onSuccess: () => { setDeactivating(null); setNotice({ tone: 'good', text: 'Payment link deactivated.' }); },
    onError: (error) => setNotice({ tone: 'bad', text: `Link not deactivated. ${error.message}` }),
  });

  const createLink = (patientId: string | null) => {
    const max = single ? 1 : limit.trim() ? Number(limit) : null;
    if (max !== null && (!Number.isInteger(max) || max < 2) && !single) {
      setValidation('Use limit must be a whole number of 2 or more.');
      return;
    }
    setValidation(null);
    create.mutate({
      patient_id: patientId,
      expires_in_hours: expires ? Number(expires) : null,
      max_uses: max,
      product_id: productId || null,
    });
  };
  const openEdit = (link: PaymentLink) => {
    setEditing(link);
    setEditLabel(link.label ?? '');
    setEditExpiry(link.expires_at ?? '');
    setEditLimit(link.max_uses == null ? '' : String(link.max_uses));
    setEditActive(link.active);
    setValidation(null);
  };
  const saveEdit = () => {
    if (!editing) return;
    const max = editLimit.trim() ? Number(editLimit) : null;
    const expiry = editExpiry.trim() ? new Date(editExpiry) : null;
    if (max !== null && (!Number.isInteger(max) || max < 1)) {
      setValidation('Maximum uses must be a whole number of 1 or more.');
      return;
    }
    if (expiry && Number.isNaN(expiry.getTime())) {
      setValidation('Enter a valid expiry date and time.');
      return;
    }
    setValidation(null);
    update.mutate({ id: editing.id, body: { label: editLabel || null, expires_at: expiry ? expiry.toISOString() : null, max_uses: max, active: editActive } });
  };
  const selectedPatient = patients.find((patient) => patient.id === selected);
  const generic = links.find((link) => !link.patient_id && link.active);

  return (
    <>
      {notice ? <InlineNotice tone={notice.tone} testID="links-notice">{notice.text}</InlineNotice> : null}
      <Panel title="Office payment link">
        {generic ? (
          <>
            <Body testID="office-link-url" muted={false}>{generic.url}</Body>
            <View style={styles.actions}>
              <Button small label="Share link" testID="button-share-office-link" onPress={() => void Share.share({ message: generic.url })} />
              <Button small label="Open" testID="button-open-office-link" onPress={() => void Linking.openURL(generic.url)} />
            </View>
          </>
        ) : (
          <Button label="Create office link" variant="primary" testID="button-create-office-link" busy={create.isPending} onPress={() => createLink(null)} />
        )}
      </Panel>
      <Panel title="Patient payment link" sub="Search, choose a patient, then create their private link.">
        <Field label="Search patients" placeholder="Search patients" value={q} onChangeText={setQ} testID="input-patient-search" />
        {searchError ? <InlineNotice tone="bad" testID="patient-search-error">{searchError}</InlineNotice> : null}
        {patients.map((patient) => (
          <Pressable
            key={patient.id}
            testID={`patient-result-${patient.id}`}
            accessibilityRole="radio"
            accessibilityLabel={`${patient.name}${patient.email ? `, ${patient.email}` : ''}`}
            accessibilityState={{ checked: selected === patient.id }}
            onPress={() => setSelected(patient.id)}
            style={[styles.patient, { borderColor: selected === patient.id ? colors.cobalt : colors.border, backgroundColor: selected === patient.id ? colors.accent : colors.card }]}
          >
            <Text style={[styles.patientName, { color: colors.text }]}>{patient.name}</Text>
            {patient.email ? <Text style={[styles.small, { color: colors.subtleText }]}>{patient.email}</Text> : null}
          </Pressable>
        ))}
        <View style={styles.actions}>
          <Button label="Create and copy" variant="primary" testID="button-create-patient-link" disabled={!selected} busy={create.isPending} onPress={() => selected && createLink(selected)} />
          <Button label="Sell to patient" testID="button-sell-to-patient" disabled={!selectedPatient} onPress={() => {
            if (selectedPatient) router.push({ pathname: '/sell-to-patient', params: { patientId: selectedPatient.id, name: selectedPatient.name } } as never);
          }} />
        </View>
      </Panel>
      <Panel title="New link options" sub="These options apply to the next office or patient link you create.">
        <RadioGroup label="Expires" value={expires} onChange={setExpires}  testIDPrefix="select-link-expiry" options={[
          { value: '', label: 'Never' }, { value: '24', label: '24 hours' }, { value: '168', label: '7 days' }, { value: '720', label: '30 days' },
        ]} />
        <Toggle label="Single-use" value={single}  testID="toggle-link-single-use" onChange={(next) => { setSingle(next); if (next) setLimit(''); }} />
        <Field label="Up to N uses" placeholder="Unlimited" keyboardType="number-pad" value={single ? '' : limit} onChangeText={setLimit} editable={!single} testID="input-link-max-uses" />
        <RadioGroup label="Preselect a product" value={productId} onChange={setProductId}  testIDPrefix="select-link-product" options={[
          { value: '', label: 'Payer chooses' },
          ...offered.map((product) => ({ value: product.product_id, label: product.name })),
        ]} />
        {validation && !editing ? <InlineNotice tone="bad" testID="link-validation">{validation}</InlineNotice> : null}
      </Panel>
      <Panel title="Links">
        {links.length === 0 ? <Empty>No payment links yet.</Empty> : links.map((link) => (
          <View key={link.id} testID={`link-row-${link.id}`} style={[styles.linkCard, { borderColor: colors.border, backgroundColor: colors.paperCardAlt }, !link.usable && { opacity: 0.72 }]}>
            <Text style={[styles.linkTitle, { color: colors.navy }]}>{link.patient_name ?? link.label ?? 'Office link'}</Text>
            <StatusPill tone={link.usable ? 'good' : link.active ? 'warn' : 'neutral'}>{link.usable ? 'Usable' : link.active ? 'Unavailable' : 'Inactive'}</StatusPill>
            <Body testID={`link-url-${link.id}`} muted={false}>{link.url}</Body>
            <DetailList items={[
              { label: 'Kind', value: link.patient_id ? 'Patient link' : 'Office link' },
              { label: 'Uses', value: link.max_uses ? `${link.uses} of ${link.max_uses} used` : `${link.uses} ${link.uses === 1 ? 'use' : 'uses'}` },
              { label: 'Expires', value: link.expires_at ? (!link.usable && !(link.max_uses != null && link.uses >= link.max_uses) ? 'Expired' : `Expires ${formatDate(link.expires_at)}`) : 'Never' },
              { label: 'Product', value: link.product_name ?? 'Payer chooses' },
              { label: 'Last used', value: formatDateTime(link.last_used_at) },
            ]} />
            <View style={styles.actions}>
              <Button small label="Share link" testID={`button-share-link-${link.id}`} onPress={() => void Share.share({ message: link.url })} />
              <Button small label="Open" testID={`button-open-link-${link.id}`} onPress={() => void Linking.openURL(link.url)} />
              <Button small label="Edit" testID={`button-edit-link-${link.id}`}  onPress={() => openEdit(link)} />
              {link.active ? <Button small label="Deactivate" variant="danger" testID={`button-deactivate-link-${link.id}`}  onPress={() => setDeactivating(link)} /> : null}
            </View>
          </View>
        ))}
      </Panel>
      <Sheet open={Boolean(editing)} onClose={() => setEditing(null)} title="Edit payment link" sub="Change availability and use limits for this link." testID="edit-link-sheet" footer={<>
        <Button label="Close" onPress={() => setEditing(null)} />
        <Button label="Save" variant="primary" testID="button-save-link" busy={update.isPending} onPress={saveEdit} />
      </>}>
        <Field label="Label" value={editLabel} onChangeText={setEditLabel} testID="input-edit-link-label" />
        <Field label="Expiry" value={editExpiry} onChangeText={setEditExpiry} testID="input-edit-link-expiry" hint="Enter a date and time, or leave blank for never." />
        <Field label="Maximum uses" keyboardType="number-pad" value={editLimit} onChangeText={setEditLimit} placeholder="Unlimited" testID="input-edit-link-max-uses" />
        <Toggle label="Active" value={editActive} onChange={setEditActive} testID="toggle-edit-link-active" />
        {validation ? <InlineNotice tone="bad" testID="edit-link-validation">{validation}</InlineNotice> : null}
      </Sheet>
      <Sheet open={Boolean(deactivating)} onClose={() => setDeactivating(null)} title="Deactivate payment link?" sub="This link will stop accepting payments." testID="deactivate-link-sheet" footer={<>
        <Button label="Keep active" onPress={() => setDeactivating(null)} />
        <Button label="Deactivate" variant="danger" testID="button-confirm-deactivate-link" busy={deactivate.isPending} onPress={() => deactivating && deactivate.mutate(deactivating.id)} />
      </>}>
        <Body>Deactivate this payment link?</Body>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  patient: { borderWidth: 1, borderRadius: 7, padding: 10, gap: 2 },
  patientName: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  small: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  linkCard: { borderWidth: 1, borderRadius: 7, padding: 12, gap: 9 },
  linkTitle: { fontSize: 16, fontFamily: 'PlayfairDisplay_600SemiBold' },
});