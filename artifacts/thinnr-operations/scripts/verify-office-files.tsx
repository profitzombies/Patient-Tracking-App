import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession } from './a11y-stubs/session';
import { __setScope } from './a11y-stubs/provider-scope';
import { __setSession as __setSupabaseSession } from './invite-stubs/supabase';
import OfficeFiles from '../src/pages/OfficeFiles';
import type { HqFile, HqFolder } from '@workspace/api-client-react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const assigned: string[] = [];
(globalThis as any).window = {
  location: { assign: (url: string) => assigned.push(url) },
  open: () => ({ opener: {}, location: { set href(url: string) { assigned.push(url); } } }),
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as any).document ??= { body: {}, documentElement: {} };

let failures = 0;
const check = (name: string, condition: boolean, detail = '') => {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const textOf = (root: ReactTestInstance) => {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') parts.push(node);
    else node.children.forEach((child) => walk(child as ReactTestInstance | string));
  };
  walk(root);
  return parts.join('');
};
const settle = async (ms = 35) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
const click = async (node: ReactTestInstance) => {
  await act(async () => { await node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); });
  await settle();
};
const folder: HqFolder = { id: 'brand', name: 'Brand', parentId: null, createdAt: '', updatedAt: '' };
const file: HqFile = {
  id: 'guide', name: 'Office guide.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 1200, folderId: null, createdAt: '2026-01-02T12:00:00Z', updatedAt: '2026-01-02T12:00:00Z',
  archivedAt: null, uploadedBy: 'HQ', path: [],
};
const requests: string[] = [];
globalThis.fetch = async (input) => {
  const url = String(input);
  requests.push(url);
  if (url.includes('/download-url')) return new Response(JSON.stringify({ url: 'https://download.test/guide', expiresIn: 60, name: file.name }), { status: 200 });
  if (url.includes('/search')) return new Response(JSON.stringify({ files: [{ ...file, id: 'result', name: 'Search handbook.docx' }] }), { status: 200 });
  const nested = url.includes('folderId=brand');
  return new Response(JSON.stringify({
    folder: nested ? folder : null,
    breadcrumbs: nested ? [folder] : [],
    folders: nested ? [] : [folder],
    files: nested ? [file] : [file],
  }), { status: 200 });
};

async function render(path = '/files'): Promise<{ renderer: ReactTestRenderer; root: ReactTestInstance }> {
  const location = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}><Router hook={location.hook}><OfficeFiles /></Router></QueryClientProvider>);
  });
  await settle();
  return { renderer: renderer!, root: renderer!.root };
}

console.log('office files');
__setScope(null);
__setSupabaseSession(null);
__setSession({ authStatus: 'signed-out', authRole: null, authUser: null, hqRole: null });
requests.length = 0;
const demo = await render();
check('demo shows sign-in message and does not fetch', textOf(demo.root).includes('Sign in to see the files HQ shares with your office.') && requests.length === 0);
demo.renderer.unmount();

__setSupabaseSession('staff-token');
__setSession({ authStatus: 'signed-in', authRole: 'provider_staff', authUser: { id: 'staff-1' }, hqRole: null });
requests.length = 0;
const live = await render();
check('signed-in provider sees root folders and files', textOf(live.root).includes('Brand') && textOf(live.root).includes('Office guide.docx'));
check('page exposes no management controls', !/(Upload|New folder|Archived)/.test(textOf(live.root)));

await click(live.root.findByProps({ 'data-testid': 'folder-brand' }));
check('folder navigation requests folderId', requests.some((url) => url.includes('/api/office/files?folderId=brand')));
check('breadcrumb renders current folder', textOf(live.root).includes('Brand'));

const search = live.root.findByProps({ id: 'office-file-search' });
await act(async () => { search.props.onChange({ target: { value: 'handbook' } }); });
await settle(300);
await settle();
check('debounced search calls endpoint and renders results', requests.some((url) => url.includes('/api/office/files/search?q=handbook')) && textOf(live.root).includes('Search handbook.docx'));

await click(live.root.findByProps({ 'data-testid': 'file-result' }));
const dialogText = textOf(live.root);
check('file dialog is read-only with download', dialogText.includes('Preview or download this file.') && dialogText.includes('Download') && !/(Replace|Rename|Move to|Archive|Delete)/.test(dialogText));
const download = live.root.findAll((node) => node.type === 'button' && node.children.includes('Download'))[0];
await click(download);
check('download requests a URL and opens it', requests.some((url) => url.includes('/api/office/files/result/download-url')) && assigned.includes('https://download.test/guide'));
live.renderer.unmount();

if (failures) {
  console.error(`\n${failures} office files verification(s) failed.`);
  process.exit(1);
}
console.log('\nAll office files verifications passed.');