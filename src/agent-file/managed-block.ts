import { KiokukoError } from '../errors.js';

export const BEGIN_MARKER = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->';
export const END_MARKER = '<!-- END KIOKUKO MANAGED BLOCK -->';

type ManagedBlockState = 'absent' | 'balanced';

export interface ManagedBlockResult {
  content: string;
  action: 'created' | 'updated' | 'unchanged';
  state: ManagedBlockState;
}

function markerPositions(content: string, marker: string): number[] {
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const index = content.indexOf(marker, from);
    if (index < 0) return positions;
    positions.push(index);
    from = index + marker.length;
  }
}

function validateMarkers(content: string): { start: number; end: number } | undefined {
  const starts = markerPositions(content, BEGIN_MARKER);
  const ends = markerPositions(content, END_MARKER);
  if (starts.length === 0 && ends.length === 0) return undefined;
  const start = starts[0];
  const end = ends[0];
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || start >= end) {
    throw new KiokukoError('VALIDATION_ERROR', 'AGENT.md contains malformed Kiokuko managed markers');
  }
  return { start, end: end + END_MARKER.length };
}

function newlineFor(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function normalizeBlock(block: string, newline: string): string {
  return block.replaceAll('\r\n', '\n').replaceAll('\n', newline);
}

export function upsertManagedBlock(existing: string, managedBlock: string): ManagedBlockResult {
  const markers = validateMarkers(existing);
  const newline = newlineFor(existing);
  const normalizedBlock = normalizeBlock(managedBlock, newline);
  if (!markers) {
    if (existing.length === 0) return { content: normalizedBlock, action: 'created', state: 'absent' };
    const separator = existing.endsWith('\n') || existing.endsWith('\r') ? `${newline}${newline}` : `${newline}${newline}${newline}`;
    return { content: `${existing}${separator}${normalizedBlock}`, action: 'created', state: 'absent' };
  }
  const currentBlock = existing.slice(markers.start, markers.end);
  if (currentBlock === normalizedBlock) return { content: existing, action: 'unchanged', state: 'balanced' };
  return {
    content: `${existing.slice(0, markers.start)}${normalizedBlock}${existing.slice(markers.end)}`,
    action: 'updated',
    state: 'balanced',
  };
}

export function assertNotSymlink(filePath: string, isSymbolicLink: boolean): void {
  if (isSymbolicLink) throw new KiokukoError('SECURITY_REJECTION', `Refusing to modify symlink: ${filePath}`);
}
