import { constants } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveSampleDatabasePath(moduleUrl = import.meta.url) {
  const configDirectory = path.dirname(fileURLToPath(moduleUrl));
  return path.join(path.dirname(configDirectory), 'tests', 'sampledb', 'kiokuko.sqlite3');
}

async function removeDevelopmentDatabaseCopy(dataDirectory) {
  await rm(dataDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function createDevelopmentDatabaseCopy(moduleUrl = import.meta.url) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-dev-mcp-'));
  const databasePath = path.join(dataDirectory, 'kiokuko.sqlite3');
  try {
    await copyFile(resolveSampleDatabasePath(moduleUrl), databasePath, constants.COPYFILE_EXCL);
  } catch (copyError) {
    try {
      await removeDevelopmentDatabaseCopy(dataDirectory);
    } catch (cleanupError) {
      throw new AggregateError(
        [copyError, cleanupError],
        'Copying the development database and cleaning its temporary directory both failed',
      );
    }
    throw copyError;
  }
  return {
    dataDirectory,
    databasePath,
    remove: () => removeDevelopmentDatabaseCopy(dataDirectory),
  };
}

export async function runDevelopmentMcp() {
  const databaseCopy = await createDevelopmentDatabaseCopy();
  const previousDataDirectory = process.env.KIOKUKO_DATA_DIR;
  let operationError;
  try {
    process.env.KIOKUKO_DATA_DIR = databaseCopy.dataDirectory;
    const { runMcpServer } = await import(new URL('../dist/mcp/server.js', import.meta.url));
    await runMcpServer();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (previousDataDirectory === undefined) {
      delete process.env.KIOKUKO_DATA_DIR;
    } else {
      process.env.KIOKUKO_DATA_DIR = previousDataDirectory;
    }
    try {
      await databaseCopy.remove();
    } catch (cleanupError) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, cleanupError],
          'The development MCP failed and its temporary database could not be removed',
        );
      }
      throw cleanupError;
    }
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runDevelopmentMcp();
}
