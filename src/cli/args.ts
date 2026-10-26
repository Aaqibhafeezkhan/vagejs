/**
 * cac turns number-like values into numbers: a commit like 9779582 would arrive as a
 * number, and 0777123 as 777123. Options that hold text get the exact text the person
 * typed back from the command line.
 */
export const TEXT_OPTIONS: Record<string, string[]> = {
  root: ["--root"], vageSpec: ["--vage-spec"], title: ["--title"], description: ["--description"], under: ["--under"], date: ["--date"], author: ["--author"], slug: ["--slug"],
  remote: ["--remote"], branch: ["--branch"], message: ["-m", "--message"], m: ["-m", "--message"], target: ["--target"], project: ["--project"],
  url: ["--url"], strategy: ["--strategy"], property: ["--property"], propertyId: ["--property-id"], changedSince: ["--changed-since"], urls: ["--urls"],
};

/** "--changed-since" -> "--changedSince": cac accepts both spellings. */
const camel = (flag: string) => flag.replace(/(?<=[a-z])-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * The last value given for this option, as typed (cac also keeps the last one). Only
 * arguments before "--" count: the rest aren't options.
 */
export function typedText(name: string, value: unknown, argv: string[]): string {
  const flags = new Set((TEXT_OPTIONS[name] ?? []).flatMap((f) => [f, camel(f)]));
  const end = argv.indexOf("--");
  for (let i = (end === -1 ? argv.length : end) - 1; i >= 0; i--) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    if (eq > 0 && flags.has(arg.slice(0, eq))) return arg.slice(eq + 1);
    if (flags.has(arg) && i + 1 < (end === -1 ? argv.length : end)) return argv[i + 1]!;
  }
  return String(Array.isArray(value) ? value.at(-1) : value);
}

/** Puts back the exact text of text options that cac made into numbers, or lists (when given twice). */
export function textOptions(opts: Record<string, unknown>, argv: string[]): void {
  for (const name of Object.keys(TEXT_OPTIONS)) {
    const value = opts[name];
    if (typeof value === "number" || Array.isArray(value)) opts[name] = typedText(name, value, argv);
  }
}
