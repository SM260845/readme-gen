import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../src/github.js';
import { buildInventory, categorize, DEFAULT_LIMITS, exclusionReason } from '../src/inventory.js';

const blob = (path: string, size = 100): TreeEntry => ({ path, type: 'blob', size });

describe('exclusionReason', () => {
  it.each([
    ['.env', 'secret'],
    ['.env.production', 'secret'],
    ['config/prod.env', 'secret'],
    ['keys/server.pem', 'secret'],
    ['certs/client.key', 'secret'],
    ['id_rsa', 'secret'],
    ['.npmrc', 'secret'],
    ['credentials.json', 'secret'],
    ['config/secrets.yml', 'secret'],
    ['terraform.tfstate', 'secret'],
    ['node_modules/lodash/index.js', 'dependency-dir'],
    ['packages/a/node_modules/x/package.json', 'dependency-dir'],
    ['.venv/lib/site.py', 'dependency-dir'],
    ['vendor/github.com/x/y.go', 'vendored'],
    ['third_party/lib.c', 'vendored'],
    ['dist/bundle.js', 'generated'],
    ['public/app.min.js', 'generated'],
    ['assets/logo.png', 'binary'],
    ['fonts/Inter.woff2', 'binary'],
    ['models/weights.safetensors', 'binary'],
    ['release.zip', 'binary'],
  ])('%s -> %s', (path, reason) => {
    expect(exclusionReason(path)).toBe(reason);
  });

  it.each(['.env.example', '.env.sample', 'README.md', 'package.json', 'src/index.ts', 'docs/secrets-management.md'])('allows %s', (p) => {
    expect(exclusionReason(p)).toBeNull();
  });
});

describe('categorize', () => {
  it('ranks README, license and manifests above source', () => {
    expect(categorize('README.md').category).toBe('readme');
    expect(categorize('LICENSE').category).toBe('license');
    expect(categorize('package.json').category).toBe('manifest');
    expect(categorize('.github/workflows/ci.yml').category).toBe('ci');
    expect(categorize('src/index.ts').category).toBe('entry-point');
    expect(categorize('.env.example').category).toBe('config-example');
    expect(categorize('yarn.lock').category).toBe('lockfile');
    expect(categorize('src/utils/strings.ts').category).toBe('other');
    expect(categorize('README.md').priority).toBeGreaterThan(categorize('src/index.ts').priority);
  });
});

describe('buildInventory', () => {
  it('excludes secrets, binaries, dependency and vendored files, and oversize files', () => {
    const inv = buildInventory(
      [
        blob('README.md'),
        blob('package.json'),
        blob('.env'),
        blob('node_modules/x/index.js'),
        blob('vendor/y.js'),
        blob('logo.png'),
        blob('docs/giant.md', 10_000_000),
        blob('src/index.ts'),
        blob('src/deep/helper.ts'),
        { path: 'src', type: 'tree', size: 0 },
      ],
      false,
    );
    const selected = inv.selected.map((s) => s.path);
    expect(selected).toEqual(['README.md', 'package.json', 'src/index.ts']);
    const reasons = Object.fromEntries(inv.excluded.map((e) => [e.path, e.reason]));
    expect(reasons).toMatchObject({
      '.env': 'secret',
      'node_modules/x/index.js': 'dependency-dir',
      'vendor/y.js': 'vendored',
      'logo.png': 'binary',
      'docs/giant.md': 'too-large',
    });
    expect(inv.topLevel).toContain('src/');
    expect(inv.totalFiles).toBe(9);
  });

  it('enforces file-count and byte limits', () => {
    const entries = Array.from({ length: 20 }, (_, i) => blob(`docs/guide-${String(i).padStart(2, '0')}.md`, 1000));
    entries.push(blob('README.md', 1000), blob('package.json', 1000));
    const inv = buildInventory(entries, false, { ...DEFAULT_LIMITS, maxFiles: 5, maxTotalBytes: 4000 });
    expect(inv.selected.length).toBeLessThanOrEqual(4);
    expect(inv.selected.map((s) => s.path).slice(0, 2)).toEqual(['README.md', 'package.json']);
    expect(inv.excluded.filter((e) => e.reason === 'limit').length).toBeGreaterThan(0);
    expect(inv.selected.reduce((n, s) => n + s.size, 0)).toBeLessThanOrEqual(4000);
  });

  it('lists but never reads test fixtures and snapshots', () => {
    const inv = buildInventory(
      [
        blob('README.md'),
        blob('test/fixtures/app/README.md'),
        blob('test/fixtures/app/package.json'),
        blob('src/__fixtures__/index.ts'),
        blob('pkg/testdata/go.mod'),
        blob('test/__snapshots__/cli.test.ts.snap'),
      ],
      false,
    );
    expect(inv.selected.map((s) => s.path)).toEqual(['README.md']);
    expect(inv.paths).toContain('test/fixtures/app/README.md');
    expect(categorize('test/fixtures/app/package.json').category).toBe('other');
  });

  it('caps CI workflow files per category', () => {
    const entries = Array.from({ length: 6 }, (_, i) => blob(`.github/workflows/w${i}.yml`));
    const inv = buildInventory(entries, false);
    expect(inv.selected.length).toBe(3);
  });
});
