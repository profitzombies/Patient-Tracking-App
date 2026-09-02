import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { OrdinaryTextInput } from '@/components/ui/OrdinaryTextInput';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (flattened, entry) => ({ ...flattened, ...flattenStyle(entry) }),
      {},
    );
  }
  assert.equal(typeof style, 'object', 'TextInput style must be an object or style array');
  return style as Record<string, unknown>;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory)).flatMap(name => {
    const path = join(directory, name);
    return statSync(join(root, path)).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

const contract = read('components/ui/OrdinaryTextInput.tsx');
assert.match(contract, /letterSpacing:\s*0/, 'ordinary editable-text contract must explicitly disable tracking');
assert.match(
  contract,
  /style=\{\[style,\s*ORDINARY_EDITABLE_TEXT\]\}/,
  'the contract must follow caller styles so accidental overrides cannot win',
);

async function verifyRenderedContract(): Promise<void> {
  // This renders the real contract through react-test-renderer. The focused
  // tsconfig maps react-native to the existing host-component test stub, letting
  // us inspect the same style prop RN receives without loading native bindings.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    originalConsoleError(...args);
  };
  try {
    let typographyTree!: ReturnType<typeof create>;
    await act(async () => {
      typographyTree = create(
        React.createElement(OrdinaryTextInput, {
          testID: 'ordinary-input-contract',
          style: [{ color: '#123456', letterSpacing: 3 }, { letterSpacing: 1.5 }],
        }),
      );
    });
    const renderedInputs = typographyTree.root.findAll(
      node => node.type === 'TextInput' && node.props.testID === 'ordinary-input-contract',
    );
    assert.equal(renderedInputs.length, 1, 'the contract must render one native TextInput host');
    const renderedInput = renderedInputs[0];
    assert.equal(
      flattenStyle(renderedInput.props.style).letterSpacing,
      0,
      'the rendered ordinary TextInput must end with untracked editable text even when callers request tracking',
    );
    await act(async () => {
      typographyTree.unmount();
    });
  } finally {
    console.error = originalConsoleError;
  }
}

const allSources = [...sourceFiles('app'), ...sourceFiles('components')];
for (const path of allSources) {
  const source = read(path);
  if (/<TextInput(?=[\s/])/.test(source)) {
    assert.match(
      source,
      /OrdinaryTextInput as TextInput/,
      `${relative(root, path)} has an ordinary TextInput outside the shared typography contract`,
    );
  }
}

const onboardingFields = read('components/onboarding/OnboardingFields.tsx');
assert.equal(
  (onboardingFields.match(/<NativeTextInput(?=[\s/])/g) ?? []).length,
  2,
  'only CodeInput and BigNumberInput may use the narrow native-input escape hatch',
);
assert.match(onboardingFields, /codeInput:[\s\S]*?letterSpacing:\s*10/);
assert.match(onboardingFields, /bigInput:[\s\S]*?letterSpacing:\s*-1/);
assert.match(onboardingFields, /export function LedgerInput[\s\S]*?<TextInput/);

const representativeFields: Array<[string, string, string]> = [
  ['app/log-food.tsx', 'testID="logfood-search"', 'placeholder="Search foods and recipes..."'],
  ['components/ui/ScreenHeader.tsx', 'testID="header-search-input"', 'placeholder="Search..."'],
  ['app/(tabs)/patients.tsx', 'testID="patients-search-input"', 'placeholder="Search patients..."'],
  ['app/approved-foods.tsx', 'testID="approved-search"', 'placeholder="Search approved foods..."'],
  ['app/(patient)/recipes.tsx', 'testID="recipes-search"', 'placeholder="Search recipes..."'],
  ['app/(patient)/recipes.tsx', 'testID="foods-search"', 'placeholder="Search all foods..."'],
  ['app/(tabs)/training.tsx', 'testID="training-add-email"', 'placeholder="Work email"'],
  ['app/patient-login.tsx', 'testID="login-password"', 'placeholder="Your password"'],
  ['app/barcode-scan.tsx', 'testID="barcode-input"', 'placeholder="e.g. 3017624010701"'],
  ['app/check-in.tsx', 'testID="checkin-notes"', 'placeholder="Optional — energy, appetite, anything worth flagging..."'],
  ['app/create-food.tsx', 'testID="createfood-name"', 'placeholder="e.g. Greek yogurt bowl"'],
];

for (const [path, testID, placeholder] of representativeFields) {
  const source = read(path);
  assert.ok(source.includes(testID), `${path} is missing representative ${testID}`);
  assert.ok(source.includes(placeholder), `${path} is missing representative ${placeholder}`);
}

verifyRenderedContract()
  .then(() => console.log(`Editable-text typography verified across ${allSources.length} app/component source files.`))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
