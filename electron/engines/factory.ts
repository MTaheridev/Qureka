import type { EngineAdapter, StoredConnection } from './types';
import { MysqlAdapter } from './mysql';
import { MssqlAdapter } from './mssql';
import { PostgresAdapter } from './postgres';
import { SqliteAdapter } from './sqlite';

export function createEngineAdapter(connection: StoredConnection): EngineAdapter {
  switch (connection.engine) {
    case 'postgres':
      return new PostgresAdapter(connection);
    case 'mysql':
      return new MysqlAdapter(connection);
    case 'mssql':
      return new MssqlAdapter(connection);
    case 'sqlite':
      return new SqliteAdapter(connection);
    default:
      throw new Error(`Unsupported database engine: ${String(connection.engine)}`);
  }
}
