/**
 * AI Support knowledge base — live end-to-end check of the deployed rules.
 *
 * The hermetic vitest suites (api-server knowledge-docs tests) pin the route
 * logic, the permission matrix, and the per-IP write limiter; this script
 * checks what only the LIVE stack can prove:
 *
 *   1. RLS: anonymous PostgREST reads of knowledge_documents see nothing —
 *      the API server (service role) stays the only road into the library.
 *   2. The API enforces the HQ content permission. Since the HQ team-access
 *      work, every /knowledge route requires a signed-in HQ session with
 *      content_manage — the earlier open demo posture is retired. Tokenless
 *      and garbage-bearer callers get 401 on reads AND writes, and the gate
 *      answers BEFORE the write limiter, so anonymous traffic can never buy
 *      a 429 or touch storage. (Limiter and permission-tier behavior for
 *      real sessions stays pinned hermetically, where auth is mockable.)
 *   3. The seeded library is genuinely usable: read through the service role
 *      (the same credential the API server itself uses), the five starting
 *      documents are `ready` with extracted text whose length matches the
 *      advertised character count, plus routing aids (summary + keywords)
 *      for the chat task that depends on this.
 *
 * Live suite — needs SUPABASE_URL, SUPABASE_ANON_KEY (RLS check),
 * SUPABASE_SERVICE_ROLE_KEY (library check) and the API server running (the
 * `artifacts/api-server` workflow). Strictly read-only: the gate rejects
 * every probe before a row or object could exist.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:knowledge
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE = (process.env.STAFF_API_BASE ?? 'http://localhost:80').replace(/\/$/, '');

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error(
    'Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in the environment.',
  );
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, '');

/** One synthetic client IP for the gate-precedes-limiter proof (TEST-NET-3, never real). */
const LIMITER_IP = '203.0.113.77';

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

async function apiList(token: string | null): Promise<{ status: number; json: any }> {
  const response = await fetch(`${API_BASE}/api/knowledge/documents`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const json: any = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function apiPost(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${API_BASE}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json: any = await response.json().catch(() => null);
  return { status: response.status, json };
}

/** Read the library the way the API server itself does: service role via PostgREST. */
async function serviceSelect(query: string): Promise<{ status: number; rows: any }> {
  const response = await fetch(`${BASE}/rest/v1/knowledge_documents?${query}`, {
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const rows: any = await response.json().catch(() => null);
  return { status: response.status, rows };
}

async function main() {
  const health = await fetch(`${API_BASE}/api/healthz`).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(
      `API server unreachable at ${API_BASE} — start the artifacts/api-server workflow first.`,
    );
  }

  console.log('1. RLS keeps the table invisible outside the API server');
  const anonRest = await fetch(`${BASE}/rest/v1/knowledge_documents?select=id`, {
    headers: { apikey: ANON_KEY!, Authorization: `Bearer ${ANON_KEY}` },
  });
  const anonRows: any = await anonRest.json().catch(() => null);
  check(
    'anonymous PostgREST read returns zero rows',
    anonRest.status === 200 ? Array.isArray(anonRows) && anonRows.length === 0 : anonRest.status === 401,
    `${anonRest.status} ${JSON.stringify(anonRows).slice(0, 120)}`,
  );

  console.log('2. The API requires the HQ content permission on every /knowledge route');
  const openList = await apiList(null);
  check('tokenless caller cannot list the library', openList.status === 401, String(openList.status));
  const bearerList = await apiList('synthetic-staff-bearer');
  check(
    'a garbage bearer is not a session (still 401)',
    bearerList.status === 401,
    String(bearerList.status),
  );

  const mint = await apiPost('/knowledge/upload-url', {
    fileName: 'qa-gated-posture-check.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
  });
  check('tokenless caller cannot mint an upload URL', mint.status === 401, `status ${mint.status}`);

  // The gate must answer before the write limiter: a burst of anonymous
  // writes from one synthetic client IP (trust proxy honors X-Forwarded-For)
  // stays 401 throughout — anonymous traffic can never buy a 429, burn
  // limiter tokens for real staff, or reach storage/validation.
  let sawNon401 = null as number | null;
  for (let i = 0; i < 5 && sawNon401 === null; i++) {
    const res = await apiPost('/knowledge/documents', {}, { 'X-Forwarded-For': LIMITER_IP });
    if (res.status !== 401) sawNon401 = res.status;
  }
  check(
    'anonymous write bursts stay 401 (gate precedes the limiter)',
    sawNon401 === null,
    `unexpected status ${sawNon401}`,
  );

  console.log('3. The seeded library is ready and genuinely extracted (service-role read)');
  const list = await serviceSelect(
    'select=id,title,original_filename,status,extracted_chars,summary,keywords&order=original_filename.asc',
  );
  const documents: any[] = Array.isArray(list.rows) ? list.rows : [];
  check('at least the five starting documents exist', documents.length >= 5, `status=${list.status} count=${documents.length}`);

  for (const fileName of SEEDED_FILES) {
    const doc = documents.find((candidate) => candidate.original_filename === fileName);
    if (!doc) {
      check(`${fileName} present`, false, 'not in the list');
      continue;
    }
    check(
      `${doc.title}: ready with text and routing aids`,
      doc.status === 'ready' &&
        doc.extracted_chars > 0 &&
        typeof doc.summary === 'string' &&
        doc.summary.length > 0 &&
        Array.isArray(doc.keywords) &&
        doc.keywords.length > 0,
      `status=${doc.status} chars=${doc.extracted_chars} summary=${Boolean(doc.summary)} keywords=${doc.keywords?.length}`,
    );
  }

  const sample = documents.find((candidate) => candidate.original_filename === SEEDED_FILES[2]);
  if (sample) {
    const detail = await serviceSelect(`select=extracted_text,extracted_chars&id=eq.${sample.id}`);
    const row: any = Array.isArray(detail.rows) ? detail.rows[0] : null;
    check(
      'stored extracted text matches the advertised character count',
      detail.status === 200 &&
        typeof row?.extracted_text === 'string' &&
        row.extracted_text.length === row.extracted_chars,
      `${detail.status} len=${row?.extracted_text?.length} chars=${row?.extracted_chars}`,
    );
    check(
      'approved-foods text reads like the real document',
      typeof row?.extracted_text === 'string' && /food|protein|vegetable/i.test(row.extracted_text),
    );
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
