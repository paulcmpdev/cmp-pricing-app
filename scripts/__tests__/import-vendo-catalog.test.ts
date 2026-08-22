import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = join(process.cwd(), "scripts/import-vendo-catalog.mjs");
const source = readFileSync(scriptPath, "utf8");

function sqlBlock(name: string): string {
  const match = source.match(
    new RegExp(String.raw`const ${name} = [a-zA-Z]+\(??\`([\s\S]*?)\`\)?;`)
  );
  if (!match) throw new Error(`Unable to find ${name}`);
  return match[1];
}

describe("Vendo catalog importer contract", () => {
  it("uses a Node 20-compatible SQLite adapter instead of node:sqlite", () => {
    expect(source).not.toContain("node:sqlite");
    expect(source).toContain("better-sqlite3");
  });

  it("streams newline-delimited row JSON instead of aggregating full catalogs", () => {
    expect(source).not.toMatch(/json_agg\s*\(/i);
    expect(source).toMatch(/row_to_json\s*\(/i);
    expect(source).toMatch(/readline|createInterface|for await/i);
    expect(source).toMatch(/BATCH_SIZE|batchSize/i);
  });

  it("uses latest successful completed sync for source_sync_at while preserving latest attempt status", () => {
    expect(sqlBlock("source")).toMatch(/latest_attempt/i);
    expect(sqlBlock("source")).toMatch(/latest_success/i);
    for (const name of ["ssStyles", "ssVariants", "sanmarStyles", "sanmarVariants"]) {
      const sql = sqlBlock(name);
      expect(sql).toMatch(/status\s*=\s*'completed'/i);
      expect(sql).toMatch(/completed_at\s+DESC/i);
    }
  });

  it("uses the customer-facing S&S styleName as style_code", () => {
    for (const name of ["ssStyles", "ssVariants"]) {
      const sql = sqlBlock(name);
      expect(sql).toMatch(/COALESCE\(s\."styleName"[^\n]*\)\s+style_code/i);
      expect(sql).not.toMatch(/s\."partNumber"[^\n]*style_code/i);
    }
  });

  it("does not join SanMar styles to products by style during style aggregation", () => {
    const sql = sqlBlock("sanmarStyles");
    expect(sql).not.toMatch(/JOIN\s+sanmar_products\s+\w+\s+ON\s+\w+\."style"\s*=\s*\w+\."style"/i);
    expect(sql).toMatch(/COUNT\s*\(\s*s\."uniqueKey"\s*\)::int\s+active_variant_count/i);
  });

  it("builds a temporary snapshot and atomically replaces the active file", () => {
    expect(source).toMatch(/renameSync\(importPath, output\)/);
    expect(source).toMatch(/const importPath/);
    expect(source).not.toMatch(/if \(existsSync\(output\)\) rmSync\(output\)/);
  });

  it("streams JSON rows through psql without COPY text escaping", () => {
    expect(source).toMatch(/SELECT row_to_json\(t\)::text FROM/);
    expect(source).not.toMatch(/COPY \(SELECT row_to_json/);
  });

  it("removes trailing semicolons before nesting source SQL", () => {
    expect(source).toMatch(/query\.trim\(\)\.replace\(\/;\$\//);
  });

  it("skips unavailable command fallbacks instead of crashing on spawn ENOENT", () => {
    expect(source).toMatch(/isCommandAvailable/);
    expect(source).toMatch(/attempts\.filter\([\s\S]*isCommandAvailable/);
  });

  it("supports host psql, podman exec, and docker exec with configurable container names", () => {
    expect(source).toMatch(/VENDO_DB_CONTAINER/);
    expect(source).toMatch(/podman/);
    expect(source).toMatch(/docker/);
    expect(source).not.toMatch(/"vendo-db"/);
  });
});
