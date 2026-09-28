/**
 * README self-check: verifies that the claims a README makes about its own
 * repository still match the repository. Fully offline and keyless, so it can
 * run on every push and on a schedule. Used by `npm run check:readme` and the
 * "README check" workflow to keep repo2readme's own README honest.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface CheckContext {
  /** Parsed package.json. */
  pkg: { version?: string; scripts?: Record<string, string>; engines?: { node?: string }; name?: string };
  /** Every flag the CLI accepts, e.g. `--dry-run`, `-s` (including hidden ones). */
  cliFlags: ReadonlySet<string>;
  /** Flags shown in `--help` (hidden ones excluded); the README options block must list exactly these. */
  helpFlags: ReadonlySet<string>;
  /** Input names declared in action.yml, if any. */
  actionInputs?: ReadonlySet<string>;
  /** `owner/repo` of this repository, used to recognise its own tags, releases and Action. */
  repoSlug?: string;
  /** Whether a repository-relative path exists. */
  exists: (relPath: string) => boolean;
  /** Relative paths of the files in `src/` (e.g. `src/cli.ts`), for the layout block. */
  srcFiles?: readonly string[];
}

export interface CheckProblem {
  line: number;
  rule: 'npm-script' | 'path' | 'version' | 'cli-flag' | 'node-engine' | 'anchor' | 'action-input' | 'layout';
  message: string;
}

interface Block {
  lang: string;
  start: number; // line number of the opening fence (1-based)
  lines: string[];
}

const NPM_BUILTINS = new Set(['test', 'start', 'stop', 'restart']);

/** GitHub-compatible heading slug. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]|\[|\]\([^)]*\)/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

function parse(readme: string) {
  const lines = readme.split(/\r?\n/);
  const blocks: Block[] = [];
  const prose: Array<{ line: number; text: string }> = [];
  const headings: string[] = [];
  let fence: { marker: string; block: Block } | null = null;
  lines.forEach((text, i) => {
    const m = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(text);
    if (fence) {
      if (m && m[1]!.startsWith(fence.marker[0]!) && m[1]!.length >= fence.marker.length && !m[2]) fence = null;
      else fence.block.lines.push(text);
      return;
    }
    if (m) {
      const block: Block = { lang: m[2] ?? '', start: i + 1, lines: [] };
      blocks.push(block);
      fence = { marker: m[1]!, block };
      return;
    }
    prose.push({ line: i + 1, text });
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(text);
    if (h) headings.push(h[1]!);
  });
  return { blocks, prose, headings };
}

function add(problems: CheckProblem[], line: number, rule: CheckProblem['rule'], message: string) {
  problems.push({ line, rule, message });
}

export function checkReadme(readme: string, ctx: CheckContext): CheckProblem[] {
  const problems: CheckProblem[] = [];
  const { blocks, prose, headings } = parse(readme);
  const version = ctx.pkg.version;
  const scripts = ctx.pkg.scripts ?? {};

  // Headings: count duplicates the way GitHub does (foo, foo-1, ...).
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  for (const h of headings) {
    const base = slugify(h);
    const n = seen.get(base) ?? 0;
    slugs.add(n ? `${base}-${n}` : base);
    seen.set(base, n + 1);
  }

  // Everything (prose + code) for version and link scanning, with line numbers.
  const all = readme.split(/\r?\n/).map((text, i) => ({ line: i + 1, text }));
  const shellLines = blocks
    .filter((b) => ['sh', 'bash', 'shell', 'console', 'zsh', ''].includes(b.lang))
    .flatMap((b) => b.lines.map((text, j) => ({ line: b.start + 1 + j, text: text.replace(/^\s*\$\s+/, '') })));

  // 1. npm scripts shown in commands exist in package.json.
  for (const { line, text } of [...shellLines, ...prose]) {
    for (const m of text.matchAll(/\bnpm run(?:-script)?\s+([\w:.-]+)/g)) {
      if (!(m[1]! in scripts)) add(problems, line, 'npm-script', `\`npm run ${m[1]}\` but package.json has no "${m[1]}" script`);
    }
    for (const m of text.matchAll(/\bnpm\s+(test|start|stop|restart)\b/g)) {
      if (NPM_BUILTINS.has(m[1]!) && !(m[1]! in scripts)) add(problems, line, 'npm-script', `\`npm ${m[1]}\` but package.json has no "${m[1]}" script`);
    }
  }

  // 2. Referenced files and paths exist; 6. internal anchors resolve.
  for (const { line, text } of prose) {
    const stripped = text.replace(/`[^`]*`/g, '');
    for (const m of stripped.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, ...
      if (target.startsWith('#')) {
        const slug = decodeURIComponent(target.slice(1)).toLowerCase();
        if (!slugs.has(slug)) add(problems, line, 'anchor', `link to #${slug} but no heading has that anchor`);
        continue;
      }
      const rel = decodeURIComponent(target.split('#')[0]!.split('?')[0]!).replace(/^\.\//, '');
      if (rel && !ctx.exists(rel)) add(problems, line, 'path', `link to \`${rel}\` but that path does not exist`);
    }
    for (const m of text.matchAll(/`((?:src|test|bin|scripts|\.github)\/[^`\s]*)`/g)) {
      const rel = m[1]!.replace(/\/$/, '');
      if (!ctx.exists(rel)) add(problems, line, 'path', `\`${m[1]}\` does not exist`);
    }
  }
  for (const { line, text } of shellLines) {
    const m = /^\s*node\s+([\w./-]+\.[cm]?js)\b/.exec(text);
    if (m && !ctx.exists(m[1]!)) add(problems, line, 'path', `\`node ${m[1]}\` but that file does not exist`);
  }

  // 3. Versions of this project's own Action, release tag and tarball match package.json.
  if (version && ctx.repoSlug) {
    const slug = ctx.repoSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const name = (ctx.pkg.name ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns: Array<[RegExp, string]> = [
      [new RegExp(`\\b${slug}@v(\\d+\\.\\d+\\.\\d+[\\w.-]*)`, 'g'), 'Action tag'],
      [new RegExp(`${slug}/releases/(?:tag|download)/v(\\d+\\.\\d+\\.\\d+[\\w.-]*)`, 'g'), 'release URL'],
      [new RegExp(`\\[v(\\d+\\.\\d+\\.\\d+[\\w.-]*) release\\]`, 'g'), 'release link text'],
    ];
    if (name) patterns.push([new RegExp(`\\b${name}-(\\d+\\.\\d+\\.\\d+[\\w.-]*?)\\.tgz`, 'g'), 'tarball']);
    for (const { line, text } of all) {
      for (const [re, label] of patterns) {
        for (const m of text.matchAll(re)) {
          if (m[1] !== version) add(problems, line, 'version', `${label} says ${m[1]} but package.json version is ${version}`);
        }
      }
    }
  }

  // 4. CLI flags shown in commands exist; the options block matches --help exactly.
  for (const { line, text } of shellLines) {
    if (!/^\s*(?:npx\s+)?(?:repo2readme|node\s+bin\/repo2readme\.js)\b/.test(text)) continue;
    const cmd = text.replace(/\s#.*$/, '').replace(/\s[>|].*$/, '');
    for (const m of cmd.matchAll(/(?:^|\s)(--?[a-zA-Z][\w-]*)/g)) {
      if (!ctx.cliFlags.has(m[1]!)) add(problems, line, 'cli-flag', `command uses \`${m[1]}\`, which the CLI does not accept`);
    }
  }
  const optionsBlock = blocks.find((b) => /^\s*repo2readme \[options\]/.test(b.lines[0] ?? ''));
  if (optionsBlock) {
    const documented = new Set<string>();
    optionsBlock.lines.forEach((text, j) => {
      const m = /^\s+(?:(-[a-zA-Z]),\s+)?(--[\w-]+)/.exec(text);
      if (!m) return;
      for (const flag of [m[1], m[2]]) {
        if (!flag) continue;
        documented.add(flag);
        if (!ctx.helpFlags.has(flag)) add(problems, optionsBlock.start + 1 + j, 'cli-flag', `options block lists \`${flag}\`, which is not in --help`);
      }
    });
    for (const flag of ctx.helpFlags) {
      if (!documented.has(flag)) add(problems, optionsBlock.start, 'cli-flag', `\`${flag}\` is in --help but missing from the options block`);
    }
  }

  // 5. Node.js version claims match package.json engines.
  const engineMajor = /(\d+)/.exec(ctx.pkg.engines?.node ?? '')?.[1];
  if (engineMajor) {
    const claims: RegExp[] = [/Node\.js (\d+)\+/g, /Node\.js (\d+) or newer/g, /badge\/node-%3E%3D(\d+)/g, /Node\.js (\d+) or later/g];
    for (const { line, text } of all) {
      for (const re of claims) {
        for (const m of text.matchAll(re)) {
          if (m[1] !== engineMajor) add(problems, line, 'node-engine', `says Node.js ${m[1]} but package.json engines.node is "${ctx.pkg.engines?.node}"`);
        }
      }
    }
  }

  // Action example: every `with:` key is a real action.yml input.
  if (ctx.actionInputs && ctx.repoSlug) {
    for (const b of blocks.filter((x) => x.lang === 'yaml' || x.lang === 'yml')) {
      const usesAt = b.lines.findIndex((l) => l.includes(`uses: ${ctx.repoSlug}@`));
      if (usesAt < 0) continue;
      let inWith = false;
      let withIndent = -1;
      b.lines.slice(usesAt + 1).forEach((text, j) => {
        const indent = text.search(/\S/);
        if (/^\s*with:\s*$/.test(text)) {
          inWith = true;
          withIndent = indent;
          return;
        }
        if (!inWith || indent < 0) return;
        if (indent <= withIndent) {
          inWith = false;
          return;
        }
        const m = /^\s*#?\s*([a-z][\w-]*):\s/.exec(text);
        if (m && !ctx.actionInputs!.has(m[1]!)) add(problems, b.start + 2 + usesAt + j, 'action-input', `Action example uses input \`${m[1]}\`, which action.yml does not declare`);
      });
    }
  }

  // Layout block (`src/` followed by indented file names) lists exactly the files in src/.
  if (ctx.srcFiles) {
    const layout = blocks.find((b) => b.lines[0]?.trim() === 'src/');
    if (layout) {
      const listed = new Set<string>();
      layout.lines.slice(1).forEach((text, j) => {
        const m = /^\s+([\w.-]+\.[cm]?[jt]s)\b/.exec(text);
        if (!m) return;
        listed.add(`src/${m[1]}`);
        if (!ctx.exists(`src/${m[1]}`)) add(problems, layout.start + 2 + j, 'layout', `layout lists src/${m[1]}, which does not exist`);
      });
      for (const f of ctx.srcFiles) if (!listed.has(f)) add(problems, layout.start + 1, 'layout', `${f} exists but is missing from the src/ layout block`);
    }
  }

  return problems.sort((a, b) => a.line - b.line);
}

/** Build the context for a repository on disk. `cli` supplies the commander program's flags. */
export function loadContext(root: string, cli: { cliFlags: Set<string>; helpFlags: Set<string> }): CheckContext {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as CheckContext['pkg'] & { repository?: { url?: string } | string };
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
  const repoSlug = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repoUrl)?.[1];
  let actionInputs: Set<string> | undefined;
  const actionPath = path.join(root, 'action.yml');
  if (existsSync(actionPath)) {
    const yml = readFileSync(actionPath, 'utf8');
    const section = /^inputs:\n([\s\S]*?)(?=^\S)/m.exec(yml)?.[1] ?? '';
    actionInputs = new Set([...section.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]!));
  }
  let srcFiles: string[] | undefined;
  const srcDir = path.join(root, 'src');
  if (existsSync(srcDir)) {
    srcFiles = readdirTs(srcDir).map((f) => `src/${f}`);
  }
  return {
    pkg,
    ...cli,
    actionInputs,
    repoSlug,
    srcFiles,
    exists: (rel) => !path.isAbsolute(rel) && !rel.split('/').includes('..') && existsSync(path.join(root, rel)),
  };
}

function readdirTs(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /\.[cm]?ts$/.test(f) && !f.endsWith('.d.ts'))
    .sort();
}

export function formatProblems(file: string, problems: CheckProblem[]): string {
  return problems.map((p) => `${file}:${p.line}  [${p.rule}] ${p.message}`).join('\n');
}

export interface RunCheckDeps {
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  flags: { cliFlags: Set<string>; helpFlags: Set<string> };
}

/**
 * `repo2readme check [README.md] [--root <dir>]`: exit 0 when every claim matches the
 * repository, 5 when something drifted, 2 on usage errors.
 */
export function runCheck(argv: string[], deps: RunCheckDeps): number {
  let file = 'README.md';
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--root') root = argv[++i];
    else if (a === '-h' || a === '--help') {
      deps.stdout('Usage: repo2readme check [file] [--root <dir>]\n\nOffline, keyless check that a README still matches its repository:\nnpm scripts, file paths, versions, CLI flags, Node.js engine, anchors,\nAction inputs and the src/ layout. Exits 5 if anything drifted.\n');
      return 0;
    } else if (a.startsWith('-')) {
      deps.stderr(`Unknown option for check: ${a}\n`);
      return 2;
    } else file = a;
  }
  const readmePath = path.resolve(deps.cwd, file);
  const repoRoot = path.resolve(deps.cwd, root ?? path.dirname(readmePath));
  if (!existsSync(readmePath)) {
    deps.stderr(`README not found: ${file}\n`);
    return 2;
  }
  if (!existsSync(path.join(repoRoot, 'package.json'))) {
    deps.stderr(`No package.json in ${repoRoot}; pass --root <dir>.\n`);
    return 2;
  }
  const ctx = loadContext(repoRoot, deps.flags);
  const problems = checkReadme(readFileSync(readmePath, 'utf8'), ctx);
  const rel = path.relative(deps.cwd, readmePath) || file;
  if (problems.length) {
    deps.stderr(`${formatProblems(rel, problems)}\n\n${problems.length} README claim(s) no longer match the repository.\n`);
    return 5;
  }
  deps.stdout(`${rel}: all claims match the repository (npm scripts, paths, versions, CLI flags, Node.js engine, anchors, Action inputs, layout).\n`);
  return 0;
}
