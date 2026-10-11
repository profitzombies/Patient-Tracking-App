/**
 * Provider bloodwork for one patient, reached by deep link (`/patient/<id>`)
 * and from the report detail route beneath it. The live roster opens patient
 * records at `/office-patient/[id]`; only the bloodwork shell lives at this
 * route. The shell independently verifies the
 * signed-in office and that the patient is on its roster before it reads.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ProviderBloodworkPatientShell } from '@/components/bloodwork/ProviderBloodworkPatientPanel';

export default function PatientBloodworkScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ProviderBloodworkPatientShell patientId={typeof id === 'string' ? id : ''} />;
}
