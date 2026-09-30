import { describe, expect, it } from "vitest";
import { parseCli } from "../../src/server/cli";

describe("parseCli", () => {
  it("parses repeated roots, port and --no-open", () => {
    expect(parseCli(["--root", "~/code", "-r", "/work", "--port", "9000", "--no-open"])).toEqual({
      roots: ["~/code", "/work"],
      port: 9000,
      open: false,
      help: false,
    });
  });
  it("defaults", () => {
    expect(parseCli([])).toEqual({ roots: [], port: undefined, open: true, help: false });
  });
  it.each([["--port", "abc"], ["--port", "70000"], ["--bogus"]])("rejects %s", (...argv) => {
    expect(() => parseCli(argv)).toThrow();
  });
});
