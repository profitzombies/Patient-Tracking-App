import assert from 'node:assert/strict';
import { meetsHqPasswordPolicy } from '../src/lib/hq-setup';

assert(meetsHqPasswordPolicy('Secure!Pass9'));
assert(!meetsHqPasswordPolicy('short!A'));
assert(!meetsHqPasswordPolicy('alllowercase!'));
assert(!meetsHqPasswordPolicy('NOLOWERCASE!'));
assert(!meetsHqPasswordPolicy('NoSymbolPassword'));
console.log('HQ setup password policy regression checks passed.');