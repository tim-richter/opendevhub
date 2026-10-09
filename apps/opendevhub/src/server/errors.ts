export class BusyError extends Error {
  constructor(id: string, message?: string) {
    super(message ?? `another action is already running for ${id}`);
    this.name = "BusyError";
  }
}

/** The request is fine but the project can't serve it right now (container stopped, mount missing…). */
export class UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnavailableError";
  }
}

export class NotFoundError extends Error {
  constructor(id: string, what = "project") {
    super(`unknown ${what} ${id}`);
    this.name = "NotFoundError";
  }
}

/** The permission request or form was already answered or cancelled, e.g. in the opencode tab. */
export class AlreadyAnsweredError extends Error {
  constructor() {
    super("already answered");
    this.name = "AlreadyAnsweredError";
  }
}
