/** Base class so callers can tell our typed errors from unexpected ones. */
export class AppError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid or missing configuration. Messages name variables, never their values. */
export class ConfigError extends AppError {
  constructor(
    message: string,
    readonly variables: readonly string[],
  ) {
    super(message);
  }
}
