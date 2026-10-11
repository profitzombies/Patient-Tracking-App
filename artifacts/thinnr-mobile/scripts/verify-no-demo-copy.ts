/**
 * Lint-style guard: no user-visible string in the mobile app may mention
 * "demo". The guided demo was removed before the first store build; this
 * keeps demo-looking copy from creeping back in through a stray string.
 *
 * Scans every app-code file (app, components, context, hooks, lib, data,
 * constants) after stripping comments, and fails on a /demo/i match inside
 *   - a string literal ('…', "…", `…`), or
 *   - JSX text (the characters between a closing `>` and the next `<`).
 * Identifiers and comments are not copy and are ignored. Server wire values
 * (`demo_staff` / `demo_patient` profile kinds) are explicitly allowed.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:no-demo-copy
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['app', 'components', 'context', 'hooks', 'lib', 'data', 'constants'];
const EXTENSIONS = new Set(['.ts', '.tsx']);
const ALLOWED = [/demo_staff/i, /demo_patient/i];

function listFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/** Remove block and line comments while leaving string contents untouched. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      // Preserve line structure so reported line numbers stay accurate.
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line += 1;
  return line;
}

function scan(file: string): Hit[] {
  const source = stripComments(fs.readFileSync(file, 'utf8'));
  const hits: Hit[] = [];
  const record = (index: number, text: string) => {
    if (!/demo/i.test(text)) return;
    if (ALLOWED.some(rule => rule.test(text)) && !/demo/i.test(text.replace(/demo_(staff|patient)/gi, ''))) return;
    hits.push({ file: path.relative(ROOT, file), line: lineOf(source, index), text: text.trim() });
  };
  const literal = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  for (const match of source.matchAll(literal)) record(match.index ?? 0, match[0]);
  // JSX text: between a tag close and the next tag open, on a line that is
  // not plain code (a `>` followed by prose). Expression braces are code.
  const jsxText = />([^<>{}]*[A-Za-z][^<>{}]*)</g;
  for (const match of source.matchAll(jsxText)) record(match.index ?? 0, match[1]);
  return hits;
}

const files = SCAN_DIRS.flatMap(dir => listFiles(path.join(ROOT, dir)));
const hits = files.flatMap(scan);

if (hits.length > 0) {
  console.error(`✗ no-demo-copy: ${hits.length} user-visible string(s) mention "demo":`);
  for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  ${hit.text}`);
  process.exit(1);
}
console.log(`✓ no-demo-copy: ${files.length} app files carry no "demo" copy`);
