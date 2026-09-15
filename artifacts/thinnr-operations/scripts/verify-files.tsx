import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { __setSession } from './a11y-stubs/session';
import Files from '../src/pages/admin/Files';
import { UploadPanel } from '../src/components/admin/files/UploadPanel';
import { UploadQueue, type UploadItem } from '../src/components/admin/files/upload-queue';
import { FileDetailDialog } from '../src/components/admin/files/FileDetailDialog';
import type { HqFile } from '@workspace/api-client-react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class WindowStub extends EventTarget {
  location = { assign() {} };
  open = () => ({ opener: {}, location: { href: '' } });
}
(globalThis as any).window = new WindowStub();
(globalThis as any).document ??= { body: {}, documentElement: {} };
(URL as any).createObjectURL = () => 'blob:preview';
(URL as any).revokeObjectURL = () => {};

let failures = 0;
const ok = (condition: unknown, name: string) => {
  if (condition) console.log(`ok ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
};
const text = (root: { toJSON(): unknown }) => JSON.stringify(root.toJSON());
const click = async (node: ReactTestInstance) => { await act(async () => { await node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); }); };
const file = (name: string, type: string, size = 100) => ({ name, type, size }) as File;
const liveFile = (overrides: Partial<HqFile> = {}): HqFile => ({
  id: 'image-1', name: 'logo.png', contentType: 'image/png', size: 100,
  folderId: 'a', createdAt: '2026-01-02T15:30:00Z', updatedAt: '2026-01-02T15:30:00Z',
  archivedAt: null, uploadedBy: 'Alex Admin', path: [{ id: 'a', name: 'Brand', parentId: null, createdAt: '', updatedAt: '' }],
  ...overrides,
});

// Prompt is batch-specific and only shown for image batches.
{
  const base: UploadItem = { id: '1', file: file('photo.png', 'image/png'), folderId: null, batchId: 'b1', progress: 0, state: 'waiting' };
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<UploadPanel items={[base]} minimized={false} onMinimizedChange={() => {}} onAnswer={() => {}} onRetry={() => {}} onClose={() => {}} />); });
  ok(text(renderer!).includes('Compress them before saving?'), 'image upload shows compression prompt');
  await act(async () => { renderer!.update(<UploadPanel items={[{ ...base, file: file('notes.pdf', 'application/pdf'), compress: false }]} minimized={false} onMinimizedChange={() => {}} onAnswer={() => {}} onRetry={() => {}} onClose={() => {}} />); });
  ok(!text(renderer!).includes('Compress them before saving?'), 'non-image upload skips compression prompt');
  await act(async () => { renderer!.update(<UploadPanel items={[{ ...base, file: file('huge.png', 'image/png', 26 * 1024 * 1024), compress: false }]} minimized={false} onMinimizedChange={() => {}} onAnswer={() => {}} onRetry={() => {}} onClose={() => {}} />); });
  ok(!text(renderer!).includes('Compress them before saving?'), 'images above the server compression ceiling skip the prompt');
  let closed = 0;
  const compressing: UploadItem = { ...base, compress: true, progress: 100, state: 'compressing' };
  await act(async () => { renderer!.update(<UploadPanel items={[compressing]} minimized={false} onMinimizedChange={() => {}} onAnswer={() => {}} onRetry={() => {}} onClose={() => { closed += 1; }} />); });
  ok(text(renderer!).includes('Uploaded') && text(renderer!).includes('Compressing…') && text(renderer!).includes('Compressing 1 of 1'), 'compressing item shows upload done and compression in progress');
  ok(renderer!.root.findAllByProps({ 'data-testid': 'button-uploads-done' }).length === 0, 'Done button hidden while work is in flight');
  const finished: UploadItem = { ...compressing, state: 'done', result: { id: 'f', name: 'photo.png', contentType: 'image/png', size: 40, folderId: null, originalSize: 100, createdAt: '', updatedAt: '' } as any };
  await act(async () => { renderer!.update(<UploadPanel items={[finished]} minimized={false} onMinimizedChange={() => {}} onAnswer={() => {}} onRetry={() => {}} onClose={() => { closed += 1; }} />); });
  ok(text(renderer!).includes('60% smaller') && text(renderer!).includes('All uploads complete'), 'finished item reports compression savings');
  const doneButton = renderer!.root.findAll((node) => node.type === 'button' && node.props['data-testid'] === 'button-uploads-done')[0];
  await click(doneButton);
  ok(closed === 1, 'Done button closes the uploads panel');
  renderer!.unmount();
}

// XHR progress is reflected and compression choice reaches finalize.
{
  let sentCompress: boolean | undefined;
  let xhr: any;
  const snapshots: UploadItem[][] = [];
  const queue = new UploadQueue({
    create: async () => ({ uploadUrl: 'https://upload.test', fileId: 'f1', objectPath: 'p1' }),
    finalize: async (item) => {
      sentCompress = item.compress;
      return { id: 'f1', name: item.file.name, contentType: item.file.type, size: 75, folderId: null, originalSize: 100, createdAt: '', updatedAt: '' };
    },
  }, (items) => snapshots.push(items.map((item) => ({ ...item }))), () => {}, 3, () => {
    xhr = { upload: {}, status: 200, open() {}, setRequestHeader() {}, send() {} };
    return xhr as XMLHttpRequest;
  });
  queue.add([file('photo.png', 'image/png')], null, 'batch');
  queue.answer('batch', true);
  await act(async () => { await Promise.resolve(); });
  xhr.upload.onprogress({ lengthComputable: true, loaded: 42, total: 100 });
  ok(snapshots.some((items) => items[0]?.progress === 42), 'XHR progress updates upload row');
  await act(async () => { xhr.onload(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  ok(sentCompress === true && queue.snapshot[0]?.state === 'done', 'compression answer forwarded to finalize');
}

// Detail previews use authenticated blobs and choose a safe renderer by type.
{
  globalThis.fetch = async () => new Response(new Blob(['preview']), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  const noop = () => {};
  let archiveValue: boolean | undefined;
  const props = {
    open: true, onOpenChange: noop, onDownload: noop, onRename: noop, onMove: noop,
    onArchive: async (_file: HqFile, archived: boolean) => { archiveValue = archived; }, onDelete: noop, onFolder: noop, onReplaced: async () => {},
  };
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<FileDetailDialog {...props} file={liveFile()} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  ok(renderer!.root.findAllByType('img').some((node) => node.props.alt === 'logo.png'), 'image detail renders blob preview');
  await click(renderer!.root.findAll((node) => node.type === 'button' && node.children.includes('Archive'))[0]);
  ok(archiveValue === true, 'Archive action requests archived true');
  await act(async () => { renderer!.update(<FileDetailDialog {...props} file={liveFile({ id: 'pdf-1', name: 'guide.pdf', contentType: 'application/pdf' })} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  ok(renderer!.root.findAllByType('iframe').some((node) => node.props.title === 'Preview of guide.pdf'), 'PDF detail renders iframe preview');
  await act(async () => { renderer!.update(<FileDetailDialog {...props} file={liveFile({ id: 'doc-1', name: 'plan.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  ok(text(renderer!).includes('Word document') && text(renderer!).includes('Download it to open it.'), 'Word detail renders document card');
  renderer!.unmount();
}

// Replacement upload forwards the image compression decision to finalization.
{
  let replaceBody: any;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/replace-url')) return new Response(JSON.stringify({ uploadUrl: 'https://upload.test', fileId: 'image-1', objectPath: 'hq/image-1/new' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/replace')) {
      replaceBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(liveFile({ size: 80 })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(new Blob(['preview']), { status: 200, headers: { 'Content-Type': 'image/png' } });
  };
  (globalThis as any).XMLHttpRequest = class {
    upload: any = {};
    status = 200;
    open() {}
    setRequestHeader() {}
    send() { queueMicrotask(() => { this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 }); this.onload?.(); }); }
    onload?: () => void;
    onerror?: () => void;
  };
  const noop = () => {};
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<FileDetailDialog file={liveFile()} open onOpenChange={noop} onDownload={noop} onRename={noop} onMove={noop} onArchive={async () => {}} onDelete={noop} onFolder={noop} onReplaced={async () => {}} />); });
  const input = renderer!.root.findAllByType('input').find((node) => node.props.type === 'file')!;
  await act(async () => { input.props.onChange({ target: { files: [file('new-logo.png', 'image/png')], value: 'chosen' } }); });
  await click(renderer!.root.findAll((node) => node.type === 'button' && node.children.includes('Yes, compress'))[0]);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  ok(replaceBody?.compress === true, 'Replace forwards compress to finalization');
  ok(text(renderer!).includes('Replaced.') && renderer!.root.findAllByProps({ 'data-testid': 'replace-complete' }).length > 0, 'Replace shows a completion notice with Done');
  renderer!.unmount();
}

// Live drive integration: list, breadcrumbs, new folder and folder delete warning.
{
  __setSession({ authStatus: 'signed-in', authUser: { id: 'admin' }, hqRole: 'Admin' });
  const folder = { id: 'a', name: 'Brand', parentId: null, createdAt: '', updatedAt: '' };
  let updateBody: any;
  let resolveFolderDelete: ((response: Response) => void) | undefined;
  const folderDelete = new Promise<Response>((resolve) => { resolveFolderDelete = resolve; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/hq/folders/a') && init?.method === 'DELETE') return folderDelete;
    if (url.includes('/content')) return new Response(new Blob(['image']), { status: 200, headers: { 'Content-Type': 'image/png' } });
    if (url.includes('/search')) return new Response(JSON.stringify({ files: [liveFile({ id: 'search-1', name: 'Campaign logo.png' })] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (init?.method === 'PATCH' && url.includes('/api/hq/files/')) {
      updateBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify(liveFile({ archivedAt: updateBody.archived ? '2026-02-03T12:00:00Z' : null })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'POST') return new Response(JSON.stringify(folder), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('view=archived')) return new Response(JSON.stringify({ folder: null, breadcrumbs: [], folders: [], files: [liveFile({ id: 'archived-1', archivedAt: '2026-02-03T12:00:00Z' })] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const nested = url.includes('folderId=a');
    return new Response(JSON.stringify({ folder: nested ? folder : null, breadcrumbs: nested ? [folder] : [], folders: nested ? [] : [folder], files: nested ? [liveFile()] : [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const location = memoryLocation({ path: '/admin/files?folder=a', record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Router hook={location.hook}><Files /></Router></QueryClientProvider>); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  ok(text(renderer!).includes('Brand') && text(renderer!).includes('Folder path'), 'breadcrumb renders current folder');
  await click(renderer!.root.findByProps({ 'data-testid': 'file-image-1' }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  ok(renderer!.root.findAllByType('img').some((node) => node.props.alt === 'logo.png'), 'row click opens image detail');
  await click(renderer!.root.findAll((node) => node.type === 'button' && node.children.includes('Archive'))[0]);
  ok(updateBody?.archived === true, 'Archive action calls file update with archived true');
  const detailClose = renderer!.root.findAll((node) => node.type === 'button' && node.children.includes('Close'))[0];
  if (detailClose) await click(detailClose);
  const crumb = renderer!.root.findAll((node) => node.type === 'button' && node.children.includes('Files'))[0];
  await click(crumb);
  ok(location.history.at(-1) === '/admin/files', 'breadcrumb navigates to root');
  await click(renderer!.root.findByProps({ 'data-testid': 'button-new-folder' }));
  ok(text(renderer!).includes('Create a folder inside'), 'new folder dialog opens');
  // Close the dialog, then invoke the always-rendered dropdown Delete action.
  const cancel = renderer!.root.findAll((node) => node.type === 'button' && node.children.includes('Cancel'))[0];
  await click(cancel);
  const deletes = renderer!.root.findAll((node) => node.type === 'button' && node.children.includes('Delete'));
  await click(deletes[0]);
  ok(text(renderer!).includes('every sub-folder, and every file inside'), 'folder delete confirmation warns about contents');
  await click(renderer!.root.findByProps({ 'data-testid': 'button-confirm-folder-delete' }));
  ok(text(renderer!).includes('Deleting…'), 'folder delete dialog stays open in pending state');
  await act(async () => { resolveFolderDelete!(new Response(JSON.stringify({ ok: true, deletedFiles: 2, deletedFolders: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } })); await new Promise((resolve) => setTimeout(resolve, 0)); });

  const searchInput = renderer!.root.findByProps({ placeholder: 'Search files by name' });
  await act(async () => { searchInput.props.onChange({ target: { value: 'Campaign' } }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 275)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  ok(text(renderer!).includes('Campaign logo.png') && text(renderer!).includes('Brand'), 'search renders result row and path crumb');
  await click(renderer!.root.findByProps({ 'aria-label': 'Clear search' }));
  ok(text(renderer!).includes('HQ Drive'), 'clearing search restores folder view');
  const archived = renderer!.root.findAll((node) => node.type === 'button' && node.children.includes('Archived'))[0];
  await click(archived);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  ok(text(renderer!).includes('Restore') && text(renderer!).includes('Files') && text(renderer!).includes('Archived'), 'archived view lists file with Restore');

  const transfer = { types: ['Files'], files: [] };
  await act(async () => { window.dispatchEvent(Object.assign(new Event('dragenter'), { dataTransfer: transfer })); });
  ok(text(renderer!).includes('Drop to upload into'), 'window file drag shows drop overlay');
  renderer!.unmount();
}

if (failures) process.exit(1);
console.log('Files verification passed.');