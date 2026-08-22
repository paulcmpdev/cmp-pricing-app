# Direct Vendor Ingestion Architecture

## Goal

Replace Vendo-mediated vendor data pipeline with CMP-owned direct ingestion
from S&S Activewear and SanMar. CMP runtime continues to use its own versioned
PostgreSQL catalog with the same staging/activation/security model.

## Migration Stages

1. **Foundation (this PR)**: Contracts, adapters, parsers, orchestrator, job
   tracking. No production deployment. Existing Vendo importer retained as
   clearly-labeled legacy rollback tooling.
2. **Credentialed Probe**: Run S&S adapter against real API with test
   credentials. Validate field mappings, rate limits, pagination edge cases.
   Implement SanMar SFTP/SSH file delivery (see Deferred below).
3. **Shadow Mode**: Run direct ingestion alongside Vendo import. Compare
   counts, costs, content hashes. No activation of direct-sourced versions.
4. **Cutover**: Activate direct-sourced versions. Retire Vendo import scripts
   (archive, do not delete until confidence period).
5. **Cleanup**: Remove Vendo source queries, environment variables, and
   legacy scripts.

## Architecture

```
                      +-----------------+
                      |  Vendor APIs /  |
                      |  Vendor Files   |
                      +--------+--------+
                               |
            +------------------+------------------+
            |                                     |
   +--------v---------+              +-----------v-----------+
   | S&S HTTP Adapter |              | SanMar File Parser    |
   | (scripts/lib/    |              | (scripts/lib/         |
   |  vendor-sources/ |              |  vendor-sources/      |
   |  ss.mjs)         |              |  sanmar.mjs)          |
   +--------+---------+              +-----------+-----------+
            |                                     |
            |   Normalized VendorStyle/Variant     |
            +------------------+------------------+
                               |
                    +----------v-----------+
                    |  sync-vendor-catalog  |
                    |  orchestrator         |
                    |  (scripts/)           |
                    +----------+-----------+
                               |
                    PG staging / validation / activation
                    (reuses existing postgres-import-helpers)
                               |
                    +----------v-----------+
                    |  catalog_imports      |
                    |  catalog_styles       |
                    |  catalog_variants     |
                    |  active_catalog_*     |
                    +----------------------+
```

### Worker Boundary

The orchestrator runs as a standalone CLI/worker process only. No Next.js API
route, no Vercel request execution. Credentials are available only in the
worker environment, never in the web runtime.

### Security Model

- Vendor API credentials injected via env vars, never stored in code or logs
- Error messages are redacted: no request/response bodies, no auth headers
- HTTP helper rejects off-host redirects (SSRF prevention)
- Cost columns remain server-only in the runtime catalog
- Job error summaries are truncated and sanitized before DB storage

## Vendor Source Details

### S&S Activewear

| Fact | Status |
|------|--------|
| Origin: `https://api.ssactivewear.com/v2` | Verified (official docs) |
| Auth: Basic (account number + API key) | Verified |
| `GET /styles/` returns all styles | Verified |
| `GET /products/?styleid=comma-list` (max 50 IDs) | Verified |
| Rate limit: 60 req/min, `X-Rate-Limit-Remaining` header | Verified |
| Products include: styleID, sku, qty, warehouses, customerPrice/salePrice/piecePrice | Verified |
| `customerPrice` = "Your price" (account-specific negotiated cost) | Verified |

Mapping choices:
- Style `styleName` remains the user-facing `styleCode`. Style `partNumber`,
  when present, is retained only as optional `sourcePartNumber` in the
  normalized source contract.
- Product `sku` is the canonical `sourceVariantId`.
- Product `sizeOrder` plus `piecePrice`, `dozenPrice`, `casePrice`,
  `salePrice`, and `customerPrice` are mapped into the normalized variant.
- Product `warehouses`, when present, must be an array of objects with
  `warehouseAbbr` and nonnegative finite `qty`. Warehouse detail is validation
  input only and is not persisted in the canonical catalog schema.
- Canonical `inventoryQty` uses documented aggregate `qty` when it is finite
  and nonnegative. If aggregate `qty` is absent, it sums validated warehouse
  quantities. If aggregate `qty` and warehouse sums disagree, aggregate `qty`
  is retained intentionally.
- S&S completeness is fail-closed by default. Every validated raw product is
  counted for its requested style; products without a usable positive price
  increment `skippedCount` and are not emitted as variants. After all batches,
  any requested style with fewer usable variants than validated raw products
  marks the manifest incomplete with redacted per-style counts. A style omitted
  from a batch product response receives an isolated product request. Only an
  isolated HTTP 404 confirms that the listed style is unavailable; it is then
  excluded from staging and reported separately in the manifest. An isolated
  empty 200 response remains incomplete. More than 100 zero-product candidates
  are not rechecked and remain incomplete, limiting extra API load during broad
  source failures.

**Observed live on 2026-08-22:**
- `/styles/` returned one array containing 5,664 styles for CMP's account.
- Twelve listed styles were omitted from batched product results and returned
  HTTP 404 when re-requested individually.

**Unknowns:**
- Whether `/styles/` will introduce pagination at a larger future response size
- Response size for future full catalogs (potential for timeouts?)
- Whether `X-Rate-Limit-Remaining` is present on all responses or only 429s
- Schema drift: field additions vs removals across API versions

### SanMar

| Fact | Status |
|------|--------|
| EPDD: quote-encapsulated CSV, full product data | Verified (current guide) |
| DIP: `sanmar_dip.txt`, pipe-delimited, hourly inventory + pricing | Verified |
| DIP identity: `inventory_key + size_index = unique_key` | Verified |
| EPDD canonical fields: `UNIQUE_KEY`, `PRODUCT_TITLE`, `PRODUCT_DESCRIPTION`, `STYLE#`, `CATEGORY_NAME`, `COLOR_NAME`, `SIZE`, `PIECE_PRICE`, `CASE_PRICE`, `INVENTORY_KEY`, `SIZE_INDEX`, `MILL`, `PRODUCT_STATUS`, `PRODUCT_IMAGE` | Verified |
| DIP official fields: `Inventory_Key`, `Size_Index`, `Catalog_No`, `Catalog_Color`, `Size`, `Whse_No`, `Quantity`, `Piece_Price`, `Dozens_Price`, `Case_Price`, `Case_Size`, `Each_sale_Price`, `Sale_start_datetime`, `Sale_end_datetime`, `Unique_key`, `Discontinued_code` | Verified |
| Secure transport is SFTP/SSH at `ftp.sanmar.com:2200`; FTPS/TLS is unsupported | Verified |

**Deferred:**
- **Secure file delivery implementation**: Phase 1 parses local pre-delivered
  files only. SFTP/SSH transport for `ftp.sanmar.com:2200` remains to be built;
  FTPS/TLS should not be attempted.
- DIP sale date format and timezone semantics
- File delivery cadence guarantees

## Environment Variables

| Variable | Purpose | Used By |
|----------|---------|---------|
| `CMP_SS_ACCOUNT_NUMBER` | S&S Basic auth username | Worker only |
| `CMP_SS_API_KEY` | S&S Basic auth password | Worker only |
| `CMP_SANMAR_EPDD_PATH` | Path to local EPDD CSV file | Worker only |
| `CMP_SANMAR_DIP_PATH` | Path to local DIP text file | Worker only |
| `VENDOR_CATALOG_DATABASE_URL` | CMP PostgreSQL target | Worker + runtime |
| `VENDOR_CATALOG_TEST_DATABASE_URL` | PG for integration tests | Test only |

## Job Tracking (catalog_ingestion_jobs)

New table tracks direct ingestion job lifecycle with:
- Lease ownership with per-vendor advisory lock (prevents concurrent jobs)
- Heartbeat and lease expiry (detects stale workers; expired leases are
  reclaimed by the next acquirer under advisory lock)
- Checkpoint JSON for progress/audit tracking. **Not resumable** — a new job
  starts from scratch. Checkpoints record progress milestones (styles/variants
  staged, phase transitions) for observability and debugging only.
- Cancel-request flag (cooperative cancellation checked between source batches
  and DB flushes; aborts S&S fetch retries and SanMar EPDD, DIP, and join row
  loops promptly with a bounded default check interval)
- All job mutations (heartbeat, checkpoint, status) are guarded by job ID +
  lease_owner + non-terminal status + unexpired lease. Mandatory transitions
  fail closed if the owned row is not updated; best-effort checkpoints remain
  observability-only.
- Activation re-checks and locks the owned, non-terminal, unexpired job inside
  the same transaction before replacing the active catalog pointer.
- Redacted error summary (no secrets in DB)
- FK to catalog_imports (links job to versioned import)

Status lifecycle: `queued -> running -> validating -> completed | rejected | canceled`

DB-enforced constraint: at most one non-terminal job per vendor.

## SanMar Memory Behavior

The EPDD product index (`Map<UNIQUE_KEY, record>`) is held in memory for the
DIP join phase and capped at 250,000 unique keys. DIP is read line-by-line, but
the aggregate map (`Map<Unique_key, inventory/pricing record>`) is also held
for the join and capped at 250,000 unique keys. Each DIP record stores a capped
warehouse list of at most 32 warehouses for that key. Join output is streamed
via callbacks without materializing a final variants array.

Default malformed-row, key-mismatch, and skipped-source-row tolerance is zero
for activation: parsers count malformed rows, EPDD keys missing DIP and DIP keys
missing EPDD are counted as source errors, any joined row that cannot produce a
valid variant is counted as a source error, the SanMar manifest is marked
incomplete when any are present, and the orchestrator refuses activation for
incomplete manifests. EPDD price fallback for missing DIP inventory is
diagnostic-only when explicitly injected by tests/tools and is not a CLI
production default.

## SanMar Secure Delivery (Deferred)

SanMar documentation identifies SFTP/SSH at `ftp.sanmar.com:2200` as the secure
delivery path and states FTPS/TLS is unsupported. The current adapter parses
local pre-delivered files only. Transport is deferred, not impossible; implement
SFTP/SSH before production direct SanMar refreshes.

## No-Vendo Target State

When migration is complete:
- `scripts/import-vendo-catalog-postgres.mjs` archived/removed
- `scripts/lib/vendor-catalog-source-queries.mjs` removed
- `VENDO_POSTGRES_URL` env var removed
- `scripts/sync-vendor-catalog.mjs` is the sole catalog refresh path
- Seed script remains for disaster recovery bootstrap
