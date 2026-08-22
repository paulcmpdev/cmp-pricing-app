import { unlinkSync } from "node:fs";
import { openSqliteDatabase } from "@/lib/server/vendor-catalog/sqlite";
import { VENDOR_CATALOG_SCHEMA_SQL } from "@/lib/server/vendor-catalog/schema";

export function buildVendorCatalogTestDb(dbPath: string) {
  try {
    unlinkSync(dbPath);
  } catch {
    // The fixture path usually does not exist yet.
  }

  const db = openSqliteDatabase(dbPath);
  db.exec(VENDOR_CATALOG_SCHEMA_SQL);

  const now = "2026-01-15T12:00:00.000Z";
  db.exec(`
    INSERT INTO catalog_sources VALUES
      ('ss', '2025-09-09T00:00:00.000Z', '${now}', 'completed', 0, 4, 3),
      ('sanmar', '2026-06-29T00:00:00.000Z', '${now}', 'completed', 9, 2, 1);

    INSERT INTO catalog_styles VALUES
      ('ss:3001', 'ss', '3001', '3001', 'BELLA+CANVAS', 'Jersey Tee', 'T-Shirts', 'Soft tee', 'https://example.test/3001.jpg', 2, '2025-09-09T00:00:00.000Z'),
      ('ss:3001C', 'ss', '3001C', '3001C', 'BELLA+CANVAS', 'Youth Jersey Tee', 'T-Shirts', 'Soft youth tee', NULL, 1, '2025-09-09T00:00:00.000Z'),
      ('ss:B3001', 'ss', 'B3001', 'B3001', 'Brand B', 'Substring Tee', 'T-Shirts', NULL, NULL, 1, '2025-09-09T00:00:00.000Z'),
      ('sanmar:K500', 'sanmar', 'K500', 'K500', 'Port Authority', 'Silk Touch Polo', 'Polos', 'Classic polo', 'https://example.test/k500.jpg', 2, '2026-06-29T00:00:00.000Z');

    INSERT INTO catalog_variants VALUES
      ('ss:3001-BLK-M', 'ss:3001', 'ss', '3001-BLK-M', '3001', 'Black', 'M', 30, 42, 'https://example.test/3001-black.jpg', 0, 5.00, 4.80, 4.50, 4.75, 4.25, 4.25, 'customerPrice', '2025-09-09T00:00:00.000Z'),
      ('ss:3001-BLK-L', 'ss:3001', 'ss', '3001-BLK-L', '3001', 'Black', 'L', 40, 0, 'https://example.test/3001-black.jpg', 0, 5.20, NULL, NULL, NULL, NULL, 5.20, 'piecePrice', '2025-09-09T00:00:00.000Z'),
      ('ss:3001C-BLU-S', 'ss:3001C', 'ss', '3001C-BLU-S', '3001C', 'Blue', 'S', 10, 10, NULL, 0, 4.10, NULL, NULL, NULL, 3.90, 3.90, 'customerPrice', '2025-09-09T00:00:00.000Z'),
      ('ss:B3001-GRY-M', 'ss:B3001', 'ss', 'B3001-GRY-M', 'B3001', 'Grey', 'M', 30, 8, NULL, 0, 6.10, NULL, NULL, NULL, 5.95, 5.95, 'customerPrice', '2025-09-09T00:00:00.000Z'),
      ('sanmar:K500-RED-M', 'sanmar:K500', 'sanmar', 'K500-RED-M', 'K500', 'Red', 'M', 20, NULL, 'https://example.test/k500-red.jpg', 0, 9.75, 9.50, 9.25, NULL, NULL, 9.75, 'piecePrice', '2026-06-29T00:00:00.000Z'),
      ('sanmar:K500-RED-L', 'sanmar:K500', 'sanmar', 'K500-RED-L', 'K500', 'Red', 'L', 30, NULL, 'https://example.test/k500-red.jpg', 0, 9.75, 9.50, 9.25, NULL, NULL, 9.75, 'piecePrice', '2026-06-29T00:00:00.000Z');
  `);
  db.close();
}
