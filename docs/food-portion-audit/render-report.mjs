// Dependency-free static document export; does not register or change an app.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inline = value => escape(value).replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const lines = readFileSync(join(import.meta.dirname, 'README.md'), 'utf8').split('\n');
const blocks = [];
let index = 0;
while (index < lines.length) {
  const line = lines[index];
  if (!line.trim()) { index++; continue; }
  if (line.startsWith('```')) {
    const code = [];
    while (++index < lines.length && !lines[index].startsWith('```')) code.push(lines[index]);
    blocks.push(`<pre>${escape(code.join('\n'))}</pre>`);
    index++;
    continue;
  }
  const heading = /^(#{1,6}) (.*)$/.exec(line);
  if (heading) {
    blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    index++;
    continue;
  }
  if (line.startsWith('|')) {
    const rows = [];
    while (index < lines.length && lines[index].startsWith('|')) rows.push(lines[index++]);
    const cells = row => row.slice(1, -1).split('|').map(cell => inline(cell.trim()));
    blocks.push(`<div class="table"><table><thead><tr>${cells(rows[0]).map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
      rows.slice(2).map(row => `<tr>${cells(row).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')
    }</tbody></table></div>`);
    continue;
  }
  if (line.startsWith('- ')) {
    const items = [];
    while (index < lines.length && lines[index].startsWith('- ')) items.push(lines[index++].slice(2));
    blocks.push(`<ul>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`);
    continue;
  }
  const paragraph = [line.trim()];
  while (++index < lines.length && lines[index].trim() && !/^(#|- |\||```)/.test(lines[index])) {
    paragraph.push(lines[index].trim());
  }
  blocks.push(`<p>${inline(paragraph.join(' '))}</p>`);
}
writeFileSync(join(import.meta.dirname, 'food-portion-audit.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Food portions and conversions — evidence-backed audit</title>
<style>
body{margin:0;background:#f5f6f8;color:#17212b;font:16px/1.6 system-ui,sans-serif}
main{max-width:1080px;margin:32px auto;padding:40px;background:white}
h1{font-size:30px;line-height:1.2}h2{margin-top:40px;border-top:1px solid #dde1e7;padding-top:24px}
h3{margin-top:32px}p,li{overflow-wrap:anywhere}li{margin:8px 0}
code{font-size:.88em;background:#f0f2f5;padding:2px 4px;overflow-wrap:anywhere}
pre{background:#f0f2f5;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;vertical-align:top;border:1px solid #dde1e7;padding:10px}th{background:#f0f2f5}
@media(max-width:700px){main{margin:0;padding:20px}h1{font-size:26px}}
@media print{body{background:white;font-size:11px}main{margin:0;padding:0;max-width:none}
.table{overflow:visible}h2,h3{break-after:avoid}tr{break-inside:avoid}table{font-size:10px}}
</style></head><body><main>${blocks.join('\n')}</main></body></html>\n`);