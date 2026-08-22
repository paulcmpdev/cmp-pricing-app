import { createRequire } from "node:module";

type StatementSync = {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
};

export type DatabaseSyncLike = {
  exec: (sql: string) => void;
  prepare: (sql: string) => StatementSync;
  close: () => void;
};

const require = createRequire(import.meta.url);

export function openSqliteDatabase(
  path: string,
  { readonly = false }: { readonly?: boolean } = {}
): DatabaseSyncLike {
  const Database = require("better-sqlite3") as new (
    path: string,
    options?: { readonly?: boolean; fileMustExist?: boolean }
  ) => DatabaseSyncLike;

  return new Database(path, {
    readonly,
    fileMustExist: readonly,
  });
}
