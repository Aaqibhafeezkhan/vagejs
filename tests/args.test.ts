import { describe, expect, it } from "vitest";
import { typedText } from "../src/cli/args.js";

describe("text options that look like numbers", () => {
  it("returns exactly what was typed", () => {
    expect(typedText("changedSince", 777123, ["node", "vage", "indexnow", "--changed-since", "0777123", "--yes"])).toBe("0777123");
    expect(typedText("changedSince", 9779582, ["node", "vage", "indexnow", "--changed-since=9779582"])).toBe("9779582");
    expect(typedText("message", 42, ["node", "vage", "deploy:github", "-m", "42"])).toBe("42");
    expect(typedText("slug", 2026, ["node", "vage", "new", "post", "x"])).toBe("2026");
  });
});
