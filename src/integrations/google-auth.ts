import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { VageError } from "../core/errors.js";
import { apiError, requestWithRetry, type HttpOptions } from "./http.js";

// OAuth 2.0 for desktop apps (loopback redirect + PKCE):
// https://developers.google.com/identity/protocols/oauth2/native-app
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/** Read-only scopes: least privilege for reports. */
export const SCOPES = {
  gsc: "https://www.googleapis.com/auth/webmasters.readonly",
  ga4: "https://www.googleapis.com/auth/analytics.readonly",
} as const;

const storedSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string().optional(),
  refreshToken: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
});
export type StoredCredentials = z.infer<typeof storedSchema>;

/** Outside any project: $VAGE_CONFIG_DIR, else the OS user config dir. Never in the repository. */
export function credentialsPath(env: Record<string, string | undefined> = process.env): string {
  const base =
    env.VAGE_CONFIG_DIR ??
    (process.platform === "win32"
      ? path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "vagejs")
      : path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "vagejs"));
  return path.join(base, "google.json");
}

export function loadCredentials(env?: Record<string, string | undefined>): StoredCredentials | undefined {
  const file = credentialsPath(env);
  if (!fs.existsSync(file)) return undefined;
  const parsed = storedSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new VageError(`Stored Google credentials are unreadable. Run "vage disconnect google", then connect again.`, file);
  return parsed.data;
}

function saveCredentials(creds: StoredCredentials, env?: Record<string, string | undefined>) {
  const file = credentialsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export interface ConnectOptions {
  scopes: string[];
  clientId: string;
  clientSecret?: string;
  /** Opens (or prints) the Google consent page URL. */
  open: (url: string) => void;
  env?: Record<string, string | undefined>;
  http?: HttpOptions;
  timeoutMs?: number;
}

/**
 * Runs the browser consent flow and stores a refresh token. Previously granted
 * scopes are requested again so connecting GA4 keeps Search Console access.
 */
export async function connectGoogle(options: ConnectOptions): Promise<StoredCredentials> {
  const existing = loadCredentials(options.env);
  const scopes = [...new Set([...(existing?.clientId === options.clientId ? existing.scopes : []), ...options.scopes])].sort();
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const url = new URL(AUTH_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      state,
    }).toString();
    const code = waitForCode(server, state, options.timeoutMs ?? 5 * 60_000);
    options.open(url.href);
    const authCode = await code;

    const secrets = [options.clientSecret, authCode, verifier];
    const body = new URLSearchParams({ code: authCode, client_id: options.clientId, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier });
    if (options.clientSecret) body.set("client_secret", options.clientSecret);
    const res = await requestWithRetry("Google OAuth", TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, secrets, options.http);
    if (!res.ok) throw await apiError("Google OAuth token exchange", res, secrets);
    const token = z.object({ refresh_token: z.string().optional(), scope: z.string().default("") }).parse(await res.json());
    if (!token.refresh_token) throw new VageError("Google did not return a refresh token, so the connection could not be saved. Try connecting again.");
    const granted = token.scope.split(" ");
    const missing = scopes.filter((s) => !granted.includes(s));
    if (missing.length) throw new VageError(`Access was not granted for: ${missing.join(", ")}. Connect again and allow all requested permissions.`);

    const creds = { clientId: options.clientId, clientSecret: options.clientSecret, refreshToken: token.refresh_token, scopes, createdAt: new Date().toISOString() };
    saveCredentials(creds, options.env);
    return creds;
  } finally {
    server.close();
  }
}

function waitForCode(server: http.Server, state: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new VageError("Timed out waiting for Google authorization. Run the command again.")), timeoutMs);
    server.on("request", (req, res) => {
      const params = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      const finish = (status: number, text: string) => {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        res.end(text);
      };
      if (!params.has("code") && !params.has("error")) return finish(404, "Not found");
      if (params.get("state") !== state) return finish(400, "State mismatch; ignoring this request.");
      clearTimeout(timer);
      if (params.get("error")) {
        finish(200, "Authorization was not granted. You can close this tab.");
        return reject(new VageError(`Google authorization was not granted (${params.get("error")}).`));
      }
      finish(200, "VAGE JS is connected. You can close this tab.");
      resolve(params.get("code")!);
    });
  });
}

/** Exchanges the stored refresh token for a short-lived access token. */
export async function getAccessToken(scope: string, service: "gsc" | "ga4", options: { env?: Record<string, string | undefined>; http?: HttpOptions } = {}): Promise<string> {
  const creds = loadCredentials(options.env);
  if (!creds) throw new VageError(`Not connected to Google. Run "vage connect ${service}".`);
  if (!creds.scopes.includes(scope)) throw new VageError(`The Google connection does not include ${service} access. Run "vage connect ${service}".`);
  const secrets = [creds.refreshToken, creds.clientSecret];
  const body = new URLSearchParams({ client_id: creds.clientId, refresh_token: creds.refreshToken, grant_type: "refresh_token" });
  if (creds.clientSecret) body.set("client_secret", creds.clientSecret);
  const res = await requestWithRetry("Google OAuth", TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, secrets, options.http);
  if (res.status === 400 || res.status === 401) {
    throw new VageError(`The Google connection has expired or was revoked. Run "vage connect ${service}" again.`);
  }
  if (!res.ok) throw await apiError("Google OAuth token refresh", res, secrets);
  return z.object({ access_token: z.string() }).parse(await res.json()).access_token;
}

/** Revokes the refresh token at Google and deletes the local file (even if revocation fails). */
export async function disconnectGoogle(options: { env?: Record<string, string | undefined>; http?: HttpOptions } = {}): Promise<{ hadConnection: boolean; revoked: boolean }> {
  const creds = loadCredentials(options.env);
  if (!creds) return { hadConnection: false, revoked: false };
  let revoked = false;
  try {
    const res = await requestWithRetry(
      "Google OAuth",
      REVOKE_ENDPOINT,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: creds.refreshToken }) },
      [creds.refreshToken],
      options.http,
    );
    revoked = res.ok;
  } catch {
    // Network failure: still remove the local token; the caller reports that revocation did not happen.
  }
  fs.rmSync(credentialsPath(options.env), { force: true });
  return { hadConnection: true, revoked };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}
