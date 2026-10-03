import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkReadme, loadContext, slugify, type CheckContext } from '../src/check.js';
import { programFlags } from '../src/cli.js';
import { cli } from './cli-helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  const files = new Set(['LICENSE', 'CONTRIBUTING.md', 'src', 'src/cli.ts', 'src/check.ts', 'bin/repo2readme.js', '.github/workflows/ci.yml']);
  return {
    pkg: { name: 'repo2readme', version: '1.2.3', scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .' }, engines: { node: '>=22' } },
    cliFlags: new Set(['-s', '--style', '--dry-run', '--provider', '-h', '--help', '-V', '--version']),
    helpFlags: new Set(['-s', '--style', '--dry-run', '-h', '--help', '-V', '--version']),
    actionInputs: new Set(['style', 'api-key', 'provider']),
    repoSlug: 'acme/repo2readme',
    srcFiles: ['src/check.ts', 'src/cli.ts'],
    exists: (p) => files.has(p),
    ...over,
  };
}

const rules = (md: string, c = ctx()) => checkReadme(md, c).map((p) => `${p.line}:${p.rule}`);

describe('checkReadme', () => {
  it('passes a README whose claims all match', () => {
    const md = [
      '# tool',
      '![Node](https://img.shields.io/badge/node-%3E%3D22-339933) Node.js 22 or newer. See [License](#license) and [LICENSE](LICENSE).',
      '```sh',
      'npm run build',
      'npm test',
      'repo2readme https://github.com/a/b --style trendy --dry-run --provider fixture > out.md',
      'node bin/repo2readme.js --help',
      'npm install --global https://github.com/acme/repo2readme/releases/download/v1.2.3/repo2readme-1.2.3.tgz',
      '```',
      '```yaml',
      'steps:',
      '  - uses: acme/repo2readme@v1.2.3',
      '    with:',
      '      style: professional',
      '      # provider: fixture',
      '```',
      'Edit `src/cli.ts` and `.github/workflows/ci.yml`.',
      '## License',
    ].join('\n');
    expect(checkReadme(md, ctx())).toEqual([]);
  });

  it('flags npm scripts that package.json does not define', () => {
    expect(rules('# t\n```sh\nnpm run release\n```\nRun `npm start`.')).toEqual(['3:npm-script', '5:npm-script']);
  });

  it('flags broken relative links, backticked paths and node entry points', () => {
    expect(rules('# t\n[guide](docs/guide.md#x) and `src/gone.ts`\n```sh\nnode bin/missing.js\n```')).toEqual(['2:path', '2:path', '4:path']);
  });

  it('ignores external links and link syntax inside code spans', () => {
    expect(rules('# t\n[x](https://example.com) `[y](nowhere.md)` [m](mailto:a@b.c)')).toEqual([]);
  });

  it('flags stale Action tags, release URLs and tarball names', () => {
    const md = '# t\n[v1.2.0 release](https://github.com/acme/repo2readme/releases/tag/v1.2.0)\n```yaml\n- uses: acme/repo2readme@v1.1.0\n```\n`repo2readme-1.0.0.tgz`';
    expect(rules(md)).toEqual(['2:version', '2:version', '4:version', '6:version']);
  });

  it('flags CLI flags the program does not accept', () => {
    expect(rules('# t\n```console\n$ repo2readme https://github.com/a/b --stlye x -q\n```')).toEqual(['3:cli-flag', '3:cli-flag']);
  });

  it('requires the options block to match --help in both directions', () => {
    const md = '# t\n```text\nrepo2readme [options] [url]\n\n  -s, --style <style>  s\n      --gone            g\n  -h, --help           h\n```';
    const found = checkReadme(md, ctx());
    expect(found.map((p) => p.message)).toEqual([
      '`--dry-run` is in --help but missing from the options block',
      '`-V` is in --help but missing from the options block',
      '`--version` is in --help but missing from the options block',
      'options block lists `--gone`, which is not in --help',
    ]);
  });

  it('flags Node.js version claims that disagree with engines.node', () => {
    expect(rules('# t\nNode.js 20 or newer\n![n](https://img.shields.io/badge/node-%3E%3D18-green)\nNode.js 22+')).toEqual(['2:node-engine', '3:node-engine']);
  });

  it('flags anchors without a matching heading, honouring GitHub slugs and duplicates', () => {
    const md = '# t\n## GitHub token (optional)\n## FAQ\n## FAQ\n[a](#github-token-optional) [b](#faq-1) [c](#faq-2) [d](#nope)';
    expect(rules(md)).toEqual(['5:anchor', '5:anchor']);
  });

  it('ignores headings inside code fences', () => {
    expect(rules('# t\n```md\n## Hidden\n```\n[h](#hidden)')).toEqual(['5:anchor']);
  });

  it('flags Action inputs that action.yml does not declare', () => {
    const md = '# t\n```yaml\n- uses: acme/repo2readme@v1.2.3\n  with:\n    style: x\n    # temperature: 1\n- run: echo\n  env:\n    FOO: bar\n```';
    expect(rules(md)).toEqual(['6:action-input']);
  });

  it('requires the src/ layout block to list exactly the files in src/', () => {
    const md = '# t\n```text\nsrc/\n  cli.ts    cli\n  old.ts    removed\n```';
    expect(rules(md)).toEqual(['3:layout', '5:layout']);
  });

  it('slugifies like GitHub', () => {
    expect(slugify('This README is checked by its own tool')).toBe('this-readme-is-checked-by-its-own-tool');
    expect(slugify('`repo2readme check` & friends!')).toBe('repo2readme-check--friends');
  });
});

describe("repo2readme's own README", () => {
  it('matches the repository (same check as the README check workflow)', () => {
    const problems = checkReadme(readFileSync(path.join(ROOT, 'README.md'), 'utf8'), loadContext(ROOT, programFlags()));
    expect(problems).toEqual([]);
  });

  it('loads flags, action inputs and layout from the real repository', () => {
    const c = loadContext(ROOT, programFlags());
    expect(c.repoSlug).toBe('ao3575911/repo2readme');
    expect(c.cliFlags.has('--provider')).toBe(true);
    expect(c.helpFlags.has('--provider')).toBe(false);
    expect(c.actionInputs?.has('api-key')).toBe(true);
    expect(c.srcFiles).toContain('src/check.ts');
    expect(c.exists('../etc/passwd')).toBe(false);
  });
});

describe('repo2readme check (CLI)', () => {
  it('exits 0 on the real README without contacting the network', async () => {
    const r = await cli(['check', 'README.md'], { deps: { cwd: ROOT } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/README\.md: all claims match/);
    expect(r.requests).toEqual([]);
  });

  it('exits 5 and lists drifted claims', async () => {
    const r = await cli(['check', 'test/fixtures/drifted-readme.md', '--root', '.'], { deps: { cwd: ROOT } });
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/drifted-readme\.md:\d+ {2}\[npm-script\] `npm run publish-docs`/);
    expect(r.err).toMatch(/\[version\] Action tag says 0\.0\.1/);
    expect(r.err).toMatch(/\[cli-flag\] command uses `--colour`/);
    expect(r.err).toMatch(/\d+ README claim\(s\) no longer match/);
  });

  it('exits 2 for a missing file or unknown option, and prints help', async () => {
    expect((await cli(['check', 'NOPE.md'], { deps: { cwd: ROOT } })).code).toBe(2);
    expect((await cli(['check', '--bogus'], { deps: { cwd: ROOT } })).code).toBe(2);
    const help = await cli(['check', '--help'], { deps: { cwd: ROOT } });
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/Usage: repo2readme check/);
  });
});
