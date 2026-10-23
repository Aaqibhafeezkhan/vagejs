/** An expected, user-facing error. The CLI prints its message without a stack trace. */
export class VageError extends Error {
  /** The message without the "at <file>" suffix. */
  readonly detail: string;
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${message}\n  at ${file}` : message);
    this.detail = message;
    this.name = "VageError";
  }
}
