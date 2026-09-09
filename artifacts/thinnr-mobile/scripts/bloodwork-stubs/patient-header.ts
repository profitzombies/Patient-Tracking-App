import React from 'react';

export function PatientHeader(props: { title: string; right?: React.ReactNode }) {
  return React.createElement('PatientHeader', props, props.right);
}