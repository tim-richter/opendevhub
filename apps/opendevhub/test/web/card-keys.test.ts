import { describe, expect, it } from "vitest";

import {
  ARM_DELAY_MS,
  cardAction,
  canTakeFocus,
} from "../../src/web/card-keys";

const key = (
  k: string,
  over: Partial<Parameters<typeof cardAction>[0]> = {}
) => ({
  key: k,
  repeat: false,
  onCard: true,
  modified: false,
  ...over,
});

describe(cardAction, () => {
  const armed = { mountedAt: 0, now: ARM_DELAY_MS };

  it("maps the card's keys once it is armed", () => {
    expect(cardAction(key("Enter"), armed.mountedAt, armed.now)).toBe("once");
    expect(cardAction(key("a"), armed.mountedAt, armed.now)).toBe("always");
    expect(cardAction(key("r"), armed.mountedAt, armed.now)).toBe("reject");
    expect(cardAction(key("j"), armed.mountedAt, armed.now)).toBe("next");
    expect(cardAction(key("k"), armed.mountedAt, armed.now)).toBe("prev");
    expect(cardAction(key("x"), armed.mountedAt, armed.now)).toBeUndefined();
  });

  it("ignores a second press that lands on a card that just appeared", () => {
    expect(
      cardAction(key("Enter"), 1000, 1000 + ARM_DELAY_MS - 1)
    ).toBeUndefined();
    expect(cardAction(key("a"), 1000, 1100)).toBeUndefined();
  });

  it("ignores auto-repeat, keys typed in the card's fields and modified keys", () => {
    expect(
      cardAction(key("Enter", { repeat: true }), armed.mountedAt, armed.now)
    ).toBeUndefined();
    expect(
      cardAction(key("Enter", { onCard: false }), armed.mountedAt, armed.now)
    ).toBeUndefined();
    expect(
      cardAction(key("a", { modified: true }), armed.mountedAt, armed.now)
    ).toBeUndefined();
  });
});

describe(canTakeFocus, () => {
  const body = { id: "body" };
  const inside = { id: "inside" };
  const elsewhere = { id: "elsewhere" };
  const stack = { contains: (n: unknown) => n === inside };

  it("only takes focus from nowhere or from its own stack", () => {
    expect(canTakeFocus(body, body, stack)).toBeTruthy();
    expect(canTakeFocus(null, body, stack)).toBeTruthy();
    expect(canTakeFocus(inside, body, stack)).toBeTruthy();
    expect(canTakeFocus(elsewhere, body, stack)).toBeFalsy();
    expect(canTakeFocus(body, body, null)).toBeTruthy();
  });
});
