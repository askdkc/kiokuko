import { getRuntimeDescriptorPath } from '../config/paths.js';
import { KiokukoError } from '../errors.js';
import { isPidAlive, type PidLiveness } from '../server/instance-lock.js';
import { readRuntimeDescriptor } from '../server/runtime-descriptor.js';

export interface DiscoveredServer {
  readonly protocolVersion: '1';
  readonly instanceId: string;
  readonly pid: number;
  readonly baseUrl: string;
  readonly databaseFingerprint: string;
  readonly startedAt: string;
}

export interface DiscoverServerOptions {
  readonly descriptorPath?: string;
  readonly isPidAlive?: PidLiveness;
}

function unavailable(): KiokukoError {
  return new KiokukoError('SERVICE_UNAVAILABLE', 'Kiokuko server is unavailable');
}

export async function discoverServer(options: DiscoverServerOptions = {}): Promise<DiscoveredServer> {
  let descriptorPath: string;
  try {
    descriptorPath = options.descriptorPath ?? getRuntimeDescriptorPath();
  } catch {
    throw unavailable();
  }
  let descriptor;
  try {
    descriptor = await readRuntimeDescriptor(descriptorPath);
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw unavailable();
  }
  if (!descriptor) throw unavailable();

  let live: boolean;
  try {
    live = await (options.isPidAlive ?? isPidAlive)(descriptor.pid);
  } catch {
    throw unavailable();
  }
  if (!live) throw unavailable();

  return Object.freeze({
    protocolVersion: descriptor.protocolVersion,
    instanceId: descriptor.instanceId,
    pid: descriptor.pid,
    baseUrl: descriptor.baseUrl,
    databaseFingerprint: descriptor.databaseFingerprint,
    startedAt: descriptor.startedAt,
  });
}
