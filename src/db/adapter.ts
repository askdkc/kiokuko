import { backup as sqliteBackup, DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqliteValue = null | number | bigint | string | NodeJS.ArrayBufferView;
export type SqliteRow = Record<string, unknown>;

export interface SqliteStatement {
  run(...parameters: SqliteValue[]): void;
  get<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T | undefined;
  all<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T[];
}

export interface SqliteDatabase {
  readonly filePath: string;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  backup(destination: string): Promise<number>;
  close(): void;
}

class StatementAdapter implements SqliteStatement {
  constructor(private readonly statement: StatementSync) {}

  run(...parameters: SqliteValue[]): void {
    this.statement.run(...parameters);
  }

  get<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T | undefined {
    return this.statement.get(...parameters) as T | undefined;
  }

  all<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T[] {
    return this.statement.all(...parameters) as T[];
  }
}

export class NodeSqliteAdapter implements SqliteDatabase {
  constructor(
    readonly filePath: string,
    private readonly database: DatabaseSync,
  ) {}

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new StatementAdapter(this.database.prepare(sql));
  }

  backup(destination: string): Promise<number> {
    return sqliteBackup(this.database, destination);
  }

  close(): void {
    this.database.close();
  }
}
