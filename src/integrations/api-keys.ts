import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { VageError } from "../core/errors.js";
import { credentialsPath } from "./google-auth.js";

/**
 * The user's own Google Cloud API keys for audits. VAGE JS never ships or
 * shares keys: each user brings theirs (env var, or saved with `vage connect`).
 * Saved keys live next to the Google token, outside any project, mode 0600.
 */
export const API_KEYS = {
  pagespeed: {
    env: "PAGESPEED_API_KEY",
    label: "PageSpeed Insights API",
    howTo: "Google Cloud Console → APIs & Services → enable “PageSpeed Insights API” → Credentials → Create credentials → API key (restrict it to that API).",
  },
  crux: {
    env: "CRUX_API_KEY",
    label: "Chrome UX Report (CrUX) API",
    howTo: "Google Cloud Console → APIs & Services → enable “Chrome UX Report API” → Credentials → Create credentials → API key (one key can serve both APIs).",
  },
} as const;

export type ApiKeyName = keyof typeof API_KEYS;
type Env = Record<string, string | undefined>;

const KEY_FORMAT = /^[A-Za-z0-9_-]{20,200}$/;

export function apiKeysPath(env?: Env): string {
  return path.join(path.dirname(credentialsPath(env)), "api-keys.json");
}

function readAll(env?: Env): Partial<Record<ApiKeyName, string>> {
  const file = apiKeysPath(env);
  if (!fs.existsSync(file)) return {};
  const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new VageError(`Saved API keys are unreadable. Remove the file and save them again.`, file);
  return parsed.data;
}

/** Environment variable first, then the key saved with `vage connect`. */
export function resolveApiKey(name: ApiKeyName, env: Env = process.env): string | undefined {
  return env[API_KEYS[name].env]?.trim() || readAll(env)[name];
}

export function saveApiKey(name: ApiKeyName, value: string, env?: Env): string {
  const key = value.trim();
  if (!KEY_FORMAT.test(key)) throw new VageError(`That doesn't look like a Google API key (letters, digits, "-" or "_", no spaces).`);
  const file = apiKeysPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ ...readAll(env), [name]: key }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function removeApiKey(name: ApiKeyName, env?: Env): boolean {
  const all = readAll(env);
  if (!all[name]) return false;
  delete all[name];
  const file = apiKeysPath(env);
  if (Object.keys(all).length) fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  else fs.rmSync(file, { force: true });
  return true;
}

export function missingKeyMessage(name: ApiKeyName): string {
  const k = API_KEYS[name];
  return `${k.label} needs your own API key. Set ${k.env}, or save one with "vage connect ${name}". Get a key: ${k.howTo}`;
}
