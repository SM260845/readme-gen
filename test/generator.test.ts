import { describe, expect, it } from 'vitest';
import { GenerationError, UsageError } from '../src/errors.js';
import { FixtureProvider, isCheckoutInstall, OpenAICompatibleProvider, parseGeneratedReadme, README_RESPONSE_SCHEMA, resolveProviderConfig } from '../src/generator.js';
import { STYLE_IDS } from '../src/styles.js';
import { briefFor, fakeSecrets, json, loadFixture } from './helpers.js';

const completion = (content: unknown, finish = 'stop') => json({ choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finish }] });

describe('resolveProviderConfig', () => {
  it('prefers REPO2README_API_KEY and defaults to xAI', () => {
    const cfg = resolveProviderConfig({ REPO2README_API_KEY: 'k1-aaaaaaaa', XAI_API_KEY: 'k2', OPENAI_API_KEY: 'k3' });
    expect(cfg).toMatchObject({ apiKey: 'k1-aaaaaaaa', keySource: 'REPO2README_API_KEY', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6' });
  });
  it('uses XAI_API_KEY next', () => {
    expect(resolveProviderConfig({ XAI_API_KEY: 'k2', OPENAI_API_KEY: 'k3' }).keySource).toBe('XAI_API_KEY');
  });
  it('never sends an OpenAI key to xAI by default', () => {
    const cfg = resolveProviderConfig({ OPENAI_API_KEY: 'k3' });
    expect(cfg.baseUrl).toBe('https://api.openai.com/v1');
  });
  it('honours REPO2README_BASE_URL and REPO2README_MODEL', () => {
    const cfg = resolveProviderConfig({ OPENAI_API_KEY: 'k3', REPO2README_BASE_URL: 'https://llm.example.com/v1/', REPO2README_MODEL: 'm1' });
    expect(cfg).toMatchObject({ baseUrl: 'https://llm.example.com/v1', model: 'm1' });
  });
  it('rejects missing keys and insecure base URLs', () => {
    expect(() => resolveProviderConfig({})).toThrow(UsageError);
    expect(() => resolveProviderConfig({ REPO2README_API_KEY: 'k', REPO2README_BASE_URL: 'http://evil.example.com' })).toThrow(/https/);
    expect(resolveProviderConfig({ REPO2README_API_KEY: 'k', REPO2README_BASE_URL: 'http://localhost:8080/v1' }).baseUrl).toBe('http://localhost:8080/v1');
  });
});

describe('isCheckoutInstall', () => {
  it.each(['npm install', 'npm ci', 'npm ci --ignore-scripts', 'pnpm install --frozen-lockfile', 'yarn', 'uv sync', 'poetry install --no-root', 'pip install -e .', 'pip install -e ".[dev]"', 'pip install -r requirements-dev.txt', 'bundle install'])(
    'treats %j as a checkout install',
    (cmd) => expect(isCheckoutInstall(cmd)).toBe(true),
  );
  it.each(['npm install is-plain-obj', 'npm install --global @acme/widget', 'npm i -g foo', 'pip install requests', 'pnpm add zod', 'cargo install ripgrep'])(
    'treats %j as a user install',
    (cmd) => expect(isCheckoutInstall(cmd)).toBe(false),
  );
});

describe('FixtureProvider', () => {
  it.each(STYLE_IDS)('is deterministic and non-empty for %s', async (style) => {
    const brief = await briefFor(loadFixture('widget'), style);
    const p = new FixtureProvider();
    const a = await p.generateReadme(brief, style);
    const b = await p.generateReadme(brief, style);
    expect(a).toEqual(b);
    expect(a.title).toBe('widget');
    expect(a.sections.length).toBeGreaterThan(1);
  });

  it('puts checkout installs under Development when a user install is documented', async () => {
    const brief = await briefFor(loadFixture('widget'));
    const out = await new FixtureProvider().generateReadme(brief, 'professional');
    const section = (h: string) => out.sections.find((x) => x.heading === h)?.body ?? '';
    expect(section('Installation')).toContain('npm install --global @acme/widget');
    expect(section('Installation')).not.toMatch(/^npm install$/m);
    expect(section('Development')).toMatch(/^npm install$/m);
  });

  it('styles differ in shape', async () => {
    const brief = await briefFor(loadFixture('widget'));
    const p = new FixtureProvider();
    const min = await p.generateReadme(brief, 'minimalist');
    const comp = await p.generateReadme(brief, 'comprehensive');
    const trendy = await p.generateReadme(brief, 'trendy');
    expect(comp.sections.length).toBeGreaterThan(min.sections.length);
    expect(comp.sections[0]?.heading).toBe('Table of contents');
    expect(trendy.sections[0]?.body).toContain('[!TIP]');
  });
});

describe('OpenAICompatibleProvider', () => {
  const config = { apiKey: fakeSecrets.xaiKey(), keySource: 'REPO2README_API_KEY', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6', timeoutMs: 5000 };
  const good = { title: 'widget', sections: [{ heading: 'Overview', body: 'Render widgets.' }], warnings: ['check badge'] };

  it('posts a JSON-schema structured request and parses the response', async () => {
    const brief = await briefFor(loadFixture('widget'));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = new OpenAICompatibleProvider(config, async (url, init) => {
      calls.push({ url, init: init as RequestInit });
      return completion(good);
    });
    const out = await provider.generateReadme(brief, 'trendy');
    expect(out).toEqual(good);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${config.apiKey}`);
    const body = JSON.parse(String(call.init.body));
    expect(body.model).toBe('grok-4.6');
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'readme', strict: true, schema: README_RESPONSE_SCHEMA } });
    expect(body.messages[0].content).toMatch(/Never invent/);
    expect(body.messages[1].content).toContain('"Trendy"');
    expect(body.messages[1].content).not.toContain('fixture-env-file-sentinel-value');
    expect(String(call.init.body)).not.toContain(config.apiKey);
  });

  it('accepts JSON wrapped in a code fence', async () => {
    const brief = await briefFor(loadFixture('widget'));
    const provider = new OpenAICompatibleProvider(config, async () => completion('```json\n' + JSON.stringify(good) + '\n```'));
    expect((await provider.generateReadme(brief, 'professional')).title).toBe('widget');
  });

  it.each([
    [401, /rejected the API key \(401\)/],
    [403, /rejected the API key \(403\)/],
    [404, /Model or endpoint not found/],
    [429, /rate-limited/],
    [400, /rejected the request \(400\)/],
    [500, /HTTP 500/],
  ])('maps HTTP %i without leaking the key', async (status, re) => {
    const brief = await briefFor(loadFixture('widget'));
    const provider = new OpenAICompatibleProvider(config, async () => json({ error: { message: `bad key ${config.apiKey}` } }, status));
    const err = (await provider.generateReadme(brief, 'professional').catch((e: unknown) => e)) as GenerationError;
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.message).toMatch(re);
    expect(err.exitCode).toBe(4);
    expect(`${err.message} ${err.hint}`).not.toContain(config.apiKey);
  });

  it('fails on invalid JSON, empty content, truncation and bad shapes', async () => {
    const brief = await briefFor(loadFixture('widget'));
    const run = (res: Response) => new OpenAICompatibleProvider(config, async () => res).generateReadme(brief, 'professional');
    await expect(run(completion('not json'))).rejects.toThrow(/valid JSON/);
    await expect(run(json({ choices: [{ message: { content: '' } }] }))).rejects.toThrow(/empty response/);
    await expect(run(completion(good, 'length'))).rejects.toThrow(/cut off/);
    await expect(run(completion({ title: 'x', sections: [] }))).rejects.toThrow(/no "sections"/);
    await expect(run(json({ choices: [{ message: { refusal: 'nope' } }] }))).rejects.toThrow(/refused/);
  });

  it('maps timeouts and network errors', async () => {
    const brief = await briefFor(loadFixture('widget'));
    const slow = new OpenAICompatibleProvider({ ...config, timeoutMs: 20 }, (_u, init) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    await expect(slow.generateReadme(brief, 'professional')).rejects.toThrow(/did not respond/);
    const down = new OpenAICompatibleProvider(config, async () => {
      throw new TypeError('fetch failed');
    });
    await expect(down.generateReadme(brief, 'professional')).rejects.toThrow(/Could not reach/);
  });
});

describe('parseGeneratedReadme', () => {
  it('validates the structure', () => {
    expect(() => parseGeneratedReadme(null)).toThrow(GenerationError);
    expect(() => parseGeneratedReadme({ title: '', sections: [] })).toThrow(/title/);
    expect(() => parseGeneratedReadme({ title: 't', sections: [{ heading: 1 }] })).toThrow(/heading/);
    expect(parseGeneratedReadme({ title: ' t ', sections: [{ heading: 'h', body: 'b' }] })).toEqual({ title: 't', sections: [{ heading: 'h', body: 'b' }], warnings: [] });
  });
});
