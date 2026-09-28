/**
 * Full-output snapshots of the deterministic FixtureProvider for every style
 * and fixture. A silently dropped section or changed heading fails here.
 * After an intentional output change, refresh with `npx vitest -u` and review
 * the diff in `test/__snapshots__/`.
 */
import { describe, expect, it } from 'vitest';
import { STYLE_IDS } from '../src/styles.js';
import { cli } from './cli-helpers.js';

const FIXTURES = {
  widget: 'https://github.com/acme/widget',
  pyapp: 'https://github.com/someone/pyapp',
} as const;

const cases = Object.entries(FIXTURES).flatMap(([fixture, url]) => STYLE_IDS.map((style) => [fixture, style, url] as const));

describe('CLI style snapshots', () => {
  it.each(cases)('%s with %s style matches its snapshot', async (fixture, style, url) => {
    const r = await cli([url, '--style', style, '--dry-run', '--provider', 'fixture'], { fixture });
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/Unexpected error/);
    await expect(r.out).toMatchFileSnapshot(`__snapshots__/${fixture}-${style}.md`);
  });
});
