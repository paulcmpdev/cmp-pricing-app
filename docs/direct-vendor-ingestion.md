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
| SOAP Product Information, Pricing, Inventory, and PromoStandards Product Data v2 WSDLs are reachable on `ws.sanmar.com:8080` | Live verified 2026-08-22 |
| CMP web-service credentials authenticate against product, customer pricing, inventory, and date-modified calls | Live verified 2026-08-22 |
| Updated v24.1 onboarding no longer requires customer static-IP whitelisting; port 8080/firewall access is the current connectivity requirement | Verified from July 2025 guide |
| `getProductDateModified` returns deduplicable changed/new product IDs from a timestamp | Live verified; 334 part records / 15 unique styles in a one-day probe |
| `getProductInfoByStyleColorSize` with style only returns all current parts plus piece/dozen/case pricing | Live verified; K500 returned 370 current variants |
| `getProductInfoByBrand` queues a SanMarPI FTP file instead of returning product rows for CMP's account | Live verified 2026-08-22 |
| EPDD: quote-encapsulated CSV, full product data | Verified (current guide) |
| DIP: `sanmar_dip.txt`, pipe-delimited, hourly inventory + pricing | Verified |
| DIP identity: `inventory_key + size_index = unique_key` | Verified |
| Secure transport is SFTP/SSH at `ftp.sanmar.com:2200`; FTPS/TLS is unsupported | Verified |
| SanMar SFTP offers legacy `ssh-rsa`/`ssh-dss` host keys; modern clients require explicit `ssh-rsa` compatibility plus fingerprint pinning | Live verified 2026-08-22 |
| CMP web-service credentials do not authenticate to SFTP; separate file-delivery credentials are required | Live verified 2026-08-22 |
| Updated FTP guide: SFTP username is the SanMar customer number; password arrives by secure one-time link after agreement/onboarding | Verified from v23.2 guide |
| CMP's 2025 Integration Agreement remained unsigned through the last October reminder; no onboarding-complete/credential email exists | Verified in Gmail 2026-08-22 |
| Nightly `SanMar_EPDD.csv` completes by 6 a.m. Pacific; `sanmar_dip.txt` updates hourly with displayed inventory capped at 1,500 per warehouse | Verified from v23.2 guide |
| Optional `sanmar_dp.csv` contains the full catalog's lowest `my_price`; `sanmar_dpc.csv` contains daily changed-price deltas | Verified from v23.2 guide |

**SOAP refresh strategy:**
- Bootstrap from every active CMP SanMar style ID and the oldest active
  `source_sync_at`; an approved snapshot/local seed is required before live sync.
- Discover changed/new IDs with PromoStandards `getProductDateModified`.
- The current adapter can build a complete shadow/replacement version by fetching
  every bootstrap + changed style with a style-only Product Information call.
  SanMar documents this as the next-best full-catalog option after FTP, but warns
  against thousands of standard-service requests daily. Keep this mode explicit
  and manual/monthly until file access or clone-and-patch deltas are implemented.
- The preferred scheduled path is nightly EPDD plus hourly DIP over SFTP. An
  acceptable SOAP daily path must clone the active immutable version and replace
  only modified/new/explicitly removed styles before whole-version validation.
- Pace requests, reject DTD/entity declarations, parse namespace-aware XML,
  bound response size/time/retries, and fail closed on faults, vendor errors,
  malformed/unpriced rows, conflicting duplicates, or broad count drops.
- SanMar inventory remains unknown in SOAP catalog rows, matching the current
  validated snapshot. Add inventory through SFTP EPDD/DIP or targeted inventory
  requests; never fabricate zero inventory.

**Live full-catalog shadow probe (2026-08-22/23):**
- Ran against isolated Railway database `cmp_catalog_probe`; production was not touched.
- Requested 4,184 bootstrap/modified style IDs over 78 minutes with paced sequential calls.
- Activated 3,949 styles and 157,321 variants; 742 modified/new IDs were discovered and 235 styles were confirmed unavailable through the exact PromoStandards code-130 path.
- Verification: 0 source errors, 0 skipped rows, 0 orphans, 0 invalid costs, 0 populated/fabricated inventory values, and 0 null source timestamps. K500 contained 370 variants; removed style 2700 was absent.
- This probe started before the final namespace/watermark/limit hardening landed. It proves live source coverage and database activation behavior; the final hardening is covered by the complete automated suite and direct adversarial parser probes.

**Delta mode (`--sanmar-mode delta`):**
- Clones the active SanMar import in PostgreSQL using `INSERT...SELECT` — no
  JS materialization of 150k+ rows.
- Discovers changed/new style IDs using PromoStandards `getProductDateModified`
  from the active catalog's oldest `source_sync_at` watermark.
- Fetches ONLY discovered IDs (not all 4k+ bootstrap styles). For a typical
  daily run discovering ~15 styles, this takes seconds instead of 78+ minutes.
- For each discovered style: deletes the cloned style/variants, then inserts
  current data from SOAP. If exact PromoStandards code-130 confirmation says
  "Product Id not found", the style stays deleted. Ambiguous errors reject
  the entire import.
- Unchanged rows preserve their original `source_sync_at` timestamps.
- Final counts are based on the complete cloned replacement (not just changed
  rows). Existing count-drop safeguards still apply.
- Activation is atomic and conditional on the active pointer still matching the
  cloned base import (pointer-drift rejection). Another concurrent activation
  causes the delta to fail closed.
- On failure, the active pointer is untouched and staged data is cleaned.
- Prerequisites: an active SanMar catalog with source timestamps. Delta mode
  will not bootstrap from scratch — use `--sanmar-source soap` (full mode) or
  local EPDD/DIP for initial seeding.
- Usage: `node scripts/sync-vendor-catalog.mjs --vendor sanmar --sanmar-source soap --sanmar-mode delta`
- Scheduling and Railway deployment remain deferred.

**Deferred:**
- Complete/sign the SanMar Integration Agreement, have SanMar finish FTP
  onboarding, and retrieve the separate password from the secure one-time link;
  then implement fingerprint-pinned SFTP as the preferred scheduled transport.
- DIP sale date format and timezone semantics.
- File delivery cadence guarantees.

## Environment Variables

| Variable | Purpose | Used By |
|----------|---------|---------|
| `CMP_SS_ACCOUNT_NUMBER` | S&S Basic auth username | Worker only |
| `CMP_SS_API_KEY` | S&S Basic auth password | Worker only |
| `CMP_SANMAR_SOURCE` | Required: `soap` or `local` | Worker only |
| `CMP_SANMAR_MODE` | Optional: `full` (default) or `delta` | Worker only |
| `CMP_SANMAR_CUSTOMER_NUMBER` | SanMar web-service customer number | Worker only |
| `CMP_SANMAR_USERNAME` | SanMar web-service username | Worker only |
| `CMP_SANMAR_PASSWORD` | SanMar web-service password | Worker only |
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
  and DB flushes; aborts S&S/SanMar SOAP retries and pacing plus SanMar
  EPDD, DIP, and join row loops promptly with a bounded default check interval)
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

SOAP style refreshes process one bounded XML response at a time. The adapter
retains normalized style and variant identity maps for conflict detection and
content hashing; it does not retain raw XML across requests. Responses are
limited to 128 MiB each, requests time out after 120 seconds, and calls are
paced by 250 ms by default.

The local-file fallback holds the EPDD product index
(`Map<UNIQUE_KEY, record>`) in memory for the
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
file-delivery path and states FTPS/TLS is unsupported. Live verification found
only legacy `ssh-rsa`/`ssh-dss` host keys, so production SFTP must explicitly
enable and pin the verified RSA fingerprint rather than disabling host checks.
CMP's web-service credentials do not authenticate to SFTP; recover the separate
file-delivery credentials from SanMar correspondence. SOAP style/delta refreshes
remain a complete Vendo-independent path while SFTP is deferred.

## No-Vendo Target State

When migration is complete:
- `scripts/import-vendo-catalog-postgres.mjs` archived/removed
- `scripts/lib/vendor-catalog-source-queries.mjs` removed
- `VENDO_POSTGRES_URL` env var removed
- `scripts/sync-vendor-catalog.mjs` is the sole catalog refresh path
- Seed script remains for disaster recovery bootstrap
