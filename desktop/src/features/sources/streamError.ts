// errors thrown in the main process arrive as "Error invoking remote method 'youtube:stream': Error: <real message>"
export function describeStreamError(message: string, maxLength = 400): string {
  const cleaned = message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(?:Error|TypeError):\s*/i, "")
    .trim();
  const hint = /not a bot|sign in to confirm/i.test(cleaned) ? " → filtro YouTube › Entrar com Google" : "";
  const body = cleaned.length > maxLength - hint.length ? `${cleaned.slice(0, maxLength - hint.length - 1)}…` : cleaned;
  return body + hint;
}
