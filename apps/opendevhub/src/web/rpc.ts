import { hc, parseResponse } from "hono/client";
import type { ClientResponse } from "hono/client";

import type { DashboardApi } from "../server/dashboard-api";

/** Only the route type crosses into the frontend; server implementations stay in the Node bundle. */
export const { api } = hc<DashboardApi>("/");

/**
 * A request the server refused; `status` is its HTTP status (409 while another action runs), and `log` the last
 * output of a command that failed, such as a git hook's.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly log: string[];
  constructor(message: string, status: number, log: string[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.log = log;
  }
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

const failure = async (res: Response, what: string): Promise<Error> => {
  const body: unknown = await res.json().catch(() => undefined);
  const isObject = !!body && typeof body === "object";
  const message =
    isObject && "error" in body && typeof body.error === "string"
      ? body.error
      : `${what} failed (${res.status})`;
  const log = isObject && "log" in body ? stringList(body.log) : [];
  return new ApiError(message, res.status, log);
};

/** The output a failed command left, when the error came from the server with one. */
export const errorLog = (error: unknown): string[] =>
  error instanceof ApiError ? error.log : [];

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
