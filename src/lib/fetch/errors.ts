/**
 * Fetch errors with a stable `code` that the API and UI map to visitor text
 * (see the parent plan's stuck-state table). Messages are for logs only.
 */

export class NotPublicError extends Error {
  readonly code = "not_public" as const;
  constructor(readonly reason: string) {
    super(`Not a public website: ${reason}`);
    this.name = "NotPublicError";
  }
}

export class RobotsBlocked extends Error {
  readonly code = "robots_blocked" as const;
  constructor(readonly host: string) {
    super(`robots.txt on ${host} disallows RetrofitBot`);
    this.name = "RobotsBlocked";
  }
}

export class RobotsUnavailable extends Error {
  readonly code = "robots_unavailable" as const;
  constructor(
    readonly host: string,
    readonly retryAt: Date,
  ) {
    super(`robots.txt on ${host} could not be read; retry after ${retryAt.toISOString()}`);
    this.name = "RobotsUnavailable";
  }
}

export class FetchTimeoutError extends Error {
  readonly code = "timeout" as const;
  constructor(readonly url: string) {
    super(`Timed out fetching ${url}`);
    this.name = "FetchTimeoutError";
  }
}

export class TooManyRedirects extends Error {
  readonly code = "too_many_redirects" as const;
  constructor(readonly url: string) {
    super(`Too many redirects from ${url}`);
    this.name = "TooManyRedirects";
  }
}
