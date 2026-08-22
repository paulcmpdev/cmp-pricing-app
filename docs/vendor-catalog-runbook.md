# Vendor Catalog Import And Runbook

The quote calculator reads a calculator-owned SQLite snapshot configured with
`VENDOR_CATALOG_DB_PATH`. The app never queries Vendo PostgreSQL during quote
math.

## Build A Local Snapshot

From this repo:

```bash
node scripts/import-vendo-catalog.mjs --output data/vendor-catalog.sqlite
```

The importer streams newline-delimited `row_to_json` output from `psql` and
inserts rows into SQLite in bounded batches. It builds a temporary snapshot,
checkpoints it, then atomically replaces the active file so a failed or running
import does not remove the last usable catalog. It first tries host `psql`, then
falls back to `podman exec`, then `docker exec`. The container name comes from
`VENDO_DB_CONTAINER` or `--db-container`.

Verified local Podman command:

```bash
VENDO_DB_CONTAINER=vendo-db-inspect \
  node scripts/import-vendo-catalog.mjs --output data/vendor-catalog.sqlite
```

To use an explicit host connection:

```bash
VENDO_POSTGRES_URL='postgres://USER:PASSWORD@HOST:5432/DB' \
  node scripts/import-vendo-catalog.mjs --output data/vendor-catalog.sqlite --no-container
```

Then run the app with:

```bash
VENDOR_CATALOG_DB_PATH=data/vendor-catalog.sqlite npm run dev
```

The command prints imported style/variant counts and invalid price-row counts.
S&S `resolved_cost` uses `customerPrice`, then `salePrice`, then `piecePrice`.
SanMar `resolved_cost` uses `piecePrice`.

## Git Boundary

`data/*.sqlite`, `data/*.sqlite-*`, and `*.db` are ignored. Do not commit a
full vendor snapshot. Tests use a small deterministic SQLite fixture builder in
`tests/fixtures/vendor-catalog/build-test-db.ts`.
