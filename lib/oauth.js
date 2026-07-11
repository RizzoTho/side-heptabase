// OAuth 2.0 PKCE + Dynamic Client Registration (RFC 7591) against Heptabase.
// Runs in the background service worker only; tokens never leave chrome.storage.local.

const WELL_KNOWN = "https://api.heptabase.com/.well-known/oauth-authorization-server";
const SCOPE = "openid profile email space:read space:write offline_access";
const CLIENT_NAME = "Side Heptabase"; // shown on the Heptabase consent page
const CLIENT_KEY = "hepta_client";
const TOKENS_KEY = "hepta_tokens";
const EXPIRY_MARGIN_MS = 60_000;

export class AuthRequiredError extends Error {
  constructor(message = "Not connected to Heptabase") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

let endpointsCache = null;

async function discoverEndpoints() {
  if (endpointsCache) return endpointsCache;
  const res = await fetch(WELL_KNOWN, { redirect: "follow" });
  if (!res.ok) throw new Error(`OAuth metadata fetch failed: ${res.status}`);
  const meta = await res.json();
  endpointsCache = {
    authorization: meta.authorization_endpoint,
    token: meta.token_endpoint,
    registration: meta.registration_endpoint,
  };
  return endpointsCache;
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

// client_id is bound to the redirect URI it was registered with; if the
// extension ID (and thus the redirect URI) changes, re-register.
async function ensureClientId(endpoints, redirectUri) {
  const { [CLIENT_KEY]: saved } = await chrome.storage.local.get(CLIENT_KEY);
  if (saved?.clientId && saved.redirectUri === redirectUri && saved.clientName === CLIENT_NAME) {
    return saved.clientId;
  }

  const res = await fetch(endpoints.registration, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`Client registration failed: ${res.status} ${await res.text()}`);
  const { client_id: clientId } = await res.json();
  await chrome.storage.local.set({ [CLIENT_KEY]: { clientId, redirectUri, clientName: CLIENT_NAME } });
  return clientId;
}

async function storeTokenResponse(tok) {
  await chrome.storage.local.set({
    [TOKENS_KEY]: {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
    },
  });
}

async function fetchTokens(endpoints, params) {
  const res = await fetch(endpoints.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Authorization runs in a regular tab instead of chrome.identity.launchWebAuthFlow:
// the auth-flow popup is a special context whose cookie handling breaks the
// Heptabase OAuth interaction page (session cookie lost -> 500 -> "page could
// not be loaded"), and a normal tab reuses the user's existing Heptabase login.
// The redirect URI never resolves (chromiumapp.org); we capture the code from
// the tab's URL as the navigation commits, then close the tab.
function launchAuthTab(url, redirectUri) {
  return new Promise((resolve, reject) => {
    let tabId = null;
    // MV3 service workers idle out in ~30s; the user may take minutes to log
    // in. Any extension API call resets the idle timer, so ping while waiting.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
    const timeout = setTimeout(() => {
      cleanup();
      if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
      reject(new Error("Authorization timed out (5 min)"));
    }, 300_000);

    function cleanup() {
      clearInterval(keepAlive);
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }
    function onUpdated(id, info) {
      if (id !== tabId) return;
      const navUrl = info.url ?? info.pendingUrl;
      if (navUrl?.startsWith(redirectUri)) {
        cleanup();
        chrome.tabs.remove(id).catch(() => {});
        resolve(navUrl);
      }
    }
    function onRemoved(id) {
      if (id !== tabId) return;
      cleanup();
      reject(new Error("Authorization window was closed"));
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.create({ url, active: true }).then(
      (tab) => { tabId = tab.id; },
      (e) => { cleanup(); reject(e); },
    );
  });
}

/** Interactive authorization: opens the Heptabase consent page in a new tab. */
export async function authorize() {
  const endpoints = await discoverEndpoints();
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const clientId = await ensureClientId(endpoints, redirectUri);
  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(8)));

  const url = new URL(endpoints.authorization);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  const callback = await launchAuthTab(url.toString(), redirectUri);
  const cbUrl = new URL(callback);
  if (cbUrl.searchParams.get("error")) {
    throw new Error(`Authorization denied: ${cbUrl.searchParams.get("error")}`);
  }
  if (cbUrl.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
  const code = cbUrl.searchParams.get("code");
  if (!code) throw new Error("No authorization code in callback");

  const tok = await fetchTokens(endpoints, {
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  await storeTokenResponse(tok);
}

async function refreshAccessToken(refreshToken) {
  const endpoints = await discoverEndpoints();
  const { [CLIENT_KEY]: saved } = await chrome.storage.local.get(CLIENT_KEY);
  if (!saved?.clientId) throw new AuthRequiredError();
  const tok = await fetchTokens(endpoints, {
    client_id: saved.clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  await storeTokenResponse(tok);
  return tok.access_token;
}

/** Returns a valid access token, refreshing if needed. Throws AuthRequiredError when reconnect is needed. */
export async function getAccessToken() {
  const { [TOKENS_KEY]: tokens } = await chrome.storage.local.get(TOKENS_KEY);
  if (!tokens?.accessToken) throw new AuthRequiredError();
  if (Date.now() < tokens.expiresAt - EXPIRY_MARGIN_MS) return tokens.accessToken;
  if (!tokens.refreshToken) {
    await clearTokens();
    throw new AuthRequiredError("Session expired");
  }
  try {
    return await refreshAccessToken(tokens.refreshToken);
  } catch (e) {
    await clearTokens();
    throw new AuthRequiredError(`Session expired (${e.message})`);
  }
}

/** Force a refresh regardless of local expiry (e.g. after a 401). */
export async function forceRefreshAccessToken() {
  const { [TOKENS_KEY]: tokens } = await chrome.storage.local.get(TOKENS_KEY);
  if (!tokens?.refreshToken) {
    await clearTokens();
    throw new AuthRequiredError();
  }
  try {
    return await refreshAccessToken(tokens.refreshToken);
  } catch (e) {
    await clearTokens();
    throw new AuthRequiredError(`Session expired (${e.message})`);
  }
}

export async function clearTokens() {
  await chrome.storage.local.remove(TOKENS_KEY);
}

export async function isConnected() {
  const { [TOKENS_KEY]: tokens } = await chrome.storage.local.get(TOKENS_KEY);
  return Boolean(tokens?.accessToken);
}
