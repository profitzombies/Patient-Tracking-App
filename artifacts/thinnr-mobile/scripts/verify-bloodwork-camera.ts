import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { BloodworkCamera } from '../components/bloodwork/BloodworkCamera';
import { resolvePicture } from './bloodwork-camera-stubs/expo-camera';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function main(): Promise<void> {
  const events: string[] = [];
  const props = {
    visible: true,
    onClose: () => events.push('close'),
    onCaptureStart: () => {
      events.push('scope-before-picture');
      return { generation: 1 };
    },
    onCapture: () => events.push('accepted'),
    onDiscard: (uri: string) => events.push(`discarded:${uri}`),
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(BloodworkCamera, props));
  });
  const presses = renderer!.root.findAllByType('Pressable');
  const shutter = presses[presses.length - 1];
  await act(async () => {
    shutter.props.onPress();
    await Promise.resolve();
  });
  assert.deepEqual(events, ['scope-before-picture'], 'capture generation is pinned before native camera await');
  await act(async () => {
    renderer!.update(React.createElement(BloodworkCamera, { ...props, visible: false }));
  });
  await act(async () => {
    resolvePicture();
    await Promise.resolve();
  });
  assert.deepEqual(events, ['scope-before-picture', 'discarded:file:///app-camera-raw.jpg'], 'late raw capture is rejected and sent to app-owned cleanup');
  await act(async () => renderer!.unmount());
  console.log('bloodwork camera checks passed: pre-await scope and late-capture disposal');
}

void main();