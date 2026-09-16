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
import { FolderGrid } from '../src/components/admin/files/FolderGrid';
import { FileGrid } from '../src/components/admin/files/FileGrid';
import { FileTable } from '../src/components/admin/files/FileTable';
import { reorderIds, stepIds, orderBy, DRAG_TYPES } from '../src/components/admin/files/reorder';
import type { HqFile, HqFolder } from '@workspace/api-client-react';

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
const click = async (node: ReactTestInstance) => { await act(async () => { await (node.props.onClick ?? node.props.onSelect)?.({ preventDefault() {}, stopPropagation() {} }); }); };
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

// Large files: previews stay bounded below the 250 MB storage cap and the
// replacement picker enforces the same 250 MB limit as the drop zone.
{
  const noop = () => {};
  const props = {
    open: true, onOpenChange: noop, onDownload: noop, onRename: noop, onMove: noop,
    onArchive: async () => {}, onDelete: noop, onFolder: noop, onReplaced: async () => {},
  };
  let contentRequests = 0;
  const tooLargeContent = async () => { contentRequests += 1; throw Object.assign(new Error('413'), { status: 413 }); };
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<FileDetailDialog {...props} loadContent={tooLargeContent} file={liveFile({ id: 'big-1', name: 'catalog.pdf', contentType: 'application/pdf', size: 200 * 1024 * 1024 })} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  ok(contentRequests === 0, 'files above the preview limit never request inline content');
  ok(renderer!.root.findAllByProps({ 'data-testid': 'preview-too-large' }).length > 0 && text(renderer!).includes('too large to preview here') && !text(renderer!).includes('Couldn’t load the preview.'), 'oversized file shows the download note, not the preview error');
  ok(renderer!.root.findAll((node) => node.type === 'button' && node.children.includes('Download')).length === 1, 'oversized file still offers Download');
  await act(async () => { renderer!.update(<FileDetailDialog {...props} loadContent={tooLargeContent} file={liveFile({ id: 'big-2', name: 'scan.png', contentType: 'image/png', size: 40 * 1024 * 1024 })} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  ok(contentRequests === 1 && renderer!.root.findAllByProps({ 'data-testid': 'preview-too-large' }).length > 0, 'a 413 from the content route renders the too-large note instead of the generic error');
  await act(async () => { renderer!.update(<FileDetailDialog {...props} loadContent={async () => { throw Object.assign(new Error('502'), { status: 502 }); }} file={liveFile({ id: 'err-1', name: 'flaky.png', contentType: 'image/png', size: 1024 })} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  ok(text(renderer!).includes('Couldn’t load the preview.') && renderer!.root.findAllByProps({ 'data-testid': 'preview-too-large' }).length === 0, 'other preview failures keep the retryable error');
  const input = renderer!.root.findAllByType('input').find((node) => node.props.type === 'file')!;
  await act(async () => { input.props.onChange({ target: { files: [file('huge.pdf', 'application/pdf', 250 * 1024 * 1024 + 1)], value: 'chosen' } }); });
  ok(text(renderer!).includes('The replacement exceeds the 250 MB maximum.') && !text(renderer!).includes('Replace with:'), 'replacement over 250 MB is refused with the 250 MB message');
  await act(async () => { input.props.onChange({ target: { files: [file('big.pdf', 'application/pdf', 200 * 1024 * 1024)], value: 'chosen' } }); });
  ok(text(renderer!).includes('Replace with:') && text(renderer!).includes('big.pdf') && !text(renderer!).includes('exceeds the'), 'a 200 MB replacement is accepted');
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

// Manual ordering helpers.
{
  ok(reorderIds(['a', 'b', 'c'], 'c', 'a', false).join() === 'c,a,b', 'reorderIds drops before the target');
  ok(reorderIds(['a', 'b', 'c'], 'a', 'c', true).join() === 'b,c,a', 'reorderIds drops after the target');
  ok(reorderIds(['a', 'b', 'c'], 'a', 'b', false).join() === 'a,b,c', 'reorderIds keeps an already-correct order');
  ok(reorderIds(['a', 'b'], 'zzz', 'a', false).join() === 'a,b', 'reorderIds ignores unknown ids');
  ok(stepIds(['a', 'b', 'c'], 'c', -1).join() === 'a,c,b' && stepIds(['a', 'b', 'c'], 'a', -1).join() === 'a,b,c', 'stepIds moves one slot and clamps at the edges');
  ok(orderBy([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['c', 'a']).map((item) => item.id).join() === 'c,a,b', 'orderBy applies the id order and keeps strangers at the end');
}

// Drag-and-drop reorder: cards and rows, folders and files; providers get none of it.
{
  const folders: HqFolder[] = ['f1', 'f2', 'f3'].map((id) => ({ id, name: id.toUpperCase(), parentId: null, createdAt: '2026-01-02T15:30:00Z', updatedAt: '' }));
  const files: HqFile[] = ['x1', 'x2', 'x3'].map((id) => liveFile({ id, name: `${id}.png` }));
  const transfer = (type: string, id: string) => {
    const store: Record<string, string> = {};
    return { types: [type], effectAllowed: '', dropEffect: '', setData(key: string, value: string) { store[key] = value; }, getData(key: string) { return store[key] ?? ''; }, ...(id ? { preset: () => { store[type] = id; } } : {}) };
  };
  const drag = async (from: ReactTestInstance, to: ReactTestInstance, type: string, fromId: string, point: { clientX: number; clientY: number }) => {
    const dataTransfer = transfer(type, fromId);
    await act(async () => { from.props.onDragStart({ dataTransfer }); });
    await act(async () => { to.props.onDragOver({ dataTransfer, preventDefault() {}, clientX: point.clientX, clientY: point.clientY, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }) } }); });
    await act(async () => { to.props.onDrop({ dataTransfer, preventDefault() {} }); });
    await act(async () => { from.props.onDragEnd?.(); });
  };

  let folderOrder: string[] | null = null;
  let renderer: ReturnType<typeof create>;
  let movedFolder = '';
  await act(async () => { renderer = create(<FolderGrid folders={folders} onOpen={() => {}} onReorder={(ids, moved) => { folderOrder = ids; movedFolder = moved; }} />); });
  const card = (id: string) => renderer!.root.findByProps({ 'data-testid': `folder-card-${id}` });
  ok(card('f1').props.draggable === true, 'HQ folder cards are draggable');
  await drag(card('f3'), card('f1'), DRAG_TYPES.folder, 'f3', { clientX: 10, clientY: 20 });
  ok(folderOrder?.join() === 'f3,f1,f2' && movedFolder === 'f3', 'dropping on the left half of a card places the folder before it (and names the moved one)');
  await drag(card('f1'), card('f2'), DRAG_TYPES.folder, 'f1', { clientX: 90, clientY: 20 });
  ok(folderOrder?.join() === 'f2,f1,f3', 'dropping on the right half of a card places the folder after it');
  folderOrder = null;
  const fileTransfer = transfer(DRAG_TYPES.file, 'x1');
  await act(async () => { card('f2').props.onDrop({ dataTransfer: fileTransfer, preventDefault() {} }); });
  ok(folderOrder === null, 'a file drag dropped on a folder card is ignored');
  await click(renderer!.root.findByProps({ 'data-testid': 'folder-move-down-f1' }));
  ok(folderOrder?.join() === 'f2,f1,f3' && movedFolder === 'f1', 'Move down steps a folder one slot later');
  ok(renderer!.root.findByProps({ 'data-testid': 'folder-move-up-f1' }).props.disabled === true, 'Move up is disabled for the first item');
  renderer!.unmount();

  let fileOrder: string[] | null = null;
  await act(async () => { renderer = create(<FileGrid files={files} downloadingId={null} onOpen={() => {}} onReorder={(ids) => { fileOrder = ids; }} />); });
  const fileCard = (id: string) => renderer!.root.findByProps({ 'data-testid': `file-card-${id}` });
  await drag(fileCard('x1'), fileCard('x3'), DRAG_TYPES.file, 'x1', { clientX: 90, clientY: 20 });
  ok(fileOrder?.join() === 'x2,x3,x1', 'file cards reorder by drag');
  ok(text(renderer!).includes('"PNG"') && text(renderer!).includes('100 B') && text(renderer!).includes('Jan 2, 2026'), 'file card shows type, size and date');
  renderer!.unmount();

  fileOrder = null; folderOrder = null;
  await act(async () => { renderer = create(<FileTable files={files} downloadingId={null} onOpen={() => {}} onReorder={(ids) => { fileOrder = ids; }} folders={folders} onOpenFolder={() => {}} onReorderFolders={(ids) => { folderOrder = ids; }} />); });
  const row = (testId: string) => renderer!.root.findByProps({ 'data-testid': testId });
  await drag(row('file-x3'), row('file-x1'), DRAG_TYPES.file, 'x3', { clientX: 50, clientY: 5 });
  ok(fileOrder?.join() === 'x3,x1,x2', 'list rows: dropping on the top half places the file above');
  await drag(row('folder-row-f1'), row('folder-row-f3'), DRAG_TYPES.folder, 'f1', { clientX: 50, clientY: 35 });
  ok(folderOrder?.join() === 'f2,f3,f1', 'list rows: dropping on the bottom half places the folder below');
  ok(text(renderer!).includes('Folder') && renderer!.root.findAllByProps({ 'data-testid': 'folder-row-f2' }).length === 1, 'list view shows folders as rows in the same table');
  renderer!.unmount();

  await act(async () => { renderer = create(<><FolderGrid folders={folders} onOpen={() => {}} /><FileTable files={files} downloadingId={null} onOpen={() => {}} /></>); });
  ok(renderer!.root.findByProps({ 'data-testid': 'folder-card-f1' }).props.draggable === undefined, 'without onReorder folder cards are not draggable (provider portal)');
  ok(renderer!.root.findByProps({ 'data-testid': 'file-x1' }).props.draggable === undefined, 'without onReorder file rows are not draggable (provider portal)');
  ok(!text(renderer!).includes('Move up') && !text(renderer!).includes('Move back'), 'without onReorder there are no move actions');
  renderer!.unmount();
}

// Live drive integration: list, breadcrumbs, new folder and folder delete warning.
{
  __setSession({ authStatus: 'signed-in', authUser: { id: 'admin' }, hqRole: 'Admin' });
  const folder = { id: 'a', name: 'Brand', parentId: null, createdAt: '', updatedAt: '' };
  const folderB = { id: 'b', name: 'Clinical', parentId: null, createdAt: '', updatedAt: '' };
  let updateBody: any;
  let orderBody: any;
  let rootFolders = [folder, folderB];
  let resolveFolderDelete: ((response: Response) => void) | undefined;
  const folderDelete = new Promise<Response>((resolve) => { resolveFolderDelete = resolve; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/hq/folders/a') && init?.method === 'DELETE') return folderDelete;
    if (url.includes('/content')) return new Response(new Blob(['image']), { status: 200, headers: { 'Content-Type': 'image/png' } });
    if (url.includes('/search')) return new Response(JSON.stringify({ files: [liveFile({ id: 'search-1', name: 'Campaign logo.png' })] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (init?.method === 'PUT' && url.endsWith('/api/hq/files/order')) {
      orderBody = JSON.parse(String(init.body));
      if (orderBody.folderIds) rootFolders = orderBy(rootFolders, orderBody.folderIds); // the server would list the saved order
      return new Response(JSON.stringify({ ok: true, folders: orderBody.folderIds?.length ?? 0, files: orderBody.fileIds?.length ?? 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'PATCH' && url.includes('/api/hq/files/')) {
      updateBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify(liveFile({ archivedAt: updateBody.archived ? '2026-02-03T12:00:00Z' : null })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'POST') return new Response(JSON.stringify(folder), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('view=archived')) return new Response(JSON.stringify({ folder: null, breadcrumbs: [], folders: [], files: [liveFile({ id: 'archived-1', archivedAt: '2026-02-03T12:00:00Z' })] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const nested = url.includes('folderId=a');
    return new Response(JSON.stringify({ folder: nested ? folder : null, breadcrumbs: nested ? [folder] : [], folders: nested ? [] : rootFolders, files: nested ? [liveFile()] : [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

  // Back to the root: cards by default, list on demand, and a reorder saves through PUT /hq/files/order.
  const back = renderer!.root.findAll((node) => node.type === 'button' && node.children.includes('Back to files'))[0];
  await click(back);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  ok(renderer!.root.findAllByProps({ 'data-testid': 'folder-grid' }).length === 1 && renderer!.root.findByProps({ 'data-testid': 'view-cards' }).props['aria-pressed'] === true, 'cards view is the default');
  await click(renderer!.root.findByProps({ 'data-testid': 'view-list' }));
  ok(renderer!.root.findAllByProps({ 'data-testid': 'folder-grid' }).length === 0 && renderer!.root.findAllByProps({ 'data-testid': 'folder-row-a' }).length === 1, 'list view shows folders as rows');
  ok(renderer!.root.findAllByProps({ 'data-testid': 'folder-row-b' }).length === 1, 'list view shows every sibling folder');
  await click(renderer!.root.findByProps({ 'data-testid': 'folder-move-down-a' }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  ok(orderBody?.parentId === null && orderBody?.folderIds?.join() === 'b,a', 'Move down saves the new folder order for the current folder');
  const rowsNow = renderer!.root.findAll((node) => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('folder-row-')).map((node) => node.props['data-testid']);
  ok(rowsNow.join() === 'folder-row-b,folder-row-a', 'new order shows immediately (optimistic)');
  ok(renderer!.root.findByProps({ 'data-testid': 'order-notice' }).props.children === 'Brand moved to position 2 of 2.', 'reorder is announced to screen readers');
  renderer!.unmount();
}

if (failures) process.exit(1);
console.log('Files verification passed.');