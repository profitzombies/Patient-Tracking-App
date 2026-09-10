/**
 * Scroll-boundary regression suite.
 *
 * This is intentionally a narrow, Node-only probe.  The Page wrappers and the
 * keyboard compatibility component are REAL production components; only
 * native host modules are replaced by the forwarding stubs selected by
 * tsconfig.scroll-boundary.json.  The source checks at the end protect the
 * adoption seam while the renderer checks protect the props/ref seam.
 *
 * Run:
 *   pnpm --filter @workspace/thinnr-mobile run test:scroll-boundary
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import React, { act, createRef } from 'react';
import * as TypeScript from 'typescript';
import * as NativeStub from 'react-native';
import * as JsxRuntime from 'react/jsx-runtime';
import { Platform, RefreshControl } from 'react-native';

import { KeyboardAwareScrollViewCompat } from '../components/KeyboardAwareScrollViewCompat';
import { PageFlatList, PageScrollView } from '../components/ui/PageScrollView';
import { scrollBoundaryProps, WEB_SCROLL_BOUNDARY_CSS } from '../components/ui/scrollBoundary';

const h = React.createElement;
const ROOT = path.resolve(__dirname, '..');

let checks = 0;
let failures = 0;
let finished = false;

function fail(message: string): void {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

function assert(label: string, condition: boolean): void {
  checks += 1;
  if (!condition) fail(label);
}

function equal(label: string, actual: unknown, expected: unknown): void {
  checks += 1;
  if (actual !== expected) {
    fail(`${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

function finish(): never {
  finished = true;
  if (failures > 0) {
    console.error(`\n✗ scroll-boundary check: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ scroll-boundary check: ${checks} checks passed`);
  process.exit(0);
}

process.on('beforeExit', () => {
  if (!finished) {
    console.error('✗ scroll-boundary check: exited before finishing (dangling await?)');
    process.exit(1);
  }
});

interface TestNode {
  type: unknown;
  props: Record<string, unknown>;
  children: (TestNode | string)[];
  findAll(predicate: (node: TestNode) => boolean): TestNode[];
}

interface Renderer {
  root: TestNode;
  unmount(): void;
}

let createRenderer: (element: React.ReactElement) => Renderer;

function render(element: React.ReactElement): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = createRenderer(element);
  });
  return renderer;
}

function unmount(renderer: Renderer): void {
  act(() => renderer.unmount());
}

function isHost(node: TestNode): boolean {
  return typeof node.type === 'string';
}

function flattenStyle(style: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const visit = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') Object.assign(result, value);
  };
  visit(style);
  return result;
}

function hosts(root: TestNode, type: string): TestNode[] {
  return root.findAll(node => isHost(node) && node.type === type);
}

function source(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function sourceFilesIn(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFilesIn(relative));
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

function importFrom(sourceText: string, moduleName: string): string[] {
  return (sourceText.match(new RegExp(`import[\\s\\S]*?from ['"]${moduleName}['"]`, 'g')) ?? []);
}

function hasRawNativeImport(sourceText: string, symbol: string): boolean {
  return importFrom(sourceText, 'react-native').some(statement => new RegExp(`\\b${symbol}\\b`).test(statement));
}

function screenBoundaryNode(root: TestNode): TestNode | undefined {
  const scrolls = hosts(root, 'ScrollView').concat(hosts(root, 'KeyboardAwareScrollView'));
  return scrolls.find(node => {
    const style = flattenStyle(node.props.style);
    return (
      style.overscrollBehaviorY === 'none' ||
      node.props.overScrollMode === 'never' ||
      (node.props.bounces === false && node.props.alwaysBounceVertical === false)
    );
  });
}

function checkBoundaryPrimitive(): void {
  equal(
    'iOS bounded disables vertical bounce',
    JSON.stringify(scrollBoundaryProps('ios', { scrollBoundary: 'bounded' })),
    JSON.stringify({ bounces: false, alwaysBounceVertical: false }),
  );
  equal(
    'iOS refresh keeps both bounce switches on',
    JSON.stringify(scrollBoundaryProps('ios', { scrollBoundary: 'refresh' })),
    JSON.stringify({ bounces: true, alwaysBounceVertical: true }),
  );
  equal(
    'Android bounded disables edge glow',
    JSON.stringify(scrollBoundaryProps('android', { scrollBoundary: 'bounded' })),
    JSON.stringify({ overScrollMode: 'never' }),
  );
  equal(
    'Android refresh still disables edge glow',
    JSON.stringify(scrollBoundaryProps('android', { scrollBoundary: 'refresh' })),
    JSON.stringify({ overScrollMode: 'never' }),
  );
  equal(
    'web puts the boundary on outer style',
    JSON.stringify(scrollBoundaryProps('web', { scrollBoundary: 'bounded' })),
    JSON.stringify({ style: { overscrollBehaviorY: 'none' } }),
  );
  equal(
    'web refresh keeps the same CSS boundary',
    JSON.stringify(scrollBoundaryProps('web', { scrollBoundary: 'refresh' })),
    JSON.stringify({ style: { overscrollBehaviorY: 'none' } }),
  );
  equal(
    'horizontal surfaces keep native defaults on iOS',
    JSON.stringify(scrollBoundaryProps('ios', { horizontal: true })),
    JSON.stringify({}),
  );
  equal(
    'horizontal surfaces keep native defaults on Android',
    JSON.stringify(scrollBoundaryProps('android', { horizontal: true })),
    JSON.stringify({}),
  );
  equal(
    'horizontal surfaces keep native defaults on web',
    JSON.stringify(scrollBoundaryProps('web', { horizontal: true })),
    JSON.stringify({}),
  );
  equal(
    'null horizontal is treated as vertical',
    JSON.stringify(scrollBoundaryProps('android', { horizontal: null })),
    JSON.stringify({ overScrollMode: 'never' }),
  );
  equal(
    'unknown platform does not invent a policy',
    JSON.stringify(scrollBoundaryProps('windows', {})),
    JSON.stringify({}),
  );
}

function checkPageWrappers(): void {
  const onScroll = () => {};
  const onRefresh = () => {};
  const refreshControl = h(RefreshControl, { refreshing: true, onRefresh });
  const originalStyle = { flex: 1, backgroundColor: 'paper' };
  const contentStyle = { paddingBottom: 48 };

  Platform.OS = 'web';
  const webRef = createRef<unknown>();
  const web = render(
    h(
      PageScrollView,
      {
        ref: webRef,
        testID: 'wrapper-web',
        style: originalStyle,
        contentContainerStyle: contentStyle,
        onScroll,
        refreshControl,
        scrollBoundary: 'bounded',
      },
      h('Text', null, 'child'),
    ),
  );
  const webNode = hosts(web.root, 'ScrollView')[0];
  assert('PageScrollView web host is present', webNode !== undefined);
  equal('PageScrollView forwards onScroll', webNode?.props.onScroll, onScroll);
  equal('PageScrollView forwards contentContainerStyle', webNode?.props.contentContainerStyle, contentStyle);
  equal('PageScrollView forwards refreshControl', webNode?.props.refreshControl, refreshControl);
  const webStyle = flattenStyle(webNode?.props.style);
  equal('PageScrollView preserves caller style on web', webStyle.flex, 1);
  equal('PageScrollView adds web boundary to outer style', webStyle.overscrollBehaviorY, 'none');
  assert('PageScrollView forwards ref to host', webRef.current !== null);
  assert(
    'PageScrollView forwards refresh callback through RefreshControl',
    (webNode?.props.refreshControl as React.ReactElement | undefined)?.props.onRefresh === onRefresh,
  );
  unmount(web);

  Platform.OS = 'ios';
  const iosRef = createRef<unknown>();
  const ios = render(
    h(PageScrollView, {
      ref: iosRef,
      style: originalStyle,
      contentContainerStyle: contentStyle,
      onScroll,
      refreshControl,
      scrollBoundary: 'bounded',
    }),
  );
  const iosNode = hosts(ios.root, 'ScrollView')[0];
  equal('PageScrollView iOS bounces false', iosNode?.props.bounces, false);
  equal('PageScrollView iOS alwaysBounceVertical false', iosNode?.props.alwaysBounceVertical, false);
  equal('PageScrollView iOS preserves caller style', iosNode?.props.style, originalStyle);
  equal('PageScrollView iOS keeps contentContainerStyle', iosNode?.props.contentContainerStyle, contentStyle);
  equal('PageScrollView iOS keeps onScroll', iosNode?.props.onScroll, onScroll);
  assert('PageScrollView iOS forwards ref to host', iosRef.current !== null);
  unmount(ios);

  Platform.OS = 'ios';
  const refresh = render(
    h(PageScrollView, {
      scrollBoundary: 'refresh',
      refreshControl,
    }),
  );
  const refreshNode = hosts(refresh.root, 'ScrollView')[0];
  equal('iOS refresh exception bounces', refreshNode?.props.bounces, true);
  equal('iOS refresh exception alwaysBounceVertical', refreshNode?.props.alwaysBounceVertical, true);
  unmount(refresh);

  Platform.OS = 'android';
  const android = render(
    h(PageScrollView, {
      style: originalStyle,
      contentContainerStyle: contentStyle,
      onScroll,
    }),
  );
  const androidNode = hosts(android.root, 'ScrollView')[0];
  equal('PageScrollView Android overScrollMode never', androidNode?.props.overScrollMode, 'never');
  equal('PageScrollView Android preserves style', androidNode?.props.style, originalStyle);
  equal('PageScrollView Android preserves content style', androidNode?.props.contentContainerStyle, contentStyle);
  unmount(android);

  Platform.OS = 'web';
  const flatRef = createRef<unknown>();
  const flat = render(
    h(PageFlatList, {
      ref: flatRef,
      data: [{ id: 'one' }],
      renderItem: () => null,
      style: originalStyle,
      contentContainerStyle: contentStyle,
      onScroll,
    }),
  );
  const flatNode = hosts(flat.root, 'FlatList')[0];
  assert('PageFlatList host is present', flatNode !== undefined);
  equal('PageFlatList forwards content style', flatNode?.props.contentContainerStyle, contentStyle);
  equal('PageFlatList forwards onScroll', flatNode?.props.onScroll, onScroll);
  equal('PageFlatList adds web boundary to outer style', flattenStyle(flatNode?.props.style).overscrollBehaviorY, 'none');
  assert('PageFlatList forwards ref to host', flatRef.current !== null);
  unmount(flat);

  const horizontal = render(
    h(PageScrollView, {
      horizontal: true,
      style: originalStyle,
      onScroll,
    }),
  );
  const horizontalNode = hosts(horizontal.root, 'ScrollView')[0];
  equal('horizontal PageScrollView has no web boundary style', horizontalNode?.props.style, originalStyle);
  assert('horizontal PageScrollView does not invent over-scroll props', !('overScrollMode' in (horizontalNode?.props ?? {})));
  unmount(horizontal);
}

function checkKeyboardCompat(): void {
  const onScroll = () => {};
  const style = { flexGrow: 1 };
  const contentContainerStyle = { paddingBottom: 32 };

  Platform.OS = 'web';
  const web = render(
    h(
      KeyboardAwareScrollViewCompat,
      {
        testID: 'keyboard-web',
        keyboardShouldPersistTaps: 'always',
        keyboardDismissMode: 'on-drag',
        style,
        contentContainerStyle,
        onScroll,
      },
      h('Text', null, 'form'),
    ),
  );
  const webNode = hosts(web.root, 'ScrollView')[0];
  assert('keyboard compat web uses real ScrollView', webNode !== undefined);
  equal('keyboard compat preserves keyboardShouldPersistTaps', webNode?.props.keyboardShouldPersistTaps, 'always');
  equal('keyboard compat preserves keyboardDismissMode', webNode?.props.keyboardDismissMode, 'on-drag');
  equal('keyboard compat preserves content style', webNode?.props.contentContainerStyle, contentContainerStyle);
  equal('keyboard compat preserves onScroll', webNode?.props.onScroll, onScroll);
  equal('keyboard compat adds web outer boundary', flattenStyle(webNode?.props.style).overscrollBehaviorY, 'none');
  equal('keyboard compat preserves caller style on web', flattenStyle(webNode?.props.style).flexGrow, 1);
  unmount(web);

  Platform.OS = 'ios';
  const ios = render(
    h(KeyboardAwareScrollViewCompat, {
      keyboardShouldPersistTaps: 'never',
      style,
      contentContainerStyle,
      onScroll,
    }),
  );
  const iosNode = hosts(ios.root, 'KeyboardAwareScrollView')[0];
  assert('keyboard compat native uses real keyboard controller host', iosNode !== undefined);
  equal('native keyboard compat preserves keyboard config', iosNode?.props.keyboardShouldPersistTaps, 'never');
  equal('native keyboard compat disables bounce', iosNode?.props.bounces, false);
  equal('native keyboard compat preserves content style', iosNode?.props.contentContainerStyle, contentContainerStyle);
  equal('native keyboard compat preserves onScroll', iosNode?.props.onScroll, onScroll);
  unmount(ios);
}

function checkSourceAdoption(): void {
  const patientScreens = [
    'app/(patient)/today.tsx',
    'app/(patient)/diary.tsx',
    'app/(patient)/recipes.tsx',
    'app/(patient)/progress.tsx',
    'app/(patient)/plan.tsx',
  ];
  for (const file of patientScreens) {
    const text = source(file);
    assert(`${file} imports PageScrollView`, text.includes('PageScrollView'));
    assert(
      `${file} uses the shared PageScrollView alias`,
      /PageScrollView(?:\s+as\s+ScrollView)?/.test(text),
    );
    assert(`${file} has no raw react-native ScrollView import`, !hasRawNativeImport(text, 'ScrollView'));
  }

  const welcome = source('app/patient-welcome.tsx');
  assert('patient welcome imports PageScrollView', welcome.includes('PageScrollView'));
  assert('patient welcome uses shared PageScrollView alias', /PageScrollView(?:\s+as\s+ScrollView)?/.test(welcome));
  assert('patient welcome has no raw ScrollView import', !hasRawNativeImport(welcome, 'ScrollView'));

  const claim = source('app/claim-account.tsx');
  assert('claim form uses keyboard compatibility wrapper', claim.includes('KeyboardAwareScrollViewCompat'));
  assert('claim form does not import a raw ScrollView', !hasRawNativeImport(claim, 'ScrollView'));

  const refreshScreens = [
    { file: 'app/bloodwork/index.tsx', host: 'ScrollView' },
    { file: 'app/(tabs)/patients.tsx', host: 'FlatList' },
  ];
  let refreshCallSites = 0;
  for (const { file, host } of refreshScreens) {
    const text = source(file);
    assert(`${file} uses shared ${host} wrapper`, text.includes(host === 'ScrollView' ? 'PageScrollView' : 'PageFlatList'));
    const callSites = text.match(/scrollBoundary\s*=\s*["']refresh["']/g) ?? [];
    refreshCallSites += callSites.length;
    equal(`${file} has exactly one refresh boundary`, callSites.length, 1);
    assert(`${file} still owns a RefreshControl`, text.includes('RefreshControl'));
  }
  equal('exactly two refresh exception callsites remain', refreshCallSites, 2);

  // Inventory every direct native scrolling import.  Anything not in this
  // allowlist is an ordinary vertical surface and must use the shared seam.
  // Internal primitives are listed separately so a new app screen cannot hide
  // a raw import behind a copied wrapper.
  const rawScrollAllowlist = new Set([
    'app/care-team-chat.tsx',
    'app/coach-chat.tsx',
    'app/patient/[id].tsx',
    'app/support-chat.tsx',
    'components/KeyboardAwareScrollViewCompat.tsx',
    'components/bloodwork/ZoomableImage.tsx',
    'components/patient/GuidedPhotoSession.tsx',
    'components/patient/PatientWeightChart.tsx',
    'components/staff/BodyMeasurementsCard.tsx',
    'components/ui/PageScrollView.tsx',
    'components/ui/PhotoLightbox.tsx',
  ]);
  const rawScrollFiles = sourceFilesIn('app')
    .concat(sourceFilesIn('components'))
    .filter(file => {
      const text = source(file);
      return hasRawNativeImport(text, 'ScrollView') || hasRawNativeImport(text, 'FlatList');
    })
    .sort();
  equal(
    'direct native scrolling inventory has only explicit exceptions',
    JSON.stringify(rawScrollFiles),
    JSON.stringify([...rawScrollAllowlist].sort()),
  );

  // These surfaces intentionally own horizontal paging, zoom, or a keyboard-
  // aware chat responder.  A blanket replacement would change navigation,
  // gesture, and keyboard policy rather than just containing vertical bounce.
  const exceptions = [
    { file: 'components/ui/PhotoLightbox.tsx', marker: 'horizontal' },
    { file: 'components/bloodwork/ZoomableImage.tsx', marker: 'horizontal' },
    { file: 'components/patient/PatientWeightChart.tsx', marker: 'horizontal' },
    { file: 'components/staff/BodyMeasurementsCard.tsx', marker: 'horizontal' },
    { file: 'app/patient/[id].tsx', marker: 'horizontal' },
    { file: 'app/care-team-chat.tsx', marker: 'onScroll' },
    { file: 'app/coach-chat.tsx', marker: 'onScroll' },
    { file: 'app/support-chat.tsx', marker: 'onScroll' },
    { file: 'components/patient/GuidedPhotoSession.tsx', marker: 'ScrollView' },
  ];
  for (const { file, marker } of exceptions) {
    const text = source(file);
    assert(`${file} remains an intentional raw ScrollView exception`, hasRawNativeImport(text, 'ScrollView'));
    assert(`${file} keeps its ${marker} policy`, text.includes(marker));
    assert(`${file} is not silently changed to PageScrollView`, !text.includes('PageScrollView'));
  }

  // No wrapper is allowed to become a policy grab-bag.  This protects the
  // explicitly unchanged keyboard/nav/zoom knobs while still allowing the
  // boundary implementation to evolve independently.
  const wrapperSource = source('components/ui/PageScrollView.tsx');
  assert('PageScrollView does not change keyboard policy', !wrapperSource.includes('keyboardShouldPersistTaps'));
  assert('PageScrollView does not change navigation policy', !wrapperSource.includes('onScrollBeginDrag'));
  assert('PageScrollView does not change zoom policy', !wrapperSource.includes('minimumZoomScale'));
  const boundarySource = source('components/ui/scrollBoundary.ts');
  assert('scrollBoundary does not set touch-action', !boundarySource.includes('touchAction'));
  assert('scrollBoundary does not set scrollEnabled', !/[,{]\s*scrollEnabled\s*:/.test(boundarySource));
  assert('scrollBoundary does not set responder policy', !/[,{]\s*responder[A-Z]\w*\s*:/.test(boundarySource));
}

function checkCssLifecycle(): void {
  assert('document CSS is root-scoped', /html,\s*body,\s*#root\s*\{/.test(WEB_SCROLL_BOUNDARY_CSS));
  assert('document CSS disables overscroll', WEB_SCROLL_BOUNDARY_CSS.includes('overscroll-behavior: none'));
  assert('document CSS has no universal selector', !WEB_SCROLL_BOUNDARY_CSS.includes('*'));

  const shellSource = source('components/WebFitShell.tsx');
  assert('WebFitShell imports shared boundary CSS', shellSource.includes('WEB_SCROLL_BOUNDARY_CSS'));
  assert('WebFitShell creates a style element in its effect', shellSource.includes("document.createElement('style')"));
  assert('WebFitShell tags its style element', shellSource.includes('thinnrScrollBoundary'));
  assert('WebFitShell appends the style element', shellSource.includes('document.head.appendChild(sheet)'));
  assert('WebFitShell removes its own style element', shellSource.includes('return () => sheet.remove()'));
}

interface BoundaryModule {
  scrollBoundaryProps: typeof scrollBoundaryProps;
}

function executeTypeScriptModule(
  sourceText: string,
  requireModule: (request: string) => unknown = () => {
    throw new Error('mutant requested an unexpected runtime dependency');
  },
): Record<string, unknown> {
  const output = TypeScript.transpileModule(sourceText, {
    compilerOptions: {
      jsx: TypeScript.JsxEmit.ReactJSX,
      module: TypeScript.ModuleKind.CommonJS,
      target: TypeScript.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  if (output.diagnostics?.some(diagnostic => diagnostic.category === TypeScript.DiagnosticCategory.Error)) {
    throw new Error('in-memory mutant did not transpile');
  }
  const moduleRecord: { exports: Record<string, unknown> } = { exports: {} };
  runInNewContext(output.outputText, {
    module: moduleRecord,
    exports: moduleRecord.exports,
    require: requireModule,
  });
  return moduleRecord.exports;
}

function executeBoundaryModule(sourceText: string): BoundaryModule {
  return executeTypeScriptModule(sourceText) as unknown as BoundaryModule;
}

async function checkMutationProof(): Promise<void> {
  // Every mutant is transpiled and executed in a fresh VM module.  No source
  // file is written and no regex is used as the oracle: each changed module
  // must fail the same observable behavior contract as the real module.
  const original = source('components/ui/scrollBoundary.ts');
  const cases: Array<[NativeStub.Platform['OS'], Record<string, unknown>, Record<string, unknown>]> = [
    ['ios', { scrollBoundary: 'bounded' }, { bounces: false, alwaysBounceVertical: false }],
    ['ios', { scrollBoundary: 'refresh' }, { bounces: true, alwaysBounceVertical: true }],
    ['android', { scrollBoundary: 'bounded' }, { overScrollMode: 'never' }],
    ['android', { scrollBoundary: 'refresh' }, { overScrollMode: 'never' }],
    ['web', { scrollBoundary: 'bounded' }, { style: { overscrollBehaviorY: 'none' } }],
    ['web', { scrollBoundary: 'refresh' }, { style: { overscrollBehaviorY: 'none' } }],
    ['web', { horizontal: true }, {}],
  ];
  const expected = (module: BoundaryModule, platform: NativeStub.Platform['OS'], props: Record<string, unknown>) =>
    JSON.stringify(module.scrollBoundaryProps(platform, props));
  const expectedCases = cases.map(([platform, props, result]) => [platform, props, JSON.stringify(result)] as const);

  const mutants = [
    { name: 'iOS bounces', needle: 'bounces: refresh', replacement: 'bounces: false' },
    { name: 'iOS always bounce', needle: 'alwaysBounceVertical: refresh', replacement: 'alwaysBounceVertical: false' },
    { name: 'Android edge glow', needle: "overScrollMode: 'never'", replacement: "overScrollMode: 'auto'" },
    { name: 'web overscroll', needle: "overscrollBehaviorY: 'none'", replacement: "overscrollBehaviorY: 'auto'" },
    { name: 'horizontal exemption', needle: 'if (horizontal) return {};', replacement: 'if (false) return {};' },
  ];
  for (const mutant of mutants) {
    const mutated = original.replace(mutant.needle, mutant.replacement);
    assert(`runtime mutation changed ${mutant.name} in memory`, mutated !== original);
    try {
      const module = executeBoundaryModule(mutated);
      const killed = expectedCases.some(([platform, props, result]) => expected(module, platform, props) !== result);
      assert(`runtime mutation changes ${mutant.name} contract`, killed);
    } catch (error) {
      fail(`runtime mutation ${mutant.name} did not execute: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Adoption is also mutated in memory.  The same source guard that protects
  // production roots must reject a Today import changed back to native RN.
  const today = source('app/(patient)/today.tsx');
  const todayMutant = today.replace(
    "import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';",
    "import { ScrollView } from 'react-native';",
  );
  assert('Today adoption mutant changed in memory', todayMutant !== today);
  assert(
    'Today adoption mutation is rejected by the raw-import contract',
    hasRawNativeImport(todayMutant, 'ScrollView'),
  );

  // Execute the changed Today module from a disposable temp copy.  This is
  // deliberately outside app/ so the production source is never edited; the
  // same tsx loader and the same native stubs mount the mutated screen.
  const mutantPath = path.join(ROOT, 'scripts/.scroll-boundary-today-mutant.tsx');
  fs.writeFileSync(mutantPath, todayMutant, 'utf8');
  try {
    const module = (await import(`${pathToFileURL(mutantPath).href}?scroll-boundary-mutant=1`)) as {
      default: () => React.ReactElement;
    };
    Platform.OS = 'web';
    let renderer: Renderer | undefined;
    try {
      renderer = render(h(module.default));
      assert('runtime Today adoption mutation loses shared web boundary', screenBoundaryNode(renderer.root) === undefined);
    } finally {
      if (renderer) unmount(renderer);
    }
  } catch (error) {
    fail(`runtime Today adoption mutation did not execute: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    fs.rmSync(mutantPath, { force: true });
  }
}

function executePageScrollModule(sourceText: string): Record<string, unknown> {
  return executeTypeScriptModule(sourceText, request => {
    if (request === 'react') return React;
    if (request === 'react/jsx-runtime') return JsxRuntime;
    if (request === 'react-native') return NativeStub;
    if (request === './scrollBoundary') return { scrollBoundaryProps };
    throw new Error(`unexpected PageScrollView dependency: ${request}`);
  });
}

function checkWrapperMutationProof(): void {
  const original = source('components/ui/PageScrollView.tsx');
  const mutants = [
    {
      name: 'PageScrollView prop spread',
      needle: '        {...props}\n',
      replacement: '',
      catches: (node: TestNode, _ref: React.RefObject<unknown>) => node.props.onScroll === undefined,
    },
    {
      name: 'PageScrollView ref forwarding',
      needle: 'ref={ref}',
      replacement: 'ref={undefined}',
      catches: (_node: TestNode, ref: React.RefObject<unknown>) => ref.current === null,
    },
    {
      name: 'PageScrollView web style boundary',
      needle: 'style={style ? [props.style, style] : props.style}',
      replacement: 'style={props.style}',
      catches: (node: TestNode, _ref: React.RefObject<unknown>) =>
        flattenStyle(node.props.style).overscrollBehaviorY !== 'none',
    },
  ];
  for (const mutant of mutants) {
    const mutated = original.replace(mutant.needle, mutant.replacement);
    assert(`wrapper mutation changed ${mutant.name} in memory`, mutated !== original);
    try {
      const module = executePageScrollModule(mutated) as {
        PageScrollView: React.ComponentType<Record<string, unknown>>;
      };
      Platform.OS = 'web';
      const ref = createRef<unknown>();
      const renderer = render(
        h(module.PageScrollView, {
          ref,
          style: { flex: 1 },
          onScroll: () => {},
        }),
      );
      const node = hosts(renderer.root, 'ScrollView')[0];
      assert(`runtime wrapper mutation changes ${mutant.name} contract`, mutant.catches(node, ref));
      unmount(renderer);
    } catch (error) {
      fail(`runtime wrapper mutation ${mutant.name} did not execute: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function checkRealScreen(screenName: string, elementFactory: () => React.ReactElement): void {
  let renderer: Renderer | undefined;
  for (const platform of ['web', 'ios', 'android'] as const) {
    Platform.OS = platform;
    try {
      renderer = render(elementFactory());
      const boundary = screenBoundaryNode(renderer.root);
      assert(`${screenName} ${platform} screen forwards boundary`, boundary !== undefined);
    } catch (error) {
      fail(`${screenName} ${platform} screen did not mount: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (renderer) {
        unmount(renderer);
        renderer = undefined;
      }
    }
  }
}

async function checkRealScreens(): Promise<void> {
  // Load roots after the forwarding host module has been selected.  The tab
  // roots are imported unchanged.  A handful of non-boundary visual
  // leaves use focused stubs (artwork/camera/data-heavy cards); the root and
  // its actual PageScrollView still run through React Test Renderer.
  const welcomeModule = await import('../app/patient-welcome');
  const claimModule = await import('../app/claim-account');
  const todayModule = await import('../app/(patient)/today');
  const diaryModule = await import('../app/(patient)/diary');
  const libraryModule = await import('../app/(patient)/recipes');
  const progressModule = await import('../app/(patient)/progress');
  const planModule = await import('../app/(patient)/plan');
  checkRealScreen('patient welcome', () => h(welcomeModule.default));
  checkRealScreen('claim form', () => h(claimModule.default));
  checkRealScreen('patient today', () => h(todayModule.default));
  checkRealScreen('patient diary', () => h(diaryModule.default));
  checkRealScreen('patient library', () => h(libraryModule.default));
  checkRealScreen('patient progress', () => h(progressModule.default));
  checkRealScreen('patient plan', () => h(planModule.default));
}

async function checkWebFitShellLifecycle(): Promise<void> {
  const globalRecord = globalThis as Record<string, unknown>;
  const oldWindow = globalRecord.window;
  const oldDocument = globalRecord.document;
  const styleNodes: Array<{ dataset: Record<string, string>; textContent: string; removed: boolean }> = [];
  const documentStub = {
    head: {
      appendChild(node: (typeof styleNodes)[number]) {
        styleNodes.push(node);
      },
    },
    createElement(_tag: string) {
      const node = {
        dataset: {} as Record<string, string>,
        textContent: '',
        removed: false,
        remove() {
          node.removed = true;
        },
      };
      return node;
    },
  };
  globalRecord.window = { location: { search: '' } };
  globalRecord.document = documentStub;

  try {
    // WebFitShell and webLayout are loaded only after the DOM is present, so
    // this exercises the actual effect rather than merely checking its text.
    const shellModule = (await import('../components/WebFitShell')) as {
      WebFitShell: (props: { children: React.ReactNode; testID?: string }) => React.ReactElement;
    };
    Platform.OS = 'web';
    const rootRenderer = render(
      h(shellModule.WebFitShell, { testID: 'shell-root', children: h('Text', null, 'root app') }),
    );
    const modalRenderer = render(
      h(shellModule.WebFitShell, { testID: 'shell-modal', children: h('Text', null, 'modal sheet') }),
    );
    assert('concurrent WebFitShell instances append two boundary style nodes', styleNodes.length === 2);
    equal('root WebFitShell style carries boundary CSS', styleNodes[0]?.textContent, WEB_SCROLL_BOUNDARY_CSS);
    equal('modal WebFitShell style carries boundary CSS', styleNodes[1]?.textContent, WEB_SCROLL_BOUNDARY_CSS);
    equal('root WebFitShell style carries marker', styleNodes[0]?.dataset.thinnrScrollBoundary, '');
    equal('modal WebFitShell style carries marker', styleNodes[1]?.dataset.thinnrScrollBoundary, '');
    unmount(modalRenderer);
    assert('closing modal WebFitShell removes only its style node', styleNodes[1]?.removed === true);
    assert('closing modal WebFitShell preserves root style node', styleNodes[0]?.removed === false);
    unmount(rootRenderer);
    assert('unmounting root WebFitShell removes its own style node', styleNodes[0]?.removed === true);
  } catch (error) {
    fail(`WebFitShell CSS lifecycle did not mount: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (oldWindow === undefined) delete globalRecord.window;
    else globalRecord.window = oldWindow;
    if (oldDocument === undefined) delete globalRecord.document;
    else globalRecord.document = oldDocument;
  }
}

async function main(): Promise<void> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const realConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    realConsoleError(...args);
  };

  const rendererModule = (await import('react-test-renderer')) as unknown as {
    default?: { create?: (element: React.ReactElement) => Renderer };
    create?: (element: React.ReactElement) => Renderer;
  };
  const renderer = rendererModule.default ?? rendererModule;
  if (!renderer.create) throw new Error('react-test-renderer did not expose create()');
  createRenderer = renderer.create.bind(renderer);

  checkBoundaryPrimitive();
  checkPageWrappers();
  checkKeyboardCompat();
  checkSourceAdoption();
  checkCssLifecycle();
  await checkMutationProof();
  checkWrapperMutationProof();
  await checkRealScreens();
  await checkWebFitShellLifecycle();
  finish();
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});