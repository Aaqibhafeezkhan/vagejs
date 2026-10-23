import { VageError } from "../core/errors.js";

export interface HttpOptions {
  fetch?: typeof fetch;
  /** Waits between retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Fetch with retries for rate limits and transient errors (exponential
 * backoff: 1 s, 2 s, ...). Every value in `secrets` is scrubbed from error text.
 */
export async function requestWithRetry(service: string, url: string, init: RequestInit, secrets: (string | undefined)[], opts: HttpOptions = {}): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 3;

  for (let i = 1; ; i++) {
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
      if (res.ok || !RETRY_STATUS.has(res.status) || i === attempts) return res;
    } catch (err) {
      if (i === attempts) throw new VageError(redact(`${service} request failed after ${attempts} attempts: ${(err as Error).message}`, secrets));
    }
    await sleep(1000 * 2 ** (i - 1));
  }
}

/** Builds an actionable error from a non-OK Google API response. */
export async function apiError(service: string, res: Response, secrets: (string | undefined)[], hints: Partial<Record<number, string>> = {}): Promise<VageError> {
  let detail = "";
  try {
    // Google APIs use { error: { message } }; the OAuth endpoints use { error, error_description }.
    const body = (await res.json()) as { error?: { message?: string } | string; error_description?: string };
    detail = body.error_description ?? (typeof body.error === "string" ? body.error : (body.error?.message ?? ""));
  } catch {
    // Non-JSON error body; the status is enough.
  }
  const hint = hints[res.status] ?? (res.status === 429 ? "Rate limited: wait and retry." : "");
  return new VageError(redact(`${service} returned HTTP ${res.status}${detail ? `: ${detail.replace(/\.+$/, "")}` : ""}.${hint ? ` ${hint}` : ""}`, secrets));
}

export function redact(text: string, secrets: (string | undefined)[]): string {
  return secrets.filter((s): s is string => Boolean(s && s.length >= 4)).reduce((t, s) => t.split(s).join("[redacted]"), text);
}
