import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, Alert } from 'react-native';
import { AppModal } from '@/components/ui/AppModal';
import { useColors } from '@/hooks/useColors';
import type { BloodworkResult } from '@/lib/bloodwork-types';

interface ResultEditModalProps {
  visible: boolean;
  result: BloodworkResult | null;
  onClose: () => void;
  onSave: (payload: {
    expectedVersion: number;
    testName: string | null;
    valueText: string | null;
    units: string | null;
    referenceRange: string | null;
    labFlag: string | null;
    uncertain: boolean;
  }) => Promise<void>;
}

export function ResultEditModal({ visible, result, onClose, onSave }: ResultEditModalProps) {
  const colors = useColors();
  
  const [testName, setTestName] = useState('');
  const [valueText, setValueText] = useState('');
  const [units, setUnits] = useState('');
  const [referenceRange, setReferenceRange] = useState('');
  const [labFlag, setLabFlag] = useState('');
  const [uncertain, setUncertain] = useState(false);
  
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible && result) {
      setTestName(result.testName || '');
      setValueText(result.valueText || '');
      setUnits(result.units || '');
      setReferenceRange(result.referenceRange || '');
      setLabFlag(result.labFlag || '');
      setUncertain(result.uncertain);
    }
  }, [visible, result]);

  const handleSave = async () => {
    if (!result) return;
    setBusy(true);
    try {
      await onSave({
        expectedVersion: result.version,
        testName: testName.trim() || null,
        valueText: valueText.trim() || null,
        units: units.trim() || null,
        referenceRange: referenceRange.trim() || null,
        labFlag: labFlag.trim() || null,
        uncertain,
      });
      onClose();
    } catch (e: any) {
      Alert.alert('Save Failed', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppModal visible={visible} onRequestClose={onClose} animationType="slide">
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Text style={[styles.closeText, { color: colors.subtleText }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.navyLight }]}>Edit Result</Text>
          <Pressable onPress={handleSave} disabled={busy} style={styles.saveBtn}>
            {busy ? <ActivityIndicator size="small" color={colors.cobalt} /> : <Text style={[styles.saveText, { color: colors.cobalt }]}>Save</Text>}
          </Pressable>
        </View>

        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.labelText }]}>TEST NAME</Text>
            <TextInput
              style={[styles.input, { borderColor: colors.border, color: colors.navy }]}
              value={testName}
              onChangeText={setTestName}
            />
          </View>
          
          <View style={styles.row}>
             <View style={[styles.field, { flex: 1 }]}>
               <Text style={[styles.label, { color: colors.labelText }]}>VALUE</Text>
               <TextInput
                 style={[styles.input, { borderColor: colors.border, color: colors.navy }]}
                 value={valueText}
                 onChangeText={setValueText}
               />
             </View>
             <View style={[styles.field, { flex: 1 }]}>
               <Text style={[styles.label, { color: colors.labelText }]}>UNITS</Text>
               <TextInput
                 style={[styles.input, { borderColor: colors.border, color: colors.navy }]}
                 value={units}
                 onChangeText={setUnits}
               />
             </View>
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.labelText }]}>REFERENCE RANGE</Text>
            <TextInput
              style={[styles.input, { borderColor: colors.border, color: colors.navy }]}
              value={referenceRange}
              onChangeText={setReferenceRange}
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.labelText }]}>LAB FLAG</Text>
            <TextInput
              style={[styles.input, { borderColor: colors.border, color: colors.navy }]}
              value={labFlag}
              onChangeText={setLabFlag}
              placeholder="e.g. H, L, Abnormal"
              placeholderTextColor={colors.subtleText}
            />
          </View>

          <Pressable 
             onPress={() => setUncertain(!uncertain)} 
             style={({pressed}) => [styles.checkboxRow, pressed && { opacity: 0.7 }]}
          >
             <View style={[styles.checkbox, uncertain && { backgroundColor: colors.cobalt, borderColor: colors.cobalt }, !uncertain && { borderColor: colors.border }]}>
               {uncertain && <Text style={{color:'#fff', fontSize:12}}>✓</Text>}
             </View>
             <Text style={[styles.checkLabel, { color: colors.navy }]}>Mark as uncertain</Text>
          </Pressable>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 50,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  closeBtn: { paddingVertical: 8, paddingRight: 16 },
  closeText: { fontSize: 16, fontFamily: 'Inter_400Regular' },
  title: { fontSize: 17, fontFamily: 'PlayfairDisplay_600SemiBold' },
  saveBtn: { paddingVertical: 8, paddingLeft: 16 },
  saveText: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  form: { padding: 16 },
  field: { marginBottom: 20 },
  label: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 1, marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    height: 48,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  row: { flexDirection: 'row', gap: 12 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  checkbox: {
    width: 22, height: 22,
    borderWidth: 1,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  checkLabel: { fontSize: 14, fontFamily: 'Inter_400Regular' },
});
