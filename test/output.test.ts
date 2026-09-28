import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OutputError } from '../src/errors.js';
import { DEFAULT_OUTPUT, resolveOutputPath, writeFileAtomic } from '../src/output.js';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'repo2readme-test-'));

describe('resolveOutputPath', () => {
  it('defaults to README.generated.md', async () => {
    const dir = await tmp();
    expect((await resolveOutputPath({ cwd: dir, explicit: false, force: false })).path).toBe(path.join(dir, DEFAULT_OUTPUT));
  });

  it('refuses to overwrite the default output without --force', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, DEFAULT_OUTPUT), 'old');
    await expect(resolveOutputPath({ cwd: dir, explicit: false, force: false })).rejects.toThrow(OutputError);
    await expect(resolveOutputPath({ cwd: dir, explicit: false, force: false })).rejects.toMatchObject({ hint: expect.stringMatching(/--force/) });
    expect((await resolveOutputPath({ cwd: dir, explicit: false, force: true })).overwrites).toBe(true);
  });

  it('allows an explicitly named existing file', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'README.md'), 'old');
    const r = await resolveOutputPath({ cwd: dir, output: 'README.md', explicit: true, force: false });
    expect(r).toEqual({ path: path.join(dir, 'README.md'), overwrites: true });
  });

  it('rejects directories', async () => {
    const dir = await tmp();
    await expect(resolveOutputPath({ cwd: dir, output: '.', explicit: true, force: true })).rejects.toThrow(/is a directory/);
  });
});

describe('writeFileAtomic', () => {
  it('writes via a temp file and leaves no temp files behind', async () => {
    const dir = await tmp();
    const target = path.join(dir, 'nested', 'README.md');
    await writeFileAtomic(target, '# hi\n');
    await writeFileAtomic(target, '# hello\n');
    expect(await readFile(target, 'utf8')).toBe('# hello\n');
    expect((await readdir(path.dirname(target))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('reports unwritable targets', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'file'), 'x');
    await expect(writeFileAtomic(path.join(dir, 'file', 'README.md'), 'x')).rejects.toThrow(OutputError);
  });
});
