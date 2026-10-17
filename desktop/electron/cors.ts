// the renderer runs with webSecurity off but fetch / media / web audio still look at the response headers, so every response
// gets open cors headers. the originals are dropped first (a second Access-Control-Allow-Origin makes browsers reject the
// response) and the status line is passed back untouched so a 206 stays a 206
export interface HeadersReceivedDetails {
  responseHeaders?: Record<string, string[]>;
  statusLine?: string;
}

const CORS_HEADER_RE = /^access-control-allow-(origin|headers|methods)$/i;

export function withOpenCors(details: HeadersReceivedDetails): { responseHeaders: Record<string, string[]>; statusLine?: string } {
  const responseHeaders: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
    if (!CORS_HEADER_RE.test(name)) responseHeaders[name] = value;
  }
  responseHeaders["access-control-allow-origin"] = ["*"];
  responseHeaders["access-control-allow-headers"] = ["*"];
  responseHeaders["access-control-allow-methods"] = ["GET, HEAD, OPTIONS"];
  return details.statusLine ? { responseHeaders, statusLine: details.statusLine } : { responseHeaders };
}
