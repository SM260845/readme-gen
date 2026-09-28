import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, type CliDeps } from "../src/cli.js";
import {
  captureIO,
  createMockFetch,
  loadFixture,
  type MockFetchOptions,
} from "./helpers.js";

export const tmp = () => mkdtemp(path.join(os.tmpdir(), "repo2readme-cli-"));

export async function cli(
  argv: string[],
  opts: {
    fixture?: string | null;
    mock?: MockFetchOptions;
    deps?: Partial<CliDeps>;
    env?: Record<string, string>;
  } = {},
) {
  const io = captureIO();
  const fx =
    opts.fixture === null ? null : loadFixture(opts.fixture ?? "widget");
  const mock = createMockFetch(fx, opts.mock);
  const cwd = opts.deps?.cwd ?? (await tmp());
  const code = await run(argv, {
    fetch: mock.fetch,
    env: opts.env ?? {},
    cwd,
    stdout: io.stdout,
    stderr: io.stderr,
    isTTY: false,
    ...opts.deps,
  });
  return { code, out: io.out, err: io.err, requests: mock.requests, cwd };
}
