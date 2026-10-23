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
