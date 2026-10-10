import { hc, parseResponse } from "hono/client";
import type { ClientResponse } from "hono/client";

import type { DashboardApi } from "../server/dashboard-api";

/** Only the route type crosses into the frontend; server implementations stay in the Node bundle. */
export const { api } = hc<DashboardApi>("/");

const failure = async (res: Response, what: string): Promise<Error> => {
  const body: unknown = await res.json().catch(() => undefined);
  const message =
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
      ? body.error
      : `${what} failed (${res.status})`;
  return new Error(message);
};

/** The success type comes from the server handler, including its JSON serialization. */
export const read = async <R extends ClientResponse<unknown>>(
  request: Promise<R>,
  what: string
) => {
  const res = await request;
  if (!res.ok) {
    throw await failure(res, what);
  }
  return parseResponse(res);
};

export const complete = async (
  request: Promise<Response>,
  what: string
): Promise<void> => {
  const res = await request;
  if (!res.ok) {
    throw await failure(res, what);
  }
};

/** A permission/form answered elsewhere disappears from the dashboard without showing an error. */
export const reply = async (
  request: Promise<Response>,
  what: string
): Promise<"done" | "gone"> => {
  const res = await request;
  if (res.status === 409) {
    return "gone";
  }
  if (!res.ok) {
    throw await failure(res, what);
  }
  return "done";
};
