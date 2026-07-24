/**
 * Shared test helpers (not collected by vitest — no .test suffix).
 */

/**
 * Decode the JSON-RPC message from a streamable-HTTP response body.
 *
 * The v2 SDK's legacy stateless serving answers POSTs as SSE
 * (`text/event-stream`) rather than v1's single JSON body
 * (`enableJsonResponse: true`), so tests accept both encodings — exactly
 * like a real streamable-HTTP client does.
 */
export async function mcpJson(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const messages = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()) as unknown);
    // Stateless per-request serving carries exactly one response message.
    return messages[messages.length - 1];
  }
  return res.json();
}
