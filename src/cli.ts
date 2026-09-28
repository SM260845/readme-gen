/**
 * repo2readme CLI entry point. `run()` is dependency-injected so the whole flow
 * can be exercised in tests with a mocked fetch and no network.
 */
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildBrief } from './brief.js';
import { ExitCode, Repo2ReadmeError, UsageError, ValidationError } from './errors.js';
import { FixtureProvider, OpenAICompatibleProvider, resolveProviderConfig, type ReadmeProvider } from './generator.js';
import { GitHubClient, parseRepoUrl, type FetchLike, type RepoRef } from './github.js';
import { buildInventory, DEFAULT_LIMITS, type InventoryLimits } from './inventory.js';
import { DEFAULT_OUTPUT, exists, formatSummary, resolveOutputPath, writeFileAtomic } from './output.js';
import { scrubKnownValues } from './secrets.js';
import { parseStyle, STYLE_IDS, STYLES, type StyleId } from './styles.js';
import { renderMarkdown, validateReadme } from './validate.js';

export interface Prompts {
  input(opts: { message: string; default?: string; validate?: (v: string) => boolean | string }): Promise<string>;
  select(opts: { message: string; choices: Array<{ name: string; value: string; description?: string }>; default?: string }): Promise<string>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
}

export interface CliDeps {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  isTTY?: boolean;
  prompts?: Prompts;
  /** Override provider construction (tests). */
  providerFactory?: (name: string) => ReadmeProvider;
}

interface CliOptions {
  style?: string;
  output?: string;
  force?: boolean;
  dryRun?: boolean;
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  timeout: number;
  genTimeout: number;
  verbose?: boolean;
  provider: string;
}

function readVersion(): string {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function positiveInt(label: string) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError(`${label} must be a positive integer.`);
    return n;
  };
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('repo2readme')
    .description('Generate a polished, evidence-backed README for a public GitHub repository.\nThe original README is never touched; output goes to README.generated.md by default.')
    .version(readVersion(), '-V, --version')
    .argument('[url]', 'public repository URL, e.g. https://github.com/acme/widget')
    .addOption(new Option('-s, --style <style>', 'writing style').choices([...STYLE_IDS]))
    .option('-o, --output <path>', `output file (default: ${DEFAULT_OUTPUT}); an explicit path may overwrite an existing file`)
    .option('-f, --force', 'overwrite the default output file if it already exists')
    .option('--dry-run', 'print the README to stdout instead of writing a file')
    .option('--max-files <n>', 'maximum number of files to read', positiveInt('--max-files'), DEFAULT_LIMITS.maxFiles)
    .option('--max-bytes <n>', 'maximum total bytes of file content to read', positiveInt('--max-bytes'), DEFAULT_LIMITS.maxTotalBytes)
    .option('--max-file-bytes <n>', 'skip files larger than this many bytes', positiveInt('--max-file-bytes'), DEFAULT_LIMITS.maxFileBytes)
    .option('--timeout <ms>', 'GitHub request timeout in milliseconds', positiveInt('--timeout'), 15_000)
    .option('--gen-timeout <ms>', 'generation request timeout in milliseconds', positiveInt('--gen-timeout'), 120_000)
    .option('-v, --verbose', 'list every GitHub request made')
    .addOption(new Option('--provider <name>', 'generation provider').choices(['openai', 'fixture']).default('openai').hideHelp())
    .addHelpText(
      'after',
      `
Styles:
${STYLE_IDS.map((s) => `  ${s.padEnd(14)} ${STYLES[s].summary}`).join('\n')}

Environment:
  GITHUB_TOKEN          optional; raises GitHub rate limits (read-only use)
  REPO2README_API_KEY     generation API key (or XAI_API_KEY / OPENAI_API_KEY)
  REPO2README_BASE_URL    OpenAI-compatible endpoint (default https://api.x.ai/v1)
  REPO2README_MODEL       model name (default grok-4.6)

Examples:
  $ repo2readme
  $ repo2readme https://github.com/acme/widget --style professional
  $ repo2readme https://github.com/acme/widget -s minimalist --dry-run`,
    );
  return program;
}

async function defaultPrompts(): Promise<Prompts> {
  const mod = await import('@inquirer/prompts');
  return {
    input: (o) => mod.input(o),
    select: (o) => mod.select(o),
    confirm: (o) => mod.confirm(o),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const secrets = [env.GITHUB_TOKEN, env.REPO2README_API_KEY, env.XAI_API_KEY, env.OPENAI_API_KEY];
  const say = (s: string) => stderr(scrubKnownValues(s, secrets) + '\n');

  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({ writeOut: (s) => stdout(s), writeErr: (s) => stderr(s) });

  try {
    try {
      await program.parseAsync(argv, { from: 'user' });
    } catch (err) {
      if (err instanceof CommanderError) {
        if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help') return ExitCode.OK;
        return ExitCode.USAGE;
      }
      throw err;
    }
    const opts = program.opts<CliOptions>();
    let urlArg = program.args[0];

    let prompts: Prompts | undefined = deps.prompts;
    const getPrompts = async () => (prompts ??= await defaultPrompts());
    let interactive = false;

    // 1. Repository URL
    if (!urlArg) {
      if (!isTTY) throw new UsageError('Missing repository URL.', 'Usage: repo2readme <https://github.com/owner/repo> --style <professional|trendy|minimalist|comprehensive>');
      interactive = true;
      urlArg = await (await getPrompts()).input({
        message: 'GitHub repository URL:',
        validate: (v) => {
          try {
            parseRepoUrl(v);
            return true;
          } catch (e) {
            return e instanceof Repo2ReadmeError ? `${e.message}${e.hint ? ` ${e.hint}` : ''}` : 'Invalid URL';
          }
        },
      });
    }
    const ref: RepoRef = parseRepoUrl(urlArg);

    // 2. Style
    let style: StyleId | null = parseStyle(opts.style);
    if (!style) {
      if (!isTTY) throw new UsageError('Missing --style.', `Choose one of: ${STYLE_IDS.join(', ')}.`);
      interactive = true;
      style = (await (await getPrompts()).select({
        message: 'Style:',
        choices: STYLE_IDS.map((s) => ({ name: STYLES[s].label, value: s, description: STYLES[s].summary })),
        default: 'professional',
      })) as StyleId;
    }

    // 3. Output path (resolved before any network work so we fail fast)
    let outputPath: string | null = null;
    if (!opts.dryRun) {
      let output = opts.output;
      let explicit = output !== undefined;
      let force = Boolean(opts.force);
      if (output === undefined && interactive) {
        const answer = (await (await getPrompts()).input({ message: 'Output path:', default: DEFAULT_OUTPUT })).trim() || DEFAULT_OUTPUT;
        output = answer;
        explicit = answer !== DEFAULT_OUTPUT;
        if (!explicit && !force && (await exists(path.resolve(cwd, answer)))) {
          force = await (await getPrompts()).confirm({ message: `${answer} exists. Overwrite it?`, default: false });
          if (!force) throw new UsageError('Cancelled; existing file left unchanged.', 'Choose a different output path.');
        }
      }
      outputPath = (await resolveOutputPath({ cwd, output, explicit, force })).path;
    }

    // 4. Provider (fail fast on missing key before touching GitHub)
    let provider: ReadmeProvider;
    if (deps.providerFactory) provider = deps.providerFactory(opts.provider);
    else if (opts.provider === 'fixture') provider = new FixtureProvider();
    else provider = new OpenAICompatibleProvider(resolveProviderConfig(env, opts.genTimeout), deps.fetch);
    const providerLabel = provider instanceof OpenAICompatibleProvider ? provider.describe() : provider.name;

    // 5. GitHub retrieval
    say(`Analyzing repository ${ref.owner}/${ref.repo}…`);
    const client = new GitHubClient({ token: env.GITHUB_TOKEN, timeoutMs: opts.timeout, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    const meta = await client.getRepo(ref);
    const [languages, release, tree] = await Promise.all([client.getLanguages(ref), client.getLatestRelease(ref), client.getTree(ref, meta.defaultBranch)]);
    const limits: InventoryLimits = { ...DEFAULT_LIMITS, maxFiles: opts.maxFiles, maxTotalBytes: opts.maxBytes, maxFileBytes: opts.maxFileBytes };
    const inventory = buildInventory(tree.entries, tree.truncated, limits);

    const contents = new Map<string, string>();
    const fetched = await mapLimit(inventory.selected, 6, async (f) => [f.path, await client.getRawFile(ref, meta.defaultBranch, f.path, limits.maxFileBytes)] as const);
    for (const [p, text] of fetched) {
      if (text === null) inventory.excluded.push({ path: p, size: 0, reason: 'binary' });
      else contents.set(p, text);
    }
    inventory.selected = inventory.selected.filter((f) => contents.has(f.path));

    const brief = buildBrief({ ref, meta, languages, release, inventory, contents, style });

    // 6. Generation
    say(`Generating ${STYLES[style].label} README with ${providerLabel}…`);
    const generated = await provider.generateReadme(brief, style);

    // 7. Render + validate
    const rendered = renderMarkdown(generated, brief);
    const report = validateReadme(rendered, brief, generated.warnings);
    if (report.errors.length) {
      throw new ValidationError(
        `The generated README failed validation:\n${report.errors.map((e) => `  - ${e}`).join('\n')}`,
        report.errors,
        'Nothing was written. Retry, or try a different style or model.',
      );
    }

    // 8. Output
    if (outputPath) await writeFileAtomic(outputPath, report.markdown);
    else stdout(report.markdown);

    const excludedCounts: Record<string, number> = {};
    for (const e of inventory.excluded) excludedCounts[e.reason] = (excludedCounts[e.reason] ?? 0) + 1;
    const summary = formatSummary({
      outputPath: outputPath ? path.relative(cwd, outputPath) || outputPath : null,
      repo: meta.htmlUrl,
      style: STYLES[style].label,
      provider: providerLabel,
      sources: brief.files.map((f) => f.path),
      excludedCounts,
      briefWarnings: brief.warnings,
      report,
      requestCount: client.requests.length,
    });
    if (opts.verbose) for (const r of client.requests) say(`  ${r.method} ${r.url} -> ${r.status ?? 'error'}`);
    if (outputPath) stdout(scrubKnownValues(summary, secrets) + '\n');
    else say(summary);
    return ExitCode.OK;
  } catch (err) {
    if (err instanceof Repo2ReadmeError) {
      say(`Error: ${err.message}`);
      if (err.hint) say(`  ${err.hint}`);
      return err.exitCode;
    }
    if (err instanceof Error && err.name === 'ExitPromptError') {
      say('Cancelled.');
      return 130;
    }
    say(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return ExitCode.UNEXPECTED;
  }
}

export async function main(argv: string[] = process.argv): Promise<number> {
  return run(argv.slice(2));
}
