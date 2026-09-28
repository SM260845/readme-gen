/** Exit codes used by the CLI. Documented in README.md. */
export const ExitCode = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  GITHUB: 3,
  GENERATION: 4,
  VALIDATION: 5,
  OUTPUT: 6,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** An error with a user-facing, actionable message and a process exit code. */
export class Repo2ReadmeError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly hint: string | undefined;

  constructor(message: string, exitCode: ExitCodeValue, hint?: string) {
    super(message);
    this.name = 'Repo2ReadmeError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class UsageError extends Repo2ReadmeError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.USAGE, hint);
    this.name = 'UsageError';
  }
}

export type GitHubErrorKind =
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'empty_repo'
  | 'private_repo'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad_response';

export class GitHubError extends Repo2ReadmeError {
  readonly kind: GitHubErrorKind;
  readonly status: number | undefined;
  readonly resetAt: Date | undefined;

  constructor(
    kind: GitHubErrorKind,
    message: string,
    opts: { status?: number; resetAt?: Date; hint?: string } = {},
  ) {
    super(message, ExitCode.GITHUB, opts.hint);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = opts.status;
    this.resetAt = opts.resetAt;
  }
}

export class GenerationError extends Repo2ReadmeError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.GENERATION, hint);
    this.name = 'GenerationError';
  }
}

export class ValidationError extends Repo2ReadmeError {
  readonly problems: string[];
  constructor(message: string, problems: string[], hint?: string) {
    super(message, ExitCode.VALIDATION, hint);
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

export class OutputError extends Repo2ReadmeError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.OUTPUT, hint);
    this.name = 'OutputError';
  }
}
