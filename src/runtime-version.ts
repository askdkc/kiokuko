export const MINIMUM_NODE_MAJOR = 24;

export function nodeMajor(version: string): number | undefined {
  const match = /^(\d+)\./u.exec(version);
  if (!match?.[1]) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}

export function supportsNodeVersion(version: string): boolean {
  const major = nodeMajor(version);
  return major !== undefined && major >= MINIMUM_NODE_MAJOR;
}

export function unsupportedNodeMessage(version: string): string {
  return `Kiokuko requires Node.js ${MINIMUM_NODE_MAJOR} or newer; current runtime is Node.js ${version}.`;
}
