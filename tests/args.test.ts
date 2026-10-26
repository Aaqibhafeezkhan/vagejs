import { describe, expect, it } from "vitest";
import { textOptions, typedText } from "../src/cli/args.js";

const argv = (...args: string[]) => ["node", "vage", ...args];

describe("text options that look like numbers", () => {
  it("returns exactly what was typed", () => {
    expect(typedText("changedSince", 777123, argv("indexnow", "--changed-since", "0777123", "--yes"))).toBe("0777123");
    expect(typedText("changedSince", 9779582, argv("indexnow", "--changed-since=9779582"))).toBe("9779582");
    expect(typedText("changedSince", 777123, argv("indexnow", "--changedSince", "0777123"))).toBe("0777123");
    expect(typedText("message", 42, argv("deploy:github", "-m", "42"))).toBe("42");
    expect(typedText("slug", 2026, argv("new", "post", "x"))).toBe("2026");
  });

  it("takes the last value, like cac, and ignores everything after --", () => {
    expect(typedText("message", [2, 1], argv("deploy:github", "--message", "2", "-m", "1"))).toBe("1");
    expect(typedText("message", 123, argv("deploy:github", "-m", "123", "--", "-m", "abc"))).toBe("123");
  });

  it("turns repeated values into the last one and leaves numeric options alone", () => {
    const opts: Record<string, unknown> = { changedSince: [1, 2], root: 2026, days: 7, port: 5173 };
    textOptions(opts, argv("indexnow", "--changed-since", "1", "--changed-since", "02", "--root", "2026", "--days", "07"));
    expect(opts).toEqual({ changedSince: "02", root: "2026", days: 7, port: 5173 });
  });
});
