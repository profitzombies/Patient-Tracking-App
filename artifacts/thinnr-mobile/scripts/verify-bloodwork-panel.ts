import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ProviderBloodworkPatientPanel, ProviderBloodworkPatientShell } from '../components/bloodwork/ProviderBloodworkPatientPanel';
import { setOfficeRoster } from './bloodwork-stubs/office-roster';
import { setSession } from './bloodwork-stubs/supabase-session';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function main(): Promise<void> {
  setSession({ session: null, sessionLoading: false });
  setOfficeRoster({ status: 'unavailable', roster: null });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(ProviderBloodworkPatientPanel, {
        patientId: 'patient-a',
        fallback: React.createElement('Fallback'),
      }),
    );
  });
  assert.equal(renderer!.root.findAllByType('Fallback').length, 1, 'signed-out/demo receives caller fallback');
  assert.equal(renderer!.root.findAllByType('ProviderBloodworkSection').length, 0, 'signed-out/demo issues no report query component');

  setSession({ session: { user: { id: 'staff-a' }, access_token: 'private-token' }, sessionLoading: false });
  setOfficeRoster({
    status: 'ready',
    roster: {
      office: { providerId: 'office-a', officeName: 'Office A', providerCode: 'A' },
      patients: [{ id: 'patient-a' }],
    },
  });
  await act(async () => {
    renderer!.update(React.createElement(ProviderBloodworkPatientPanel, { patientId: 'patient-a' }));
  });
  const section = renderer!.root.findByType('ProviderBloodworkSection');
  assert.equal(section.props.patientId, 'patient-a', 'authorized roster patient receives real bloodwork section');

  await act(async () => {
    renderer!.update(
      React.createElement(ProviderBloodworkPatientPanel, {
        patientId: 'patient-b',
        fallback: React.createElement('Fallback'),
      }),
    );
  });
  assert.equal(renderer!.root.findAllByType('ProviderBloodworkSection').length, 0, 'wrong-office patient never mounts report query component');
  assert.equal(renderer!.root.findAllByType('Fallback').length, 1);

  await act(async () => {
    renderer!.update(React.createElement(ProviderBloodworkPatientShell, { patientId: 'patient-a' }));
  });
  assert.equal(renderer!.root.findByType('PatientHeader').props.title, 'Patient bloodwork', 'standalone live shell has explicit private-record title');
  await act(async () => {
    renderer!.unmount();
  });
  console.log('bloodwork provider panel checks passed: demo fallback, authorized patient, wrong-patient denial, shell title');
}

void main();