/**
 * AI Support knowledge base — live end-to-end check of the deployed rules.
 *
 * The hermetic vitest suites already pin the route logic; this script checks
 * what only the LIVE stack can prove:
 *
 *   1. RLS: anonymous PostgREST reads of knowledge_documents see nothing.
 *   2. API auth: anonymous callers get 401, office staff get 403 — the
 *      library is HQ-admin-only end to end.
 *   3. The seeded library is genuinely usable: the five starting documents
 *      are `ready`, and the detail endpoint serves extracted text whose
 *      length matches the advertised character count, plus routing aids
 *      (summary + keywords) for the chat task that depends on this.
 *
 * Live suite — needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY +
 * SUPABASE_ANON_KEY and the API server running (the `artifacts/api-server`
 * workflow). Throwaway accounts are created and deleted; the library itself
 * is only read, never modified.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:knowledge
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const API_BASE = (process.env.STAFF_API_BASE ?? 'http://localhost:80').replace(/\/$/, '');

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in the environment.');
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, '');

const SEEDED_FILES = [
  '0_FINAL_THINNR_Knowledgebase_20250328.docx-4_1787764102611.pdf',
  '1_PATIENT_INSTRUCTION_VIDEO_THINNR_(1)_1787764102612.pdf',
  '2_Thinnr_Approved_Foods_1787764102612.pdf',
  '3_Thinnr_Boost_and_Thinnr_Maintenance_Stack_Product_info_1787764102612.pdf',
  '4_THINNR_Clinical_Training_Document_-_Combined_1787764102612.pdf',
];

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function svc(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty body */
  }
  return { status: response.status, json };
}

async function signIn(email: string, password: string): Promise<string | null> {
  const response = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json: any = await response.json().catch(() => null);
  return response.status === 200 && typeof json?.access_token === 'string' ? json.access_token : null;
}

async function apiList(token: string | null): Promise<{ status: number; json: any }> {
  const response = await fetch(`${API_BASE}/api/knowledge/documents`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const json: any = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function main() {
  const ts = Date.now();
  const password = `Qa!${ts}kb`;
  const hqEmail = `qa-kb-hq-${ts}@thinnr-staff-check.com`;
  const officeEmail = `qa-kb-office-${ts}@thinnr-staff-check.com`;
  const userIds: string[] = [];

  try {
    const health = await fetch(`${API_BASE}/api/healthz`).catch(() => null);
    if (!health || !health.ok) {
      throw new Error(`API server unreachable at ${API_BASE} — start the artifacts/api-server workflow first.`);
    }

    console.log('1. RLS keeps the table invisible without an HQ admin session');
    const anonRest = await fetch(`${BASE}/rest/v1/knowledge_documents?select=id`, {
      headers: { apikey: ANON_KEY!, Authorization: `Bearer ${ANON_KEY}` },
    });
    const anonRows: any = await anonRest.json().catch(() => null);
    check(
      'anonymous PostgREST read returns zero rows',
      anonRest.status === 200 ? Array.isArray(anonRows) && anonRows.length === 0 : anonRest.status === 401,
      `${anonRest.status} ${JSON.stringify(anonRows).slice(0, 120)}`,
    );

    console.log('2. The API is HQ-admin-only');
    const anonApi = await apiList(null);
    check('anonymous API caller gets 401', anonApi.status === 401, String(anonApi.status));

    for (const [email, role, code] of [
      [hqEmail, 'hq_admin', null],
      [officeEmail, 'provider_staff', 'acct-p1'],
    ] as const) {
      const assignment = await svc('POST', '/rest/v1/staff_role_assignments', {
        email,
        role,
        provider_account_code: code,
      });
      if (assignment.status !== 201) throw new Error(`assignment insert failed (${assignment.status})`);
      const created = await svc('POST', '/auth/v1/admin/users', {
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: 'QA Knowledge Check' },
      });
      const id = created.json?.id ?? created.json?.user?.id;
      if (!id) throw new Error(`admin create failed (${created.status})`);
      userIds.push(id);
    }
    const hqToken = await signIn(hqEmail, password);
    const officeToken = await signIn(officeEmail, password);
    if (!hqToken || !officeToken) throw new Error('could not sign in the QA accounts');

    const officeApi = await apiList(officeToken);
    check('office staff gets 403', officeApi.status === 403, String(officeApi.status));

    console.log('3. The seeded library is ready and genuinely extracted');
    const hqApi = await apiList(hqToken);
    check('HQ admin lists the library', hqApi.status === 200, String(hqApi.status));
    const documents: any[] = hqApi.json?.documents ?? [];
    check('at least the five starting documents exist', documents.length >= 5, String(documents.length));

    for (const fileName of SEEDED_FILES) {
      const doc = documents.find((candidate) => candidate.originalFilename === fileName);
      if (!doc) {
        check(`${fileName} present`, false, 'not in the list');
        continue;
      }
      check(
        `${doc.title}: ready with text and routing aids`,
        doc.status === 'ready' &&
          doc.extractedChars > 0 &&
          typeof doc.summary === 'string' &&
          doc.summary.length > 0 &&
          Array.isArray(doc.keywords) &&
          doc.keywords.length > 0,
        `status=${doc.status} chars=${doc.extractedChars} summary=${Boolean(doc.summary)} keywords=${doc.keywords?.length}`,
      );
    }

    const sample = documents.find((candidate) => candidate.originalFilename === SEEDED_FILES[2]);
    if (sample) {
      const detailResponse = await fetch(`${API_BASE}/api/knowledge/documents/${sample.id}`, {
        headers: { Authorization: `Bearer ${hqToken}` },
      });
      const detail: any = await detailResponse.json().catch(() => null);
      check(
        'detail endpoint serves the full extracted text',
        detailResponse.status === 200 &&
          typeof detail?.extractedText === 'string' &&
          detail.extractedText.length === detail.extractedChars,
        `${detailResponse.status} len=${detail?.extractedText?.length} chars=${detail?.extractedChars}`,
      );
      check(
        'approved-foods text reads like the real document',
        typeof detail?.extractedText === 'string' && /food|protein|vegetable/i.test(detail.extractedText),
      );
    }
  } finally {
    const emailList = [hqEmail, officeEmail].map((email) => `"${email}"`).join(',');
    await svc('DELETE', `/rest/v1/staff_role_assignments?email=in.(${emailList})`);
    for (const id of [...new Set(userIds)]) {
      await svc('DELETE', `/auth/v1/admin/users/${id}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nThe AI Support knowledge base holds end to end.');
}

void main().catch((error) => {
  console.error('Suite crashed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
