import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempProject } from "./helpers.js";

describe("smoke", () => {
  it("writes one file", () => {
    const dir = makeTempProject({ "hello.txt": "hello" });
    expect(fs.existsSync(path.join(dir, "hello.txt"))).toBe(true);
  });
});
