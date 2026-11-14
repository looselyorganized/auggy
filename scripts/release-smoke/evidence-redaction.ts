/** Publish only bounded text diagnostics; never copy an agent directory or headers. */
export function redactEvidence(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/(Bearer\s+)[^\s"'<>]+/gi, "$1[REDACTED]")
    .replace(/(\/console\/cli-login\/)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .replace(/((?:set-cookie|cookie|authorization):)[^\r\n]+/gi, "$1 [REDACTED]")
    .replace(/(sk-ant-|sk-proj-|am_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(
      /(\/console\/[^\s"']*(?:ticket|login)[^\s"']*[?&](?:token|ticket)=)[^\s"'&]+/gi,
      "$1[REDACTED]",
    );
}
