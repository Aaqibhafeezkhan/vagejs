/**
 * cac turns number-like values into numbers: a commit like 9779582 would arrive as a
 * number, and 0777123 as 777123. Options that hold text get the exact text the person
 * typed back from the command line.
 */
export const TEXT_OPTIONS: Record<string, string[]> = {
  vageSpec: ["--vage-spec"], title: ["--title"], description: ["--description"], under: ["--under"], date: ["--date"], author: ["--author"], slug: ["--slug"],
  remote: ["--remote"], branch: ["--branch"], message: ["-m", "--message"], m: ["-m", "--message"], target: ["--target"], project: ["--project"],
  url: ["--url"], strategy: ["--strategy"], property: ["--property"], propertyId: ["--property-id"], changedSince: ["--changed-since"], urls: ["--urls"],
};

export function typedText(name: string, value: number, argv: string[]): string {
  for (const flag of TEXT_OPTIONS[name] ?? []) {
    for (let i = argv.length - 1; i >= 0; i--) {
      if (argv[i] === flag && argv[i + 1] !== undefined) return argv[i + 1]!;
      if (argv[i]!.startsWith(`${flag}=`)) return argv[i]!.slice(flag.length + 1);
    }
  }
  return String(value);
}
