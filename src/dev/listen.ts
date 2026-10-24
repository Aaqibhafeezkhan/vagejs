import type { AddressInfo } from "node:net";
import { VageError } from "../core/errors.js";

export interface ServeOptions {
  port?: number;
  host?: string | boolean;
}

/** Runs a Vite listen() call and turns a port conflict into an actionable message. */
export async function listenOrExplain<T>(listen: () => Promise<T>, port: number | undefined): Promise<T> {
  try {
    return await listen();
  } catch (err) {
    if (/already in use|EADDRINUSE/i.test((err as Error).message)) {
      throw new VageError(
        `Port ${port} is already in use. Stop the process using it, or choose another port with --port <number>.`,
      );
    }
    throw err;
  }
}

/**
 * The address the server is really listening on, when it's a loopback address, e.g.
 * http://[::1]:5173/ or http://127.0.0.1:5173/. Browsers keep cookies per host name, so
 * this address doesn't carry the cookies other projects left on "localhost" (the usual
 * cause of HTTP 431). Undefined when the server listens on every interface (--host).
 */
export function directUrl(address: AddressInfo | string | null | undefined): string | undefined {
  if (!address || typeof address === "string") return undefined;
  if (address.address === "::1") return `http://[::1]:${address.port}/`;
  if (address.address.startsWith("127.")) return `http://${address.address}:${address.port}/`;
  return undefined;
}

/** Prints where the server runs: the localhost URL, the direct address, and network URLs. */
export function printUrls(label: string, local: string | undefined, direct: string | undefined, network: string[] = []): void {
  console.log(`${label} running at ${local ?? direct}`);
  if (direct && direct !== local) console.log(`  same server: ${direct} (use this if the browser shows HTTP 431)`);
  for (const url of network) console.log(`  network: ${url}`);
}
