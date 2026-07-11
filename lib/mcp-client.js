// Minimal JSON-RPC client for the Heptabase MCP endpoint.
// Responses may arrive as plain JSON or SSE ("data: {...}") — both are handled.

import { getAccessToken, forceRefreshAccessToken, AuthRequiredError } from "./oauth.js";

const MCP_URL = "https://api.heptabase.com/mcp";
let requestId = 1;

async function request(method, params, { retryOn401 = true } = {}) {
  const token = await getAccessToken();
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream;q=0.1",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, params }),
  });

  if (res.status === 401) {
    if (retryOn401) {
      // Access token rejected before local expiry — refresh and retry once.
      // forceRefreshAccessToken throws AuthRequiredError if refresh is impossible.
      await forceRefreshAccessToken();
      return request(method, params, { retryOn401: false });
    }
    throw new AuthRequiredError();
  }
  if (!res.ok) throw new Error(`MCP request failed: ${res.status} ${await res.text()}`);

  const contentType = res.headers.get("content-type") || "";
  let payload;
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const match = text.match(/^data: (.+)$/m);
    if (!match) throw new Error("Invalid SSE response from MCP server");
    payload = JSON.parse(match[1]);
  } else {
    payload = await res.json();
  }

  if (payload.error) throw new Error(`MCP error: ${payload.error.message}`);
  return payload.result;
}

export async function callTool(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  if (result?.isError) {
    const text = (result.content || []).map((c) => c.text).filter(Boolean).join("\n");
    throw new Error(text || `Tool ${name} failed`);
  }
  return result;
}
