/** Only literal paths qualify; ordinary shared words remain ranking hints. */
function paths(text: string): string[] {
  return [...text.matchAll(/(?:[\w.@-]+(?:[\\/][\w.@*-]+)+|[\w-]+\.[a-zA-Z0-9]{1,12})/g)]
    .map(match => match[0].replaceAll('\\', '/').replace(/^\.\//, ''));
}
export function hasTargetPathMatch(target: string | null | undefined, fields: readonly string[]): boolean {
  const targets = paths(target ?? '');
  return fields.flatMap(paths).some(candidate => targets.some(current => candidate === current
    || candidate.startsWith(current + '/') || current.startsWith(candidate + '/')));
}
