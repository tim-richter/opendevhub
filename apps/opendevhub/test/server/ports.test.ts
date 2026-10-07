import { describe, expect, it } from "vitest";

import { parseForwardPorts } from "../../src/server/ports";

describe(parseForwardPorts, () => {
  it("accepts numbers and numeric/local host strings, in order", () => {
    expect(
      parseForwardPorts([3000, "5173", "localhost:8080", "127.0.0.1:9229"], {})
    ).toStrictEqual({
      ports: [
        { containerPort: 3000 },
        { containerPort: 5173 },
        { containerPort: 8080 },
        { containerPort: 9229 },
      ],
      skipped: [],
    });
  });

  it("attaches labels from portsAttributes", () => {
    expect(
      parseForwardPorts([3000, 5432], {
        "3000": { label: "web" },
        "5432": { label: 42 },
      }).ports
    ).toStrictEqual([
      { containerPort: 3000, label: "web" },
      { containerPort: 5432 },
    ]);
  });

  it("collapses duplicates, keeping the first", () => {
    expect(
      parseForwardPorts([3000, "localhost:3000", "3000"], {}).ports
    ).toStrictEqual([{ containerPort: 3000 }]);
  });

  it("skips service hosts and invalid entries with reasons", () => {
    const { ports, skipped } = parseForwardPorts(
      ["db:5432", 0, 70_000, 3.5, "abc", null, { port: 1 }],
      {}
    );
    expect(ports).toStrictEqual([]);
    expect(skipped).toStrictEqual([
      { entry: "db:5432", reason: "service hosts are not supported yet" },
      { entry: "0", reason: "not a valid port number (1–65535)" },
      { entry: "70000", reason: "not a valid port number (1–65535)" },
      { entry: "3.5", reason: "not a valid port number (1–65535)" },
      { entry: "abc", reason: "not a valid port entry" },
      { entry: "null", reason: "not a valid port entry" },
      { entry: '{"port":1}', reason: "not a valid port entry" },
    ]);
  });

  it("treats missing or malformed inputs as empty", () => {
    expect(parseForwardPorts(undefined, undefined)).toStrictEqual({
      ports: [],
      skipped: [],
    });
    expect(parseForwardPorts("3000", "x")).toStrictEqual({
      ports: [],
      skipped: [],
    });
  });
});
