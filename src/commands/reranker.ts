import type { Command } from 'commander';
import type { PathEnvironment } from '../config/paths.js';
import { KiokukoError } from '../errors.js';
import { LOCAL_RERANKER_PRESET } from '../reranker/preset.js';
import { rerankerStatus, setupReranker } from '../reranker/setup.js';
import type { ModelDownloader } from '../embedding/model-download.js';
import { successEnvelope } from '../serialization/envelope.js';

export interface RerankerCommandDependencies extends PathEnvironment {
  readonly downloader?: ModelDownloader;
  readonly output?: (json: boolean | undefined, operation: string, data: unknown, message: string) => void;
}

function writeOutput(json: boolean | undefined, operation: string, data: unknown, message: string, output: RerankerCommandDependencies['output']): void {
  if (output !== undefined) {
    output(json, operation, data, message);
    return;
  }
  if (json) process.stdout.write(`${JSON.stringify(successEnvelope(operation, data))}\n`);
  else process.stdout.write(`${message}\n`);
}

export function registerRerankerCommands(cli: Command, dependencies: RerankerCommandDependencies = {}): Command {
  const reranker = cli.command('reranker').description('Manage the local sequence-classification reranker');
  reranker.command('status').description('Verify the pinned local reranker installation').option('--json').action(async (options: { json?: boolean }) => {
    const status = await rerankerStatus(dependencies);
    writeOutput(options.json, 'reranker.status', status,
      status.state === 'ready' ? `Reranker ready at ${status.directory}` : `Reranker ${status.state}: ${status.directory}`,
      dependencies.output);
    if (status.state === 'invalid') process.exitCode = 8;
  });
  reranker.command('setup').description('Download and verify the pinned local reranker').option('--json').action(async (options: { json?: boolean }) => {
    try {
      const status = await setupReranker({
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
        ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
        ...(dependencies.downloader === undefined ? {} : { downloader: dependencies.downloader }),
        onProgress: (progress) => {
          if (!options.json) process.stderr.write(`\rDownloading ${progress.file}: ${progress.completedBytes}/${progress.totalBytes} bytes`);
        },
      });
      if (!options.json) process.stderr.write('\n');
      writeOutput(options.json, 'reranker.setup', {
        ...status,
        sourceModel: LOCAL_RERANKER_PRESET.sourceModel,
        artifactRepository: LOCAL_RERANKER_PRESET.artifactRepository,
        dtype: LOCAL_RERANKER_PRESET.dtype,
        mode: process.env.KIOKUKO_RERANKER_MODE ?? 'off',
      }, `Reranker ${status.installation} and verified at ${status.directory}`, dependencies.output);
    } catch (error) {
      if (error instanceof KiokukoError) throw error;
      throw new KiokukoError('SERVICE_UNAVAILABLE', 'Reranker setup failed. Confirm @huggingface/hub is installed and inspect the underlying npm or network error.');
    }
  });
  return reranker;
}
