# CMP Vendor Catalog Runbook

## Overview

CMP maintains its own vendor catalog database (S&S Activewear + SanMar) with
versioned imports, validation gates, and atomic activation. PostgreSQL is the
primary runtime backend; SQLite is used as a local fallback and as a validated
seed source for initial bootstrap.

**Requires Node.js 20** (`better-sqlite3` native addon must match Node version;
run `npm rebuild` after switching Node versions).

## Environment Variables

| Variable | Purpose |
|---|---|
| `VENDOR_CATALOG_DATABASE_URL` | PostgreSQL connection string (**use pooled/transaction URL** for Vercel production, e.g. Supabase pgbouncer port 6543) |
| `VENDOR_CATALOG_DB_PATH` | Path to SQLite fallback (e.g. `data/vendor-catalog.sqlite`) |
| `VENDO_POSTGRES_URL` | Source Vendo PostgreSQL for live imports (read-only) |
| `VENDOR_CATALOG_BATCH_SIZE` | Batch size for imports (default: 500, max: 1000) |
| `VENDOR_CATALOG_TEST_DATABASE_URL` | PostgreSQL URL for integration tests (optional, test-only) |
| `CMP_SS_ACCOUNT_NUMBER` | S&S Basic auth account number (worker/CLI only, never in web runtime) |
| `CMP_SS_API_KEY` | S&S Basic auth API key (worker/CLI only, never in web runtime) |
| `CMP_SANMAR_SOURCE` | Required source selector: `soap`, `local`, or `sdln` |
| `CMP_SANMAR_CUSTOMER_NUMBER` | SanMar web-service customer number (worker only) |
| `CMP_SANMAR_USERNAME` | SanMar web-service username (worker only) |
| `CMP_SANMAR_PASSWORD` | SanMar web-service password (worker only) |
| `CMP_SANMAR_EPDD_PATH` | Path to local SanMar EPDD CSV file (worker/CLI only) |
| `CMP_SANMAR_DIP_PATH` | Path to local SanMar DIP pipe-delimited file (worker/CLI only) |
| `CMP_SANMAR_SDLN_PATH` | Path to local uncompressed `SanMar_SDL_N.csv` file (worker/CLI only) |
| `CMP_SANMAR_EXPECTED_SOURCE_SHA256` | Required for `sdln`: expected SHA-256 of the uncompressed SDL_N CSV bytes |
| `CMP_ALLOW_LOCAL_MANAGER_MODE` | Set to `true` in non-production to enable manager cost visibility via `x-cmp-role: manager` header |

## Pool Configuration

The runtime PG pool is configured with `max: 2` connections. Use a **pooled
connection URL** (e.g. Supabase pgbouncer port 6543) in production to avoid
exhausting direct connections across Vercel serverless instances.

## Import Scripts

### Seed from validated SQLite snapshot (bootstrap)

This is the **only allowed bootstrap path**. The seed script validates the
SQLite file against a reviewed manifest (SHA-256 hash, per-vendor style/variant
counts, integrity_check, zero orphans/null/negative costs, known reference
styles).

When `--vendor all` (default), both vendor imports are built and validated
first, then activated in a **single transaction** — no mixed generation if one
vendor fails.

```bash
npm run catalog:seed-sqlite -- \
  --sqlite data/vendor-catalog.sqlite \
  --target-url "$VENDOR_CATALOG_DATABASE_URL"
```

Options: `--vendor ss|sanmar|all` (default: all), `--batch-size N` (default: 500).

The S&S data in the reviewed snapshot has `source_status: failed` in Vendo
metadata but passes all CMP integrity checks. It is marked as an
`approved_recovery_snapshot` in the manifest — the original `source_status` is
preserved in import metadata for audit trail.

### Direct vendor sync (new, replaces Vendo long-term)

Standalone CLI/worker that ingests directly from vendor APIs/files into CMP
PostgreSQL. **Requires an existing active CMP version** (use seed first).

```bash
# S&S (requires credentials in env)
CMP_SS_ACCOUNT_NUMBER=xxx CMP_SS_API_KEY=yyy \
  npm run catalog:sync -- --vendor ss --target-url "$VENDOR_CATALOG_DATABASE_URL"

# SanMar SOAP manual/shadow full refresh (explicit source; requires an active
# seeded SanMar catalog). Do not schedule daily: this makes one paced request
# per active/discovered style. Prefer SFTP or clone-and-patch for daily updates.
CMP_SANMAR_SOURCE=soap \
CMP_SANMAR_CUSTOMER_NUMBER=xxx \
CMP_SANMAR_USERNAME=xxx \
CMP_SANMAR_PASSWORD=yyy \
  npm run catalog:sync -- --vendor sanmar --sanmar-source soap \
  --target-url "$VENDOR_CATALOG_DATABASE_URL"

# SanMar local files (explicit fallback/source)
CMP_SANMAR_SOURCE=local npm run catalog:sync -- --vendor sanmar \
  --sanmar-source local \
  --epdd-path data/epdd.csv --dip-path data/sanmar_dip.txt \
  --target-url "$VENDOR_CATALOG_DATABASE_URL"

# SanMar SDL_N no-inventory file (explicit source; no DIP required).
# The expected hash is required and is for uncompressed SanMar_SDL_N.csv bytes.
# Operators check any approved ZIP hash separately before extracting.
export CMP_SANMAR_SDLN_PATH=data/SanMar_SDL_N.csv
export CMP_SANMAR_EXPECTED_SOURCE_SHA256=<uncompressed-csv-sha256>
CMP_SANMAR_SOURCE=sdln npm run catalog:sync -- --vendor sanmar \
  --sanmar-source sdln \
  --sdln-path "$CMP_SANMAR_SDLN_PATH" \
  --expected-source-sha256 "$CMP_SANMAR_EXPECTED_SOURCE_SHA256" \
  --target-url "$VENDOR_CATALOG_DATABASE_URL"
```

See `docs/direct-vendor-ingestion.md` for architecture, migration stages, and
unresolved items (SanMar secure file delivery).

### First production SanMar delta and rollback

Both commands below mutate the production catalog and are forbidden without
explicit approval for that specific mutation. Follow the approval-gated
checklists in [`docs/sanmar-delta-production-run.md`](docs/sanmar-delta-production-run.md);
do not execute these commands from this summary alone.

```bash
# One approved manual SanMar SOAP delta
CMP_SANMAR_SOURCE=soap npm run catalog:sync -- --vendor sanmar --sanmar-source soap --sanmar-mode delta --target-url "$VENDOR_CATALOG_DATABASE_URL"

# Separately approved explicit rollback; first set the truthful approved operator
# identifier as ROLLBACK_REQUESTED_BY per the detailed runbook, without printing it
npm run catalog:rollback -- --vendor sanmar --expected-current-import-id "$NEW_DELTA_IMPORT_ID" --to-import-id "$PRE_DELTA_IMPORT_ID" --requested-by "$ROLLBACK_REQUESTED_BY" --reason "..." --target-url "$VENDOR_CATALOG_DATABASE_URL"
```

Do not provision or enable a recurring schedule until at least two manual
production delta runs have each been verified, and scheduling has received a
separate explicit approval.

### Import from Vendo PostgreSQL (legacy, retained for rollback)

**Legacy rollback tooling** — retained during migration to direct vendor
ingestion. Stream from Vendo source PostgreSQL into CMP target. **Requires an
existing active CMP version** (use seed first). Explicit per-vendor only — no
`--vendor all`.

```bash
npm run catalog:import-vendo -- \
  --vendor ss \
  --source-url "$VENDO_POSTGRES_URL" \
  --target-url "$VENDOR_CATALOG_DATABASE_URL"
```

### Import from Vendo SQLite (legacy)

```bash
npm run catalog:import-sqlite
```

## Safety Gates

### Live Vendo imports enforce:

1. **Active CMP version required**: Refuses import if no existing active CMP
   version exists for the vendor. The seed script is the only allowed bootstrap.
2. **Source status gate**: Refuses import if Vendo source `status !== 'completed'`
3. **Large drop rejection**: Refuses activation if style or variant count drops
   >20% from the active version
4. **Validation checks**: Verifies row counts match, no orphaned variants, no
   negative costs, and known reference styles exist (3001 for S&S, K500 for SanMar)
5. **Activation row check**: Confirms exactly 1 row was activated
6. **Rejected cleanup**: On failure, staged style/variant rows are deleted via
   CASCADE; sanitized import metadata is retained with rejection reason
7. **Numeric parsing**: Skips variant rows with non-finite or negative resolved_cost
8. **Parameter limits**: Rejects batches exceeding PostgreSQL's 65,535 parameter limit
9. **Source/target separation**: Refuses import if source and target database URLs
   resolve to the same host:port/database

### SQLite seed additionally enforces:

1. **Manifest hash**: SQLite file SHA-256 must match the reviewed manifest
2. **Manifest counts**: Per-vendor style/variant counts must match exactly
3. **SQLite integrity_check**: Must pass `PRAGMA integrity_check`
4. **Zero orphans/null/negative costs**: Validated per-vendor before import
5. **Known reference styles**: 3001 (S&S), K500 (SanMar) must be present
6. **Atomic multi-vendor activation**: `--vendor all` activates both in one txn

## Versioning Model

- Each import creates an immutable `catalog_imports` row with status lifecycle:
  `building -> validating -> active` (or `rejected`/`superseded`)
- `active_catalog_versions` table holds one active pointer per vendor
- Activation is atomic via `pg_advisory_xact_lock` + transaction
- Active views (`active_catalog_styles`, `active_catalog_variants`) join through
  the pointer AND `catalog_imports.status = 'active'` for runtime queries
- Runtime availability requires **both** `ss` and `sanmar` active

## Cost Security

- Public API endpoints (`/api/vendor-catalog/search`, `.../variants`) never
  return cost/price columns
- Cost resolution is server-side only via `resolveCatalogVariantCost()`
- Manager-role quote responses include `vendorCatalog` provenance **only** when
  `NODE_ENV !== 'production'` AND `CMP_ALLOW_LOCAL_MANAGER_MODE=true`
- In production, `x-cmp-role: manager` header is ignored — all responses are
  staff-safe (no cost data exposed)

## Testing

```bash
# Unit + deterministic mock tests (Node 24)
npm test

# PG integration tests (requires local PostgreSQL)
VENDOR_CATALOG_TEST_DATABASE_URL="postgresql://localhost:5432/cmp_test" npm test

# Type check
npx tsc --noEmit

# Lint
npm run lint

# Full build
npm run build
```

PG integration tests are gated on `VENDOR_CATALOG_TEST_DATABASE_URL`. When the
variable is not set, they are skipped. When set, they exercise: schema creation,
active views with status filter, both-vendor availability, activation rollback,
rejected import cleanup with CASCADE, and cost/public projection isolation.

## Watson Real-Import Verification Checks

After seeding from SQLite or importing from Vendo, verify:

1. `SELECT vendor, style_count, variant_count, status FROM catalog_imports ORDER BY imported_at DESC LIMIT 4;`
   - S&S should have 6,381 styles / 221,824 variants with status `active`
   - SanMar should have 3,950 styles / 151,486 variants with status `active`
2. `SELECT * FROM active_catalog_versions;` should show one row per vendor
3. `SELECT count(*) FROM active_catalog_styles;` should match sum of style_counts
4. `SELECT count(*) FROM active_catalog_variants;` should match sum of variant_counts
5. Test search: `SELECT * FROM active_catalog_styles WHERE style_code = '3001';`
6. Test variant: `SELECT id, style_code, color, size, resolved_cost FROM active_catalog_variants WHERE style_code = '3001' AND vendor = 'ss' LIMIT 5;`

## Known Future Risks

- **Old import cleanup**: Superseded/rejected import metadata rows accumulate.
  A scheduled cleanup job should periodically delete old non-active imports
  (styles/variants are already cleaned on rejection; superseded imports retain
  data until cleanup).
- **Auth for manager mode**: The `x-cmp-role` header is unauthenticated. Real
  auth (JWT/session) should replace the header-based manager mode. Until then,
  production always returns staff-safe responses.
- **SanMar SFTP onboarding/legacy host key**: SanMar file delivery is
  `ftp.sanmar.com:2200` and currently offers legacy `ssh-rsa`/`ssh-dss` host
  keys. Web-service credentials do not authenticate to SFTP. CMP's 2025
  integration agreement remained unsigned in the Gmail trail, so no secure FTP
  password link was issued. Complete onboarding, then pin the verified RSA
  fingerprint before enabling EPDD/DIP transport.
- **SanMar SOAP volume**: A complete replacement version makes one paced style
  request per active/discovered style. Prefer SFTP Bulk/Delta once file access
  is recovered; keep SOAP explicit and monitor duration/vendor errors.
- **S&S API pagination**: Full `/styles/` response behavior at scale (single
  response vs paged) needs verification with real credentials.
- **Stale job lease cleanup**: New ingestion attempts reclaim expired
  queued/running/validating jobs for the same vendor under advisory lock, reject
  their non-active import, and delete staged rows before acquiring a fresh job.
