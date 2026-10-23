import fs from "node:fs";
import path from "node:path";

/** File names that commonly hold credentials. */
const SECRET_FILES: [RegExp, string][] = [
  [/(^|\/)\.env(\.(?!example$|sample$|template$)[^/]+)?$/, "environment file"],
  [/(^|\/)\.(dev\.vars|envrc)$/, "environment file"],
  [/(^|\/)(google|api-keys)\.json$/, "VAGE JS credentials file"],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, "private key or certificate store"],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, "SSH private key"],
  [/(^|\/)(credentials|client_secrets?|service[-_]?account[^/]*)\.json$/i, "credentials file"],
  [/(^|\/)\.(netrc|pgpass)$/, "credentials file"],
];

/** Well-known token formats. Matching is a strong hint, not proof; false positives are possible. */
const SECRET_CONTENT: [RegExp, string][] = [
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/, "private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key ID"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, "GitHub fine-grained token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/, "Google OAuth client secret"],
  [/\b1\/\/0[A-Za-z0-9_-]{20,}/, "Google OAuth refresh token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\bsk_live_[A-Za-z0-9]{16,}\b/, "Stripe live key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, "Anthropic API key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, "OpenAI-style API key"],
  [/_authToken\s*=\s*\S+/, "npm auth token"],
];

/** Text files above this are flagged for manual review instead of being skipped silently. */
const MAX_SCAN_BYTES = 20 * 1024 * 1024;

export interface SecretHit {
  path: string;
  reason: string;
}

/** Scans files about to be committed. Never returns the secret value itself. */
export function findSecrets(root: string, files: string[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const rel of files) {
    const name = SECRET_FILES.find(([re]) => re.test(rel));
    if (name) {
      hits.push({ path: rel, reason: name[1] });
      continue;
    }
    const file = path.join(root, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    if (isBinary(file)) continue;
    if (fs.statSync(file).size > MAX_SCAN_BYTES) {
      hits.push({ path: rel, reason: "text file too large to scan for secrets; review it manually" });
      continue;
    }
    const buf = fs.readFileSync(file);
    const text = buf.toString("utf8");
    const content = SECRET_CONTENT.find(([re]) => re.test(text));
    if (content) hits.push({ path: rel, reason: `looks like a ${content[1]}` });
  }
  return hits;
}

function isBinary(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(8000);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}
