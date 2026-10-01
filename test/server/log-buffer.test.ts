import { describe, expect, it } from "vitest";
import { cleanLogLine, LogBuffer } from "../../src/server/log-buffer";

describe("cleanLogLine", () => {
  it("keeps plain lines as they are", () => {
    expect(cleanLogLine("Step 1/4 : FROM node:22")).toBe("Step 1/4 : FROM node:22");
  });

  it("strips ANSI color and OSC sequences", () => {
    expect(cleanLogLine("\x1b[1;32m=> done\x1b[0m \x1b]0;title\x07ok")).toBe("=> done ok");
  });

  it("keeps only the last redraw of carriage-return progress output", () => {
    expect(cleanLogLine("pulling 10%\rpulling 55%\rpulling 100%\r")).toBe("pulling 100%");
  });

  it("returns an empty string when only escapes or redraws remain", () => {
    expect(cleanLogLine("\x1b[2K\r  \r")).toBe("");
  });

  it("caps very long lines", () => {
    const line = cleanLogLine("x".repeat(1500));
    expect(line).toBe(`${"x".repeat(1000)}… (500 more characters)`);
  });
});

describe("LogBuffer", () => {
  it("keeps only the newest lines", () => {
    const buffer = new LogBuffer(2);
    for (const l of ["a", "b", "c"]) buffer.push(l);
    expect(buffer.lines()).toEqual(["b", "c"]);
  });
});
