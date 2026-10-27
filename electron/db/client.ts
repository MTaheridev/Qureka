import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '../../generated/prisma/client';
import { databaseFilePath } from './paths';

let client: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!client) {
    const file = databaseFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // libSQL requires a file:// URI, and user-data paths contain spaces on Windows.
    client = new PrismaClient({ adapter: new PrismaLibSql({ url: pathToFileURL(file).href }) });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
