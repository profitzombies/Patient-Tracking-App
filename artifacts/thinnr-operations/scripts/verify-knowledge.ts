/**
 * AI Support knowledge base — live end-to-end check of the deployed rules.
 *
 * The hermetic vitest suites already pin the route logic; this script checks
 * what only the LIVE stack can prove:
 *
 *   1. RLS: anonymous PostgREST reads of knowledge_documents see nothing —
 *      the API server (service role) stays the only road into the library.
 *   2. The API itself is OPEN (demo posture): tokenless callers list the
 *      library and mint upload URLs — reaching the admin page is enough, the
 *      old 401 gate is retired — and a bearer-carrying call behaves
 *      identically, so signed-in staff keep working unchanged. Abuse is
 *      bounded by the per-IP write limiter instead, which must deny a
 *      rapid-fire burst with retryable 429s while reads stay unlimited.
 *   3. The seeded library is genuinely usable: the five starting documents
 *      are `ready`, and the detail endpoint serves extracted text whose
 *      length matches the advertised character count, plus routing aids
 *      (summary + keywords) for the chat task that depends on this.
 *
 * Live suite — needs SUPABASE_URL + SUPABASE_ANON_KEY (for the RLS check)
 * and the API server running (the `artifacts/api-server` workflow). The
 * library is only read: the write-path proof mints an upload URL (nothing
 * is ever uploaded) and the limiter proof burns tokens on invalid bodies
 * that fail validation before touching storage.
 *
 *   pnpm --filter @workspace/thinnr-operations run test:knowledge
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const API_BASE = (process.env.STAFF_API_BASE ?? 'http://localhost:80').replace(/\/$/, '');

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY in the environment.');
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, '');

/** One synthetic client IP for the limiter proof (TEST-NET-3, never real). */
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

  console.log('2. The API is open (demo posture) with per-IP write limits');
  const openList = await apiList(null);
  check(
    'tokenless caller lists the library — the old 401 gate is retired',
    openList.status === 200,
    String(openList.status),
  );
  const bearerList = await apiList('synthetic-staff-bearer');
  check(
    'bearer-carrying caller behaves identically (signed-in staff unchanged)',
    bearerList.status === 200,
    String(bearerList.status),
  );

  const mint = await apiPost('/knowledge/upload-url', {
    fileName: 'qa-open-posture-check.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
  });
  check(
    'tokenless caller mints an upload URL (document management is open)',
    mint.status === 200 &&
      typeof mint.json?.uploadUrl === 'string' &&
      typeof mint.json?.documentId === 'string',
    `status ${mint.status}`,
  );

  // The limiter proof: rapid-fire writes from one synthetic client IP
  // (trust proxy honors X-Forwarded-For) until a denial appears. Invalid
  // bodies burn limiter tokens but fail validation before touching storage.
  let denial: any = null;
  let attempts = 0;
  for (let i = 0; i < 30 && denial === null; i++) {
    attempts += 1;
    const res = await apiPost('/knowledge/documents', {}, { 'X-Forwarded-For': LIMITER_IP });
    if (res.status === 429) denial = res.json;
  }
  check('rapid-fire writes trip the per-IP limiter', denial !== null, `no 429 in ${attempts} attempts`);
  check(
    'limiter denial is retryable and phrased for people',
    denial?.retryable === true && String(denial?.error ?? '').includes('too quickly'),
    JSON.stringify(denial),
  );
  const drainedRead = await fetch(`${API_BASE}/api/knowledge/documents`, {
    headers: { 'X-Forwarded-For': LIMITER_IP },
  });
  await drainedRead.json().catch(() => null);
  check('reads stay unlimited on the drained IP', drainedRead.status === 200, String(drainedRead.status));

  console.log('3. The seeded library is ready and genuinely extracted');
  const documents: any[] = openList.json?.documents ?? [];
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
    const detailResponse = await fetch(`${API_BASE}/api/knowledge/documents/${sample.id}`);
    const detail: any = await detailResponse.json().catch(() => null);
    check(
      'detail endpoint serves the full extracted text (tokenless)',
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
