/**
 * Seed the AI Support knowledge base with the five program documents the
 * user uploaded — through the REAL ingest path, not a database shortcut:
 *
 *   presigned upload-url → PUT to App Storage → finalize (server verifies
 *   the object) → server-side text extraction → poll until ready.
 *
 * Proving the extraction pipeline on real material is the point; a direct
 * insert would seed rows while leaving the actual path untested. The script
 * is idempotent (keyed by original filename): re-runs skip documents that
 * already exist, retry ones that sit in `failed`, and re-apply the curated
 * display titles through the real rename endpoint.
 *
 * Live script — needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY +
 * SUPABASE_ANON_KEY and the API server running (the `artifacts/api-server`
 * workflow). A throwaway HQ admin drives the API and is deleted afterwards.
 *
 *   pnpm --filter @workspace/thinnr-operations run seed:knowledge
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const API_BASE = (process.env.STAFF_API_BASE ?? 'http://localhost:80').replace(/\/$/, '');

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in the environment.');
  process.exit(1);
}

const BASE = SUPABASE_URL.replace(/\/$/, '');
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

/** The five starting documents. The first is named "…docx-4…pdf" but IS a PDF. */
const DOCUMENTS = [
  {
    file: 'attached_assets/0_FINAL_THINNR_Knowledgebase_20250328.docx-4_1787764102611.pdf',
    title: 'THINNR Knowledge Base',
  },
  {
    file: 'attached_assets/1_PATIENT_INSTRUCTION_VIDEO_THINNR_(1)_1787764102612.pdf',
    title: 'Patient Instruction Video Guide',
  },
  {
    file: 'attached_assets/2_Thinnr_Approved_Foods_1787764102612.pdf',
    title: 'Approved Foods',
  },
  {
    file: 'attached_assets/3_Thinnr_Boost_and_Thinnr_Maintenance_Stack_Product_info_1787764102612.pdf',
    title: 'Boost & Maintenance Stack Product Info',
  },
  {
    file: 'attached_assets/4_THINNR_Clinical_Training_Document_-_Combined_1787764102612.pdf',
    title: 'Clinical Training Document',
  },
] as const;

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 180_000;

interface ApiDocument {
  id: string;
  title: string;
  originalFilename: string;
  status: 'uploaded' | 'extracting' | 'ready' | 'failed';
  errorMessage: string | null;
  extractedChars: number;
  summary: string | null;
  keywords: string[];
}

let failures = 0;
function fail(message: string) {
  failures += 1;
  console.error(`FAIL  ${message}`);
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

async function api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await response.json().catch(() => null);
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

async function waitForOutcome(token: string, id: string, label: string): Promise<ApiDocument | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const { status, json } = await api(token, 'GET', `/knowledge/documents/${id}`);
    if (status !== 200) {
      fail(`${label}: status poll failed (${status})`);
      return null;
    }
    const doc = json as ApiDocument;
    if (doc.status === 'ready' || doc.status === 'failed') return doc;
    if (Date.now() > deadline) {
      fail(`${label}: extraction did not settle within ${POLL_TIMEOUT_MS / 1000}s (stuck at ${doc.status})`);
      return null;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS));
  }
}

async function main() {
  const ts = Date.now();
  const adminEmail = `qa-knowledge-seed-${ts}@thinnr-staff-check.com`;
  const password = `Qa!${ts}seed`;
  let adminUserId: string | null = null;

  try {
    const health = await fetch(`${API_BASE}/api/healthz`).catch(() => null);
    if (!health || !health.ok) {
      throw new Error(`API server unreachable at ${API_BASE} — start the artifacts/api-server workflow first.`);
    }

    // Throwaway HQ admin drives the real authenticated path.
    const assignment = await svc('POST', '/rest/v1/staff_role_assignments', {
      email: adminEmail,
      role: 'hq_admin',
      provider_account_code: null,
    });
    if (assignment.status !== 201) throw new Error(`assignment insert failed (${assignment.status})`);
    const created = await svc('POST', '/auth/v1/admin/users', {
      email: adminEmail,
      password,
      email_confirm: true,
      user_metadata: { display_name: 'QA Knowledge Seeder' },
    });
    adminUserId = created.json?.id ?? created.json?.user?.id ?? null;
    if (!adminUserId) throw new Error(`admin create failed (${created.status})`);
    const token = await signIn(adminEmail, password);
    if (!token) throw new Error('could not sign in the seeding admin');

    const listing = await api(token, 'GET', '/knowledge/documents');
    if (listing.status !== 200) throw new Error(`list failed (${listing.status})`);
    const existing: ApiDocument[] = listing.json?.documents ?? [];

    for (const target of DOCUMENTS) {
      const fileName = basename(target.file);
      const label = target.title;
      let doc = existing.find((candidate) => candidate.originalFilename === fileName) ?? null;

      if (doc && doc.status === 'failed') {
        console.log(`~ ${label}: exists but failed — retrying extraction`);
        const retry = await api(token, 'POST', `/knowledge/documents/${doc.id}/extract`);
        if (retry.status !== 202 && retry.status !== 409) {
          fail(`${label}: retry refused (${retry.status})`);
          continue;
        }
      } else if (doc) {
        console.log(`= ${label}: already in the library (${doc.status})`);
      } else {
        const bytes = readFileSync(resolve(ROOT, target.file));
        console.log(`+ ${label}: uploading ${fileName} (${bytes.length} bytes)`);
        const minted = await api(token, 'POST', '/knowledge/upload-url', {
          fileName,
          contentType: 'application/pdf',
          sizeBytes: bytes.length,
        });
        if (minted.status !== 200) {
          fail(`${label}: upload-url failed (${minted.status}) ${JSON.stringify(minted.json)}`);
          continue;
        }
        const put = await fetch(minted.json.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/pdf' },
          body: bytes,
        });
        if (!put.ok) {
          fail(`${label}: storage PUT failed (${put.status})`);
          continue;
        }
        const finalized = await api(token, 'POST', '/knowledge/documents', {
          documentId: minted.json.documentId,
          objectPath: minted.json.objectPath,
          fileName,
          contentType: 'application/pdf',
        });
        if (finalized.status !== 200) {
          fail(`${label}: finalize failed (${finalized.status}) ${JSON.stringify(finalized.json)}`);
          continue;
        }
        doc = finalized.json as ApiDocument;
      }

      if (!doc) continue;

      const settled = await waitForOutcome(token, doc.id, label);
      if (!settled) continue;
      if (settled.status !== 'ready') {
        fail(`${label}: extraction failed — ${settled.errorMessage ?? 'no message'}`);
        continue;
      }

      // Curated display title through the real rename endpoint.
      if (settled.title !== target.title) {
        const renamed = await api(token, 'PATCH', `/knowledge/documents/${doc.id}`, { title: target.title });
        if (renamed.status !== 200) fail(`${label}: rename failed (${renamed.status})`);
      }
      console.log(
        `  ok  ${label}: ready — ${settled.extractedChars.toLocaleString('en-US')} chars, ` +
          `${settled.keywords.length} keywords${settled.summary ? '' : ' (no summary!)'}`,
      );
    }

    // Service-role spot check: everything the library claims must be real.
    const rows = await svc(
      'GET',
      '/rest/v1/knowledge_documents?select=title,original_filename,status,extracted_chars&order=created_at.asc',
    );
    const byFile = new Map<string, any>(
      (Array.isArray(rows.json) ? rows.json : []).map((row: any) => [row.original_filename, row]),
    );
    for (const target of DOCUMENTS) {
      const row = byFile.get(basename(target.file));
      if (!row) fail(`${target.title}: no row in knowledge_documents`);
      else if (row.status !== 'ready' || !(row.extracted_chars > 0)) {
        fail(`${target.title}: row is ${row.status} with ${row.extracted_chars} chars`);
      }
    }
  } finally {
    await svc('DELETE', `/rest/v1/staff_role_assignments?email=eq.${encodeURIComponent(adminEmail)}`);
    if (adminUserId) await svc('DELETE', `/auth/v1/admin/users/${adminUserId}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} problem(s) — the library is NOT fully seeded.`);
    process.exit(1);
  }
  console.log('\nAll five starting documents are in the library with extracted text.');
}

void main().catch((error) => {
  console.error('Seeding crashed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
