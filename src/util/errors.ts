export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  STATUS_MISMATCH: 3,
  VALIDATION: 4,
  TAMPERED: 5,
  NOT_INITIALIZED: 6,
} as const;

/** Expected, user-facing failure. Printed without a stack trace. */
export class AwError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.ERROR,
    readonly hint?: string,
  ) {
    super(message);
  }
}
