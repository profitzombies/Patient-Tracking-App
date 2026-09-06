---
name: PL/pgSQL table-return traps
description: PostgreSQL return-table quirks that compile but fail only when called through PostgREST.
---

In a PL/pgSQL function declared with `RETURNS TABLE`, output column names are variables in the function body. Qualify source columns that use the same names. Also cast `sum(bigint)` explicitly when the declared output is `bigint`, because PostgreSQL returns `numeric` for that aggregate.

**Why:** Both mistakes can survive migration application and function creation, then fail only on a real RPC call with ambiguous-column or return-shape errors.

**How to apply:** After applying aggregate RPC migrations, call them through PostgREST with the actual service role and validate row count, date bounds, and field shape; schema existence checks are not sufficient.