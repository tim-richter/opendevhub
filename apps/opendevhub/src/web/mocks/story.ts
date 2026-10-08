import type { AnyHandler } from "msw";

import { createHandlers } from "./handlers";
import type { MockOptions } from "./handlers";

/**
 * A story `beforeEach` that swaps the mocked API: `options` change the default fixtures, `overrides` win over
 * every default route (e.g. `failing(...)` or `pending(...)`).
 */
export const mockApi =
  (options: MockOptions = {}, ...overrides: AnyHandler[]) =>
  ({ msw }: { msw: { use: (...handlers: AnyHandler[]) => void } }): void => {
    msw.use(...overrides, ...createHandlers(options));
  };
