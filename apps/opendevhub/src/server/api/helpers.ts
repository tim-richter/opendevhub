import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import type { ReviewMode } from "../../shared/types";
import { InvalidNodeError, InvalidRootError } from "../config";
import { CommandError } from "../environments/containers";
import { EditorUnavailableError } from "../environments/editors";
import {
  AlreadyAnsweredError,
  BusyError,
  NotFoundError,
  UnavailableError,
} from "../errors";
import { InvalidRequestError } from "../git/worktrees";
import { CredentialStoreError } from "../integrations/secrets";
import { IntegrationError } from "../integrations/settings";
import { InvalidSubscriptionError } from "../notifications/push";
import { DevcontainerExistsError } from "../projects/onboarding";
import { localDay } from "../sessions/usage";

/** Maps the errors request handlers can expect to a status; anything else is a 500. */
export const errorStatus = (
  err: unknown
): 400 | 404 | 409 | 412 | 422 | 500 | 502 => {
  if (err instanceof HTTPException && err.status === 400) {
    return 400;
  }
  if (err instanceof IntegrationError) {
    return err.status;
  }
  if (err instanceof CredentialStoreError) {
    return 502;
  }
  if (
    err instanceof InvalidRequestError ||
    err instanceof EditorUnavailableError ||
    err instanceof InvalidSubscriptionError ||
    err instanceof InvalidNodeError ||
    err instanceof InvalidRootError
  ) {
    return 400;
  }
  if (err instanceof NotFoundError) {
    return 404;
  }
  if (
    err instanceof BusyError ||
    err instanceof AlreadyAnsweredError ||
    err instanceof DevcontainerExistsError
  ) {
    return 409;
  }
  if (err instanceof UnavailableError) {
    return 412;
  }
  if (err instanceof CommandError) {
    return 422;
  }
  return 500;
};

/** A real YYYY-MM-DD date. */
export const isDay = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  localDay(new Date(`${value}T12:00:00`).getTime()) === value;

/** A path parameter of the matched route, which the route pattern guarantees. */
export const param = (c: Context, name: string): string =>
  c.req.param(name) ?? "";

export const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const reviewMode = (c: Context): ReviewMode => {
  const mode = c.req.query("mode") ?? "working";
  if (mode !== "working" && mode !== "branch" && mode !== "turn") {
    throw new InvalidRequestError(`unknown review mode ${mode}`);
  }
  return mode;
};

/** Image bytes from a repository; `nosniff` keeps the browser from reading them as anything but the image type. */
export const imageResponse = (
  c: Context,
  image: { bytes: Buffer; type: string }
) =>
  c.body(new Uint8Array(image.bytes), 200, {
    "cache-control": "no-store",
    "content-type": image.type,
    "x-content-type-options": "nosniff",
  });

export const errorResponse = (c: Context, error: unknown) =>
  c.json(
    { error: error instanceof Error ? error.message : String(error) },
    errorStatus(error)
  );

/** Preserve the concrete success type instead of erasing route responses to unknown. */
export const json = async <T>(c: Context, fn: (id: string) => T) => {
  try {
    return c.json(await fn(c.req.param("id") ?? ""), 200);
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const ok = (c: Context, fn: (id: string) => void | Promise<void>) =>
  json(c, async (id) => {
    await fn(id);
    return { ok: true };
  });
