/** Test credentials are kept in memory only, never in captured evidence. */
export function captureSanitizer(sanitizeJson, credentials) {
  const secrets = Object.values(credentials.tokens ?? {}).filter(value => typeof value === 'string' && value.length > 16);
  return value => {
    const text = JSON.stringify(value);
    if (secrets.some(secret => text.includes(JSON.stringify(secret).slice(1, -1)))) throw new Error('secret_output');
    const result = sanitizeJson(JSON.parse(text));
    if (result.redactions.some(redaction => redaction.kind === 'secret_pattern')) throw new Error('secret_output');
    return result.value;
  };
}
