import { describe, expect, it } from "vitest";

import type { FormField } from "../../src/shared/types";
import {
  buildAnswer,
  fieldLabel,
  formSupported,
  initialValues,
  inputType,
  isVisible,
  optionsOf,
  safeUrl,
} from "../../src/web/forms";

const f = (
  key: string,
  type: string,
  over: Partial<FormField> = {}
): FormField => ({ key, type, ...over });

describe("form fields", () => {
  it("knows which field types it can render", () => {
    expect(
      formSupported([
        f("a", "string"),
        f("b", "number"),
        f("c", "integer"),
        f("d", "boolean"),
        f("e", "multiselect"),
        f("g", "external"),
      ])
    ).toBeTruthy();
    expect(formSupported([f("a", "string"), f("b", "file")])).toBeFalsy();
  });

  it("labels with the title, falling back to the key", () => {
    expect(fieldLabel(f("db", "string", { title: "Database" }))).toBe(
      "Database"
    );
    expect(fieldLabel(f("db", "string", { title: "  " }))).toBe("db");
  });

  it("accepts string and object options", () => {
    expect(
      optionsOf(
        f("x", "string", {
          options: ["a", { value: "b", label: "Bee" }, { value: "c" }],
        })
      )
    ).toStrictEqual([
      { value: "a", label: "a" },
      { value: "b", label: "Bee" },
      { value: "c", label: "c" },
    ]);
  });

  it("starts from defaults", () => {
    expect(
      initialValues([
        f("s", "string", { default: "x" }),
        f("n", "number", { default: 3 }),
        f("b", "boolean", { default: true }),
        f("m", "multiselect", { default: ["a"] }),
        f("e", "external"),
        f("t", "string"),
      ])
    ).toStrictEqual({ s: "x", n: "3", b: true, m: ["a"], t: "" });
  });
});

describe(isVisible, () => {
  const dependent = f("detail", "string", {
    when: [{ key: "kind", op: "eq", value: "other" }],
  });

  it("honours hidden and when eq/neq", () => {
    expect(isVisible(f("x", "string", { hidden: true }), {})).toBeFalsy();
    expect(isVisible(dependent, { kind: "other" })).toBeTruthy();
    expect(isVisible(dependent, { kind: "a" })).toBeFalsy();
    expect(
      isVisible(
        f("y", "string", { when: [{ key: "kind", op: "neq", value: "a" }] }),
        { kind: "b" }
      )
    ).toBeTruthy();
  });

  it("treats an untouched field as not equal, and compares typed numbers and booleans by value", () => {
    expect(isVisible(dependent, {})).toBeFalsy();
    expect(
      isVisible(
        f("y", "string", { when: [{ key: "kind", op: "neq", value: "a" }] }),
        {}
      )
    ).toBeTruthy();
    expect(
      isVisible(
        f("z", "string", { when: [{ key: "n", op: "eq", value: 3 }] }),
        { n: "3" }
      )
    ).toBeTruthy();
    expect(
      isVisible(
        f("z", "string", { when: [{ key: "ok", op: "eq", value: true }] }),
        { ok: true }
      )
    ).toBeTruthy();
    expect(
      isVisible(
        f("z", "string", { when: [{ key: "tags", op: "eq", value: "x" }] }),
        { tags: ["x", "y"] }
      )
    ).toBeTruthy();
  });
});

describe(buildAnswer, () => {
  it("converts values to opencode's answer types", () => {
    const fields = [
      f("s", "string"),
      f("n", "number"),
      f("i", "integer"),
      f("b", "boolean"),
      f("m", "multiselect", { custom: true }),
      f("e", "external", { url: "https://x" }),
    ];
    expect(
      buildAnswer(
        fields,
        { s: "hi", n: "2.5", i: "4", b: false, m: ["a"] },
        { m: " c, d ,," }
      )
    ).toStrictEqual({
      ok: true,
      answer: { s: "hi", n: 2.5, i: 4, b: false, m: ["a", "c", "d"] },
    });
  });

  it("omits empty optional fields and fields hidden by when, and sends hidden defaults", () => {
    const fields = [
      f("opt", "string"),
      f("kind", "string"),
      f("detail", "string", {
        required: true,
        when: [{ key: "kind", op: "eq", value: "other" }],
      }),
      f("secret", "string", { hidden: true, default: "token" }),
    ];
    expect(
      buildAnswer(fields, { opt: "  ", kind: "a", detail: "" })
    ).toStrictEqual({
      ok: true,
      answer: { kind: "a", secret: "token" },
    });
  });

  it("reports per-field errors", () => {
    const fields = [
      f("s", "string", { required: true }),
      f("i", "integer"),
      f("n", "number", { minimum: 1, maximum: 5 }),
      f("m", "multiselect", { maxItems: 1 }),
      f("p", "string", { pattern: "[a-z]+" }),
      f("l", "string", { minLength: 3 }),
    ];
    const result = buildAnswer(fields, {
      s: "",
      i: "1.5",
      n: "9",
      m: ["a", "b"],
      p: "abc1",
      l: "ab",
    });
    expect(result).toStrictEqual({
      ok: false,
      errors: {
        s: "Required",
        i: "Enter a whole number",
        n: "At most 5",
        m: "Pick at most 1",
        p: "Doesn't match the expected format",
        l: "At least 3 characters",
      },
    });
  });

  it("ignores a pattern that is not a valid regular expression", () => {
    expect(
      buildAnswer([f("p", "string", { pattern: "([" })], { p: "anything" })
    ).toStrictEqual({ ok: true, answer: { p: "anything" } });
  });

  it("requires at least one pick for a required multiselect", () => {
    expect(
      buildAnswer([f("m", "multiselect", { required: true })], { m: [] })
    ).toStrictEqual({ ok: false, errors: { m: "Pick at least one" } });
  });
});

describe(safeUrl, () => {
  it("only lets http(s) links through", () => {
    expect(safeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("data:text/html,<b>x</b>")).toBeUndefined();
    expect(safeUrl("not a url")).toBeUndefined();
    expect(safeUrl(undefined)).toBeUndefined();
  });
});

describe(inputType, () => {
  it("maps formats the browser can validate", () => {
    expect(inputType("email")).toBe("email");
    expect(inputType("uri")).toBe("url");
    expect(inputType("date")).toBe("date");
    expect(inputType("date-time")).toBe("text");
    expect(inputType(undefined)).toBe("text");
  });
});
