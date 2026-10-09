import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/** A Connect-style handler that serves the UI, calling `next` for anything it does not handle. */
export interface DevUi {
  handle: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  close: () => Promise<void>;
}

/**
 * Vite in middleware mode, so `pnpm dev` serves the live UI (HMR, TanStack devtools) on the
 * dashboard port instead of the last production build. Vite is a dev dependency and external to
 * the tsup bundle, so it is only loaded here.
 */
export const startDevUi = async (): Promise<DevUi> => {
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: path.resolve(import.meta.dirname, "../../vite.config.ts"),
    server: { middlewareMode: true },
  });
  return {
    close: () => vite.close(),
    handle: (req, res, next) => vite.middlewares(req, res, next),
  };
};
