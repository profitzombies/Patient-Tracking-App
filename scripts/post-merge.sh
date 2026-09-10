#!/bin/bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm --filter db push
# Generate shared declarations before dependent artifact builds/typechecks.
pnpm --filter @workspace/api-spec run codegen
# The patient source of truth is the existing Supabase project, not Drizzle.
node scripts/apply-coach-migrations.mjs
