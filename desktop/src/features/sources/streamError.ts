// errors thrown in the main process arrive as "Error invoking remote method 'youtube:stream': Error: <real message>"
export function describeStreamError(message: string, maxLength = 180): string {
  const cleaned = message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(?:Error|TypeError):\s*/i, "")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}
