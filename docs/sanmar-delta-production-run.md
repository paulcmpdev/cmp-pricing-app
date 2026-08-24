# First production SanMar delta and rollback

## Scope and threat boundary

This procedure covers **one manual SanMar SOAP delta** in an approved private
worker environment, followed by verification and, only if necessary, an
explicit rollback.

- It does not provision Railway or any other worker infrastructure.
- It does not create or enable a recurring schedule.
- Inject the target database URL and SanMar credentials through the approved
  secret store. Never paste them into commands, tickets, chat, shell history, or
  logs.
- The rollback protects against application and operator mistakes. It is not a
  defense against a hostile database owner, who can alter tables, triggers, or
  audit records.
- The delta and rollback are separate production mutations. Each is forbidden
  without explicit approval for that exact mutation.

## 1. Preconditions and abort conditions

### Preconditions

- [ ] `main` contains the approved changes; merged-main CI is green and the app
      deployment for that commit is green.
- [ ] The approved private worker checkout is on that same `main` commit and
      includes the deployed `catalog:rollback` CLI.
- [ ] The worker has Node.js 20 and dependencies installed for that checkout.
- [ ] The worker secret store injects `VENDOR_CATALOG_DATABASE_URL`,
      `CMP_SANMAR_CUSTOMER_NUMBER`, `CMP_SANMAR_USERNAME`, and
      `CMP_SANMAR_PASSWORD`. Do not display their values.
- [ ] `APP_URL` is set to the deployed application origin. Do not invent or
      substitute a production URL.
- [ ] Read-only preflight below reports exactly one active SanMar pointer, an
      `active` pointed import, matching positive stored/actual counts, required
      import audit timestamps, a content hash, complete non-null row-level delta
      watermarks with valid oldest values, zero integrity faults, K500 with
      variants, no active ingestion job, and the required rollback audit object
      names/counts, enabled triggers, and index presence.
- [ ] Record the preflight's active import ID as `PRE_DELTA_IMPORT_ID`, together
      with stored/actual counts, content hash, `imported_at`, import/pointer
      `activated_at`, informational import-level source timestamps, and oldest
      style and variant row-level `source_sync_at` values. Import-level
      `source_started_at`, `source_completed_at`, and `source_sync_at` may be null
      for a valid seed, direct, or delta path and are not pre-delta audit gates.
- [ ] Explicit approval for **one production SanMar delta activation** has been
      recorded immediately before the command is run.

### Abort immediately if

- merged-main CI, deployment, worker commit, Node version, secrets, or target is
  missing or inconsistent;
- any required ID, count, content hash, `imported_at`, import `activated_at`, or
  pointer `activated_at` is missing, null, invalid, or inconsistent;
- the pointer does not identify one active SanMar import, stored counts differ
  from actual counts, or either actual count is zero;
- any row-level style or variant `source_sync_at` is null, or either oldest
  row-level `source_sync_at` value is missing/invalid;
- orphan variants or null/negative resolved costs are nonzero;
- K500 is absent or has no variants;
- any SanMar job is `queued`, `running`, or `validating`;
- the required rollback audit object names/counts, enabled triggers, or index
  presence checks fail;
- explicit mutation approval is absent or ambiguous.

Do not “fix forward” during this procedure. Stop, preserve sanitized evidence,
and resolve the failed precondition separately.

## 2. Read-only production preflight

Run from the approved worker checkout. This uses a quoted psql variable
(`:'vendor'`), disables startup files, stops on the first SQL error, and opens a
read-only transaction. It does not select individual costs, credentials,
`source_metadata`, or the database URL.

```bash
psql "$VENDOR_CATALOG_DATABASE_URL" -X \
  --set=ON_ERROR_STOP=1 \
  --set=vendor=sanmar <<'SQL'
\pset pager off
BEGIN TRANSACTION READ ONLY;

-- Active pointer/import details and actual versus stored counts. Import-level
-- source timestamps are informational and may be null; imported_at,
-- import/pointer activated_at, and content_hash are mandatory audit fields.
WITH active AS (
  SELECT a.vendor,
         a.import_id,
         a.activated_at AS pointer_activated_at,
         i.status,
         i.source_status,
         i.source_errors,
         i.source_started_at,
         i.source_completed_at,
         i.source_sync_at,
         i.imported_at,
         i.activated_at AS import_activated_at,
         i.style_count AS stored_style_count,
         i.variant_count AS stored_variant_count,
         i.invalid_price_count,
         i.content_hash
    FROM active_catalog_versions a
    JOIN catalog_imports i
      ON i.id = a.import_id AND i.vendor = a.vendor
   WHERE a.vendor = :'vendor'
)
SELECT active.*,
       (SELECT count(*) FROM catalog_styles s
         WHERE s.import_id = active.import_id) AS actual_style_count,
       (SELECT count(*) FROM catalog_variants v
         WHERE v.import_id = active.import_id) AS actual_variant_count
  FROM active;

-- Mandatory row-level delta watermark coverage on the active version.
WITH active AS (
  SELECT import_id
    FROM active_catalog_versions
   WHERE vendor = :'vendor'
)
SELECT
  (SELECT min(s.source_sync_at) FROM catalog_styles s, active a
    WHERE s.import_id = a.import_id) AS oldest_style_source_sync_at,
  (SELECT count(*) FROM catalog_styles s, active a
    WHERE s.import_id = a.import_id
      AND s.source_sync_at IS NULL) AS null_style_source_sync_at_count,
  (SELECT min(v.source_sync_at) FROM catalog_variants v, active a
    WHERE v.import_id = a.import_id) AS oldest_variant_source_sync_at,
  (SELECT count(*) FROM catalog_variants v, active a
    WHERE v.import_id = a.import_id
      AND v.source_sync_at IS NULL) AS null_variant_source_sync_at_count;

-- Referential integrity and invalid-cost counts; no individual costs are shown.
WITH active AS (
  SELECT import_id
    FROM active_catalog_versions
   WHERE vendor = :'vendor'
)
SELECT
  count(*) FILTER (WHERE s.id IS NULL) AS orphan_variant_count,
  count(*) FILTER (
    WHERE v.resolved_cost IS NULL OR v.resolved_cost < 0
  ) AS invalid_resolved_cost_count
FROM active a
JOIN catalog_variants v ON v.import_id = a.import_id
LEFT JOIN catalog_styles s
  ON s.import_id = v.import_id AND s.id = v.style_id;

-- Known SanMar canary and its variants; no price or cost columns are selected.
WITH active AS (
  SELECT import_id
    FROM active_catalog_versions
   WHERE vendor = :'vendor'
)
SELECT s.style_code,
       count(DISTINCT s.id) AS style_rows,
       count(v.id) AS variant_rows
  FROM active a
  JOIN catalog_styles s
    ON s.import_id = a.import_id
   AND s.vendor = :'vendor'
   AND s.style_code = 'K500'
  LEFT JOIN catalog_variants v
    ON v.import_id = s.import_id AND v.style_id = s.id
 GROUP BY s.style_code;

-- There must be no non-terminal SanMar ingestion job.
SELECT status, count(*) AS job_count
  FROM catalog_ingestion_jobs
 WHERE vendor = :'vendor'
   AND status IN ('queued', 'running', 'validating')
 GROUP BY status
 ORDER BY status;

-- Required rollback audit object names/counts, enabled triggers, and index presence.
WITH audit_table AS (
  SELECT to_regclass(
    format('%I.%I', current_schema(), 'catalog_rollbacks')
  ) AS oid
)
SELECT a.oid IS NOT NULL AS table_exists,
       (SELECT count(*) FROM pg_constraint c
         WHERE c.conrelid = a.oid
           AND c.contype <> 'n') AS business_constraint_count,
       (SELECT count(*) = 7
          FROM pg_constraint c
         WHERE c.conrelid = a.oid
           AND c.conname = ANY (ARRAY[
             'catalog_rollbacks_pkey',
             'catalog_rollbacks_vendor_check',
             'catalog_rollbacks_requested_by_check',
             'catalog_rollbacks_reason_check',
             'catalog_rollbacks_imports_distinct_check',
             'catalog_rollbacks_from_import_vendor_fkey',
             'catalog_rollbacks_to_import_vendor_fkey'
           ])) AS required_constraints_present,
       (SELECT count(*) FROM pg_trigger t
         WHERE t.tgrelid = a.oid AND NOT t.tgisinternal AND t.tgenabled <> 'D')
         AS enabled_trigger_count,
       (SELECT count(*) = 2
          FROM pg_trigger t
         WHERE t.tgrelid = a.oid
           AND NOT t.tgisinternal
           AND t.tgenabled <> 'D'
           AND t.tgname = ANY (ARRAY[
             'trg_catalog_rollbacks_append_only',
             'trg_catalog_rollbacks_prevent_truncate'
           ])) AS required_triggers_enabled,
       to_regclass(format('%I.%I', current_schema(),
         'idx_catalog_rollbacks_vendor_rolled_back_at')) IS NOT NULL
         AS vendor_time_index_exists,
       to_regclass(format('%I.%I', current_schema(),
         'idx_catalog_rollbacks_from_import_vendor')) IS NOT NULL
         AS from_import_index_exists,
       to_regclass(format('%I.%I', current_schema(),
         'idx_catalog_rollbacks_to_import_vendor')) IS NOT NULL
         AS to_import_index_exists
  FROM audit_table a;

COMMIT;
SQL
```

Expected rollback contract values are `table_exists = true`,
`business_constraint_count = 7`, `required_constraints_present = true`,
`enabled_trigger_count = 2`, `required_triggers_enabled = true`, and all three
index flags `true`. PostgreSQL 18 exposes `NOT NULL` declarations as
`pg_constraint` rows with `contype = 'n'`; those rows are intentionally excluded
from the seven business constraints. The non-terminal-jobs query must return zero
rows.

This read-only query checks required object names/counts, enabled triggers, and
index presence; it does not validate complete object definitions. Exact
definitions are fail-closed when the rollback CLI applies
`VENDOR_CATALOG_POSTGRES_SCHEMA_SQL` before inspection, and CI/schema tests
validate the PostgreSQL 16 definitions.

After reviewing the output, set the ID without printing it:

```bash
read -r -p "PRE_DELTA_IMPORT_ID from reviewed preflight: " PRE_DELTA_IMPORT_ID
export PRE_DELTA_IMPORT_ID
```

Do not continue if the entered ID differs from the preflight pointer.

## 3. Approval gate and one-shot delta

- [ ] Present the sanitized preflight record and exact command to the approver.
- [ ] Record explicit approval for this one production mutation.
- [ ] Confirm no new SanMar job appeared after preflight.

Run exactly once:

```bash
CMP_SANMAR_SOURCE=soap npm run catalog:sync -- --vendor sanmar --sanmar-source soap --sanmar-mode delta --target-url "$VENDOR_CATALOG_DATABASE_URL"
```

This command clones, patches, validates, and atomically activates a new catalog.
It is a production mutation and is forbidden without explicit mutation
approval. Do not retry a failed or interrupted command until a new read-only
preflight explains the current pointer and job state and a new approval is
obtained.

## 4. Capture the delta result

The CLI prints sanitized JSON. Do not copy environment values, shell debug
output, credentials, database URLs, source payloads, or `source_metadata`.

- [ ] Record `importId` as `NEW_DELTA_IMPORT_ID` and confirm `activated: true`,
      `mode: "delta"`, `vendor: "sanmar"`, and `baseImportId` equals
      `PRE_DELTA_IMPORT_ID`.
- [ ] Record `modifiedStyleCount`, `patchedStyleCount`, `removedStyleCount`,
      `styleCount`, `variantCount`, `skippedCount`, and `contentHash`.
- [ ] Record `requestCount`, `patchedVariantCount`, and `sourceErrors` from only
      the completed job's selected scalar checkpoint fields in the post-run SQL
      below. Do not copy the whole checkpoint.
- [ ] Require `skippedCount = 0` and `sourceErrors = 0`. Any discrepancy is a
      rollback assessment trigger.

Set the new ID without printing it:

```bash
read -r -p "NEW_DELTA_IMPORT_ID from sanitized CLI JSON: " NEW_DELTA_IMPORT_ID
export NEW_DELTA_IMPORT_ID
```

## 5. Post-run database verification

Use psql variables so both IDs are quoted and cast as UUIDs by PostgreSQL:

```bash
psql "$VENDOR_CATALOG_DATABASE_URL" -X \
  --set=ON_ERROR_STOP=1 \
  --set=vendor=sanmar \
  --set=pre_delta_import_id="$PRE_DELTA_IMPORT_ID" \
  --set=new_delta_import_id="$NEW_DELTA_IMPORT_ID" <<'SQL'
\pset pager off
BEGIN TRANSACTION READ ONLY;

-- Pointer, old/new statuses, stored/actual counts, timestamps, and hash.
SELECT a.import_id AS active_import_id,
       i.id AS inspected_import_id,
       i.status,
       i.style_count AS stored_style_count,
       i.variant_count AS stored_variant_count,
       (SELECT count(*) FROM catalog_styles s
         WHERE s.import_id = i.id) AS actual_style_count,
       (SELECT count(*) FROM catalog_variants v
         WHERE v.import_id = i.id) AS actual_variant_count,
       i.source_sync_at AS informational_import_source_sync_at,
       i.source_completed_at,
       i.imported_at,
       i.activated_at,
       i.invalid_price_count,
       i.source_errors,
       i.content_hash
  FROM active_catalog_versions a
  JOIN catalog_imports i
    ON i.vendor = a.vendor
   AND i.id IN (:'pre_delta_import_id'::uuid, :'new_delta_import_id'::uuid)
 WHERE a.vendor = :'vendor'
 ORDER BY i.id;

-- Completed job result: select scalar counts only, never the whole checkpoint.
SELECT status,
       checkpoint->>'modifiedStyleCount' AS modified_style_count,
       checkpoint->>'patchedStyleCount' AS patched_style_count,
       checkpoint->>'patchedVariantCount' AS patched_variant_count,
       checkpoint->>'removedStyleCount' AS removed_style_count,
       checkpoint->>'requestCount' AS request_count,
       checkpoint->>'styleCount' AS final_style_count,
       checkpoint->>'variantCount' AS final_variant_count,
       checkpoint->>'skippedCount' AS skipped_count,
       checkpoint->>'sourceErrors' AS source_errors,
       completed_at
  FROM catalog_ingestion_jobs
 WHERE vendor = :'vendor'
   AND import_id = :'new_delta_import_id'::uuid;

-- Timestamp coverage, integrity, and K500.
WITH chosen AS (
  SELECT :'new_delta_import_id'::uuid AS import_id
)
SELECT
  (SELECT min(source_sync_at) FROM catalog_styles s, chosen c
    WHERE s.import_id = c.import_id) AS oldest_style_source_sync_at,
  (SELECT count(*) FROM catalog_styles s, chosen c
    WHERE s.import_id = c.import_id AND s.source_sync_at IS NULL)
    AS null_style_source_sync_at_count,
  (SELECT min(source_sync_at) FROM catalog_variants v, chosen c
    WHERE v.import_id = c.import_id) AS oldest_variant_source_sync_at,
  (SELECT count(*) FROM catalog_variants v, chosen c
    WHERE v.import_id = c.import_id AND v.source_sync_at IS NULL)
    AS null_variant_source_sync_at_count,
  (SELECT count(*)
     FROM chosen c
     JOIN catalog_variants v ON v.import_id = c.import_id
     LEFT JOIN catalog_styles s
       ON s.import_id = v.import_id AND s.id = v.style_id
    WHERE s.id IS NULL)
    AS orphan_variant_count,
  (SELECT count(*) FROM catalog_variants v, chosen c
    WHERE v.import_id = c.import_id
      AND (v.resolved_cost IS NULL OR v.resolved_cost < 0))
    AS invalid_resolved_cost_count,
  (SELECT count(*) FROM catalog_styles s, chosen c
    WHERE s.import_id = c.import_id AND s.vendor = :'vendor'
      AND s.style_code = 'K500') AS k500_style_rows,
  (SELECT count(*)
     FROM chosen c
     JOIN catalog_styles s
       ON s.import_id = c.import_id
      AND s.vendor = :'vendor'
      AND s.style_code = 'K500'
     JOIN catalog_variants v
       ON v.import_id = s.import_id AND v.style_id = s.id)
    AS k500_variant_rows;

SELECT status, count(*) AS job_count
  FROM catalog_ingestion_jobs
 WHERE vendor = :'vendor'
   AND status IN ('queued', 'running', 'validating')
 GROUP BY status
 ORDER BY status;

COMMIT;
SQL
```

Require the pointer to equal `NEW_DELTA_IMPORT_ID`, the old import to be
`superseded`, the new import to be `active`, stored/actual counts to match,
positive final counts, and the new delta import's `imported_at`, `activated_at`,
and implementation-guaranteed `source_completed_at` to be non-null. Import-level
`source_sync_at` is informational and may be null; do not require import-level
`source_started_at` or `source_sync_at`. Require complete non-null row-level
style/variant `source_sync_at` coverage with valid oldest values, zero
nulls/orphans/invalid costs, K500 with variants, one completed job with zero
errors/skips, and no non-terminal job.

## 6. Application and browser verification

`APP_URL` must already contain the approved deployed origin. These checks do not
print API bodies or individual costs.

```bash
SEARCH_JSON="$(curl --fail --silent --show-error --get \
  "$APP_URL/api/vendor-catalog/search" \
  --data-urlencode 'q=K500' \
  --data-urlencode 'vendor=sanmar')"

printf '%s' "$SEARCH_JSON" | jq -e '
  .available == true and
  ([.results[] | select(.vendor == "sanmar" and .styleCode == "K500")] | length > 0) and
  ([paths(scalars) as $p | ($p[-1] | tostring | ascii_downcase) |
    select(test("cost|price|cogs|basis"))] | length == 0)
' >/dev/null

STYLE_ID="$(printf '%s' "$SEARCH_JSON" | jq -er \
  '[.results[] | select(.vendor == "sanmar" and .styleCode == "K500") | .id][0]')"
VARIANTS_JSON="$(curl --fail --silent --show-error \
  "$APP_URL/api/vendor-catalog/styles/$(jq -rn --arg v "$STYLE_ID" '$v|@uri')/variants')"

printf '%s' "$VARIANTS_JSON" | jq -e '
  .available == true and (.variants | length > 0) and
  ([paths(scalars) as $p | ($p[-1] | tostring | ascii_downcase) |
    select(test("cost|price|cogs|basis"))] | length == 0)
' >/dev/null

VARIANT_ID="$(printf '%s' "$VARIANTS_JSON" | jq -er '.variants[0].id')"
STAFF_QUOTE="$(curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  --data "$(jq -nc --arg id "$VARIANT_ID" '{catalogVariantId:$id,quantity:84}')" \
  "$APP_URL/api/quote/item')"
SPOOFED_QUOTE="$(curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  -H 'x-cmp-role: manager' \
  --data "$(jq -nc --arg id "$VARIANT_ID" '{catalogVariantId:$id,quantity:84}')" \
  "$APP_URL/api/quote/item')"

printf '%s' "$STAFF_QUOTE" | jq -e '
  .requiresManagerReview == false and (has("vendorCatalog") | not)
' >/dev/null
printf '%s' "$SPOOFED_QUOTE" | jq -e '
  .requiresManagerReview == false and (has("vendorCatalog") | not)
' >/dev/null
cmp <(printf '%s' "$STAFF_QUOTE" | jq -S .) \
    <(printf '%s' "$SPOOFED_QUOTE" | jq -S .)
unset SEARCH_JSON VARIANTS_JSON STAFF_QUOTE SPOOFED_QUOTE STYLE_ID VARIANT_ID
```

Then complete a manual browser smoke test:

- [ ] Open `$APP_URL/concepts/quote-desk`.
- [ ] Select vendor-catalog mode, search SanMar for K500, select a variant, and
      produce a staff quote.
- [ ] Confirm normal Quote Desk behavior and no visible/internal cost leakage.
- [ ] Confirm the browser console has no errors and the relevant network calls
      return successful responses.

## 7. Rollback decision and approval gate

Rollback when the delta causes or credibly risks any of the following:

- wrong product availability, removal, or authoritative cost selection;
- unexpected or inconsistent style/variant counts, timestamps, content hash, or
  integrity results;
- missing K500 or variants;
- a runtime catalog search, variant lookup, or server-side quote failure;
- public cost leakage or a spoofed manager header producing manager-only data;
- a material Quote Desk/browser regression tied to the delta.

Do **not** rollback for a harmless cosmetic issue or non-material admin/logging
issue that does not affect catalog truth, cost secrecy, quoting, or operation.
Document it separately.

Rollback is a second production mutation. Obtain separate explicit approval
that names `NEW_DELTA_IMPORT_ID` as the expected current version and
`PRE_DELTA_IMPORT_ID` as the target. `PRE_DELTA_IMPORT_ID` was active before the
delta and became `superseded` when the delta activated. There is no implicit
“previous” target selection.

## 8. Exact rollback command

Use a concise, truthful reason in place of `...`; never put credentials, URLs,
individual costs, or source payloads in the reason.

Set and export the truthful operator identifier named in the rollback approval
without displaying it, then fail closed unless it is nonblank:

```bash
read -r -s -p "Approved rollback operator identifier: " ROLLBACK_REQUESTED_BY
printf '\n'
export ROLLBACK_REQUESTED_BY
test -n "${ROLLBACK_REQUESTED_BY//[[:space:]]/}" || {
  printf '%s\n' 'ROLLBACK_REQUESTED_BY must be a nonblank truthful operator identifier' >&2
  exit 1
}
```

```bash
npm run catalog:rollback -- --vendor sanmar --expected-current-import-id "$NEW_DELTA_IMPORT_ID" --to-import-id "$PRE_DELTA_IMPORT_ID" --requested-by "$ROLLBACK_REQUESTED_BY" --reason "..." --target-url "$VENDOR_CATALOG_DATABASE_URL"
```

Do not alter either ID and do not rerun the command. The CLI compare-and-swap
must fail if the current pointer has drifted.

## 9. Post-rollback verification

- [ ] Confirm sanitized rollback JSON reports `rolledBack: true`,
      `fromImportId = NEW_DELTA_IMPORT_ID`, and
      `toImportId = PRE_DELTA_IMPORT_ID`.
- [ ] Record only the returned rollback `auditId` and `rolledBackAt` timestamp;
      do not copy the audit reason or other sensitive operational context.
- [ ] Run the distinct post-rollback database verification below. Do **not**
      simply rerun Section 5 with states reversed: the restored PRE import and
      superseded NEW delta have different timestamp evidence requirements.

```bash
psql "$VENDOR_CATALOG_DATABASE_URL" -X \
  --set=ON_ERROR_STOP=1 \
  --set=vendor=sanmar \
  --set=pre_delta_import_id="$PRE_DELTA_IMPORT_ID" \
  --set=new_delta_import_id="$NEW_DELTA_IMPORT_ID" <<'SQL'
\pset pager off
BEGIN TRANSACTION READ ONLY;

-- Restored PRE pointer/status, immutable import evidence, activation evidence,
-- stored/actual counts, content hash, and nullable import-level source fields.
SELECT a.import_id AS active_import_id,
       a.activated_at AS pointer_activated_at,
       i.id AS pre_delta_import_id,
       i.status AS pre_delta_status,
       i.imported_at AS pre_delta_imported_at,
       i.activated_at AS pre_delta_import_activated_at,
       i.source_started_at AS pre_delta_source_started_at,
       i.source_completed_at AS pre_delta_source_completed_at,
       i.source_sync_at AS pre_delta_source_sync_at,
       i.style_count AS stored_style_count,
       i.variant_count AS stored_variant_count,
       (SELECT count(*) FROM catalog_styles s
         WHERE s.import_id = i.id) AS actual_style_count,
       (SELECT count(*) FROM catalog_variants v
         WHERE v.import_id = i.id) AS actual_variant_count,
       i.invalid_price_count,
       i.source_errors,
       i.content_hash
  FROM active_catalog_versions a
  JOIN catalog_imports i ON i.id = :'pre_delta_import_id'::uuid
                         AND i.vendor = a.vendor
 WHERE a.vendor = :'vendor';

-- Restored PRE row-level watermark coverage, integrity, and K500 canary.
WITH chosen AS (SELECT :'pre_delta_import_id'::uuid AS import_id)
SELECT
  (SELECT min(source_sync_at) FROM catalog_styles s, chosen c
    WHERE s.import_id = c.import_id) AS oldest_style_source_sync_at,
  (SELECT count(*) FROM catalog_styles s, chosen c
    WHERE s.import_id = c.import_id AND s.source_sync_at IS NULL)
    AS null_style_source_sync_at_count,
  (SELECT min(source_sync_at) FROM catalog_variants v, chosen c
    WHERE v.import_id = c.import_id) AS oldest_variant_source_sync_at,
  (SELECT count(*) FROM catalog_variants v, chosen c
    WHERE v.import_id = c.import_id AND v.source_sync_at IS NULL)
    AS null_variant_source_sync_at_count,
  (SELECT count(*) FROM chosen c
     JOIN catalog_variants v ON v.import_id = c.import_id
     LEFT JOIN catalog_styles s
       ON s.import_id = v.import_id AND s.id = v.style_id
    WHERE s.id IS NULL) AS orphan_variant_count,
  (SELECT count(*) FROM catalog_variants v, chosen c
    WHERE v.import_id = c.import_id
      AND (v.resolved_cost IS NULL OR v.resolved_cost < 0))
    AS invalid_resolved_cost_count,
  (SELECT count(*) FROM catalog_styles s, chosen c
    WHERE s.import_id = c.import_id AND s.vendor = :'vendor'
      AND s.style_code = 'K500') AS k500_style_rows,
  (SELECT count(*) FROM chosen c
     JOIN catalog_styles s ON s.import_id = c.import_id
                          AND s.vendor = :'vendor'
                          AND s.style_code = 'K500'
     JOIN catalog_variants v
       ON v.import_id = s.import_id AND v.style_id = s.id) AS k500_variant_rows;

-- Superseded NEW delta must retain its completion/import/activation evidence.
SELECT id AS new_delta_import_id,
       status AS new_delta_status,
       source_completed_at,
       imported_at,
       activated_at
  FROM catalog_imports
 WHERE vendor = :'vendor'
   AND id = :'new_delta_import_id'::uuid;

SELECT status, count(*) AS job_count
  FROM catalog_ingestion_jobs
 WHERE vendor = :'vendor'
   AND status IN ('queued', 'running', 'validating')
 GROUP BY status
 ORDER BY status;
COMMIT;
SQL
```

Require the pointer to equal `PRE_DELTA_IMPORT_ID`; PRE to be `active`; PRE's
`imported_at`, content hash, stored counts, actual counts, and row-level oldest
watermarks/integrity values to match the values recorded in preflight; and its
stored/actual counts to agree and remain positive. PRE's import and pointer
`activated_at` must satisfy the recorded rollback activation expectation (both
non-null and the restored activation evidence), not be mistaken for immutable
preflight timestamps. Require zero row-level timestamp nulls, orphans, and
invalid costs, plus K500 with variants and no non-terminal job.

Require NEW to be `superseded` while retaining the same non-null
`source_completed_at`, `imported_at`, and `activated_at` evidence recorded after
the delta. Do not require restored PRE `source_completed_at`,
`source_started_at`, or import-level `source_sync_at` unless that field was
non-null in preflight; when it was non-null, require its value to remain
unchanged.
- [ ] Confirm exactly one matching audit row without selecting actor/reason:

```bash
psql "$VENDOR_CATALOG_DATABASE_URL" -X \
  --set=ON_ERROR_STOP=1 \
  --set=vendor=sanmar \
  --set=pre_delta_import_id="$PRE_DELTA_IMPORT_ID" \
  --set=new_delta_import_id="$NEW_DELTA_IMPORT_ID" <<'SQL'
\pset pager off
BEGIN TRANSACTION READ ONLY;
SELECT id AS rollback_audit_id,
       rolled_back_at,
       count(*) OVER () AS matching_audit_rows
  FROM catalog_rollbacks
 WHERE vendor = :'vendor'
   AND from_import_id = :'new_delta_import_id'::uuid
   AND to_import_id = :'pre_delta_import_id'::uuid;
COMMIT;
SQL
```

Require `matching_audit_rows = 1`, then repeat public API, server-side quote,
spoofed-header, Quote Desk, network, and console checks. If rollback or
post-rollback verification fails, stop all catalog mutations and escalate with
sanitized evidence.

## 10. Stop conditions and next sequence

- After one successful, fully verified manual delta, stop and observe. Do not
  schedule or provision anything.
- Perform a second manual production delta later under the same preflight,
  approval, capture, verification, and rollback readiness gates.
- Only after at least two verified manual runs may Railway provisioning or a
  recurring schedule be proposed, and either still requires separate explicit
  approval.
- After this bounded safety work, return to the UI/core MVP scope.
