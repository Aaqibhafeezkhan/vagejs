/** An expected, user-facing error. The CLI prints its message without a stack trace. */
export class VageError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${message}\n  at ${file}` : message);
    this.name = "VageError";
  }
}
