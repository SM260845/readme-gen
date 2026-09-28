/**
 * The project brief: a structured, evidence-annotated summary of the repository
 * that is the ONLY input given to a generation provider.
 */
import type { RepoMetadata, RepoRef, ReleaseInfo } from './github.js';
import type { FileCategory, Inventory } from './inventory.js';
import { basename } from './inventory.js';
import { scanForSecrets } from './secrets.js';
import { STYLES, type StyleId } from './styles.js';

/** A path inside the repo, or a GitHub API source such as "github:metadata". */
export type Evidence = string;

export interface Fact {
  key: string;
  statement: string;
  evidence: Evidence[];
}

export type CommandPurpose = 'install' | 'build' | 'test' | 'run' | 'dev' | 'lint' | 'usage' | 'other';

export interface CommandHint {
  command: string;
  purpose: CommandPurpose;
  evidence: Evidence[];
  /** "evidence": appears in or is directly defined by a repo file. "inferred": conventional for the toolchain; must be verified. */
  confidence: 'evidence' | 'inferred';
}

export interface BriefFile {
  path: string;
  category: FileCategory;
  content: string;
  redactions: number;
}

export interface ProjectBrief {
  schemaVersion: 1;
  repo: {
    owner: string;
    name: string;
    fullName: string;
    url: string;
    description: string | null;
    homepage: string | null;
    defaultBranch: string;
    topics: string[];
    license: { spdxId: string | null; name: string } | null;
    languages: string[];
    latestRelease: ReleaseInfo | null;
    archived: boolean;
    fork: boolean;
  };
  style: { id: StyleId; label: string; instruction: string; preferredSections: string[] };
  facts: Fact[];
  commands: CommandHint[];
  files: BriefFile[];
  structure: string[];
  paths: string[];
  unknowns: string[];
  warnings: string[];
  evidenceUrls: string[];
}

export interface BriefInput {
  ref: RepoRef;
  meta: RepoMetadata;
  languages: Record<string, number>;
  release: ReleaseInfo | null;
  inventory: Inventory;
  /** Raw content keyed by path, for files in inventory.selected that were readable. */
  contents: Map<string, string>;
  style: StyleId;
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"'`\]]+[^\s<>()"'`\].,;:!?]/g;

export function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])];
}

export function buildBrief(input: BriefInput): ProjectBrief {
  const { ref, meta, inventory, contents, style } = input;
  const facts: Fact[] = [];
  const commands: CommandHint[] = [];
  const unknowns: string[] = [];
  const warnings: string[] = [];
  const publishChecks: Array<{ command: string; note: string }> = [];
  const pathSet = new Set(inventory.paths);
  const has = (p: string) => pathSet.has(p);

  const addCommand = (c: CommandHint) => {
    const norm = normalizeCommand(c.command);
    if (!norm) return;
    const existing = commands.find((x) => normalizeCommand(x.command) === norm);
    if (existing) {
      for (const e of c.evidence) if (!existing.evidence.includes(e)) existing.evidence.push(e);
      if (c.confidence === 'evidence') existing.confidence = 'evidence';
      return;
    }
    commands.push({ ...c, command: norm });
  };

  // --- Files: secret-scan and redact before anything else uses the content.
  const files: BriefFile[] = [];
  for (const sel of inventory.selected) {
    const raw = contents.get(sel.path);
    if (raw === undefined) continue;
    const scan = scanForSecrets(raw);
    if (scan.findings.length > 0) {
      warnings.push(
        `Redacted ${scan.findings.length} potential secret(s) in ${sel.path} (${[...new Set(scan.findings.map((f) => f.description))].join(', ')}) before analysis.`,
      );
    }
    files.push({ path: sel.path, category: sel.category, content: scan.redacted, redactions: scan.findings.length });
  }
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const text = (p: string) => fileByPath.get(p)?.content;

  // --- Metadata facts
  const md = 'github:metadata';
  if (meta.description) facts.push({ key: 'description', statement: meta.description, evidence: [md] });
  else unknowns.push('The repository has no GitHub description.');
  if (meta.homepage) facts.push({ key: 'homepage', statement: `Homepage: ${meta.homepage}`, evidence: [md] });
  if (meta.topics.length) facts.push({ key: 'topics', statement: `Topics: ${meta.topics.join(', ')}`, evidence: [md] });
  const languages = Object.entries(input.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([l]) => l);
  if (languages.length) facts.push({ key: 'languages', statement: `Languages: ${languages.slice(0, 6).join(', ')}`, evidence: ['github:languages'] });
  if (meta.license) {
    const licenseFile = inventory.paths.find((p) => /^(licen[cs]e|copying)(\.[a-z]+)?$/i.test(p));
    facts.push({
      key: 'license',
      statement: `License: ${meta.license.spdxId ?? meta.license.name}`,
      evidence: [md, ...(licenseFile ? [licenseFile] : [])],
    });
  } else {
    unknowns.push('No license was detected. Do not state or imply a license.');
  }
  if (input.release) {
    facts.push({ key: 'latest-release', statement: `Latest release: ${input.release.tagName} (${input.release.htmlUrl})`, evidence: ['github:releases'] });
  }
  if (meta.archived) warnings.push(`${meta.fullName} is archived (read-only); the README should say so.`);
  if (meta.fork) facts.push({ key: 'fork', statement: 'This repository is a fork.', evidence: [md] });
  if (inventory.treeTruncated) warnings.push('The repository tree was too large for GitHub to list completely; some files were not considered.');

  // --- Node / JavaScript
  const pkgText = text('package.json');
  if (pkgText) {
    let pkg: Record<string, unknown> | null = null;
    try {
      pkg = JSON.parse(pkgText) as Record<string, unknown>;
    } catch {
      warnings.push('package.json could not be parsed as JSON.');
    }
    if (pkg) {
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
      const lock = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json'].find(has);
      const ev = ['package.json', ...(lock ? [lock] : [])];
      facts.push({ key: 'package-manager', statement: `Package manager: ${pm}${lock ? ` (lockfile ${lock})` : ''}`, evidence: ev });
      if (typeof pkg.name === 'string') facts.push({ key: 'package-name', statement: `Package name: ${pkg.name}`, evidence: ['package.json'] });
      if (typeof pkg.version === 'string') facts.push({ key: 'package-version', statement: `Version: ${pkg.version}`, evidence: ['package.json'] });
      if (typeof pkg.description === 'string' && pkg.description) facts.push({ key: 'package-description', statement: pkg.description, evidence: ['package.json'] });
      const engines = pkg.engines as Record<string, string> | undefined;
      if (engines?.node) facts.push({ key: 'node-version', statement: `Requires Node.js ${engines.node}`, evidence: ['package.json'] });
      if (pkg.type === 'module') facts.push({ key: 'esm', statement: 'Published as an ES module (type: module).', evidence: ['package.json'] });
      if (typeof pkg.license === 'string') facts.push({ key: 'package-license', statement: `package.json license field: ${pkg.license}`, evidence: ['package.json'] });
      const deps = Object.keys((pkg.dependencies as Record<string, string>) ?? {});
      if (deps.length) facts.push({ key: 'dependencies', statement: `Runtime dependencies: ${deps.slice(0, 20).join(', ')}`, evidence: ['package.json'] });
      addCommand({ command: `${pm} install`, purpose: 'install', evidence: ev, confidence: 'evidence' });

      const scripts = (pkg.scripts as Record<string, string>) ?? {};
      for (const name of Object.keys(scripts).slice(0, 15)) {
        if (/^(pre|post)/.test(name) && Object.keys(scripts).includes(name.replace(/^(pre|post)/, ''))) continue;
        if (name === 'prepare' || name === 'prepublishOnly') continue;
        const cmd = runScript(pm, name);
        addCommand({ command: cmd, purpose: purposeForScript(name), evidence: ['package.json'], confidence: 'evidence' });
      }
      const bin = pkg.bin;
      const binNames = typeof bin === 'string' && typeof pkg.name === 'string' ? [basename(pkg.name)] : bin && typeof bin === 'object' ? Object.keys(bin) : [];
      if (binNames.length) facts.push({ key: 'cli', statement: `Provides CLI command(s): ${binNames.join(', ')}`, evidence: ['package.json'] });
      if (typeof pkg.name === 'string' && pkg.private !== true) {
        const cmd = `npm install ${binNames.length ? '--global ' : ''}${pkg.name}`;
        addCommand({ command: cmd, purpose: 'install', evidence: ['package.json'], confidence: 'inferred' });
        publishChecks.push({ command: cmd, note: `Whether "${pkg.name}" is published to the npm registry was not verified.` });
      }
    }
  }

  // --- Python
  const pyproject = text('pyproject.toml');
  if (pyproject) {
    const name = pyproject.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
    const requiresPython = pyproject.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m)?.[1];
    if (name) facts.push({ key: 'python-name', statement: `Python package name: ${name}`, evidence: ['pyproject.toml'] });
    if (requiresPython) facts.push({ key: 'python-version', statement: `Requires Python ${requiresPython}`, evidence: ['pyproject.toml'] });
    const scriptsBlock = pyproject.match(/^\[(?:project\.scripts|tool\.poetry\.scripts)\]\s*\n([\s\S]*?)(?:^\[|$(?![\s\S]))/m)?.[1];
    if (scriptsBlock) {
      const names = [...scriptsBlock.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1]);
      if (names.length) facts.push({ key: 'python-cli', statement: `Provides CLI command(s): ${names.join(', ')}`, evidence: ['pyproject.toml'] });
    }
    if (has('uv.lock')) addCommand({ command: 'uv sync', purpose: 'install', evidence: ['pyproject.toml', 'uv.lock'], confidence: 'evidence' });
    if (/^\[tool\.poetry\]/m.test(pyproject) || has('poetry.lock')) {
      addCommand({ command: 'poetry install', purpose: 'install', evidence: ['pyproject.toml'], confidence: 'evidence' });
    }
    addCommand({ command: 'pip install .', purpose: 'install', evidence: ['pyproject.toml'], confidence: 'inferred' });
    if (name) {
      addCommand({ command: `pip install ${name}`, purpose: 'install', evidence: ['pyproject.toml'], confidence: 'inferred' });
      publishChecks.push({ command: `pip install ${name}`, note: `Whether "${name}" is published to PyPI was not verified.` });
    }
  }
  if (text('setup.py') && !pyproject) addCommand({ command: 'pip install .', purpose: 'install', evidence: ['setup.py'], confidence: 'inferred' });
  for (const req of ['requirements.txt', 'requirements-dev.txt']) {
    if (text(req) !== undefined) addCommand({ command: `pip install -r ${req}`, purpose: 'install', evidence: [req], confidence: 'evidence' });
  }

  // --- Rust
  const cargo = text('Cargo.toml');
  if (cargo) {
    const name = cargo.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
    const edition = cargo.match(/^\s*edition\s*=\s*["']([^"']+)["']/m)?.[1];
    if (name) facts.push({ key: 'crate-name', statement: `Crate name: ${name}`, evidence: ['Cargo.toml'] });
    if (edition) facts.push({ key: 'rust-edition', statement: `Rust edition ${edition}`, evidence: ['Cargo.toml'] });
    addCommand({ command: 'cargo build --release', purpose: 'build', evidence: ['Cargo.toml'], confidence: 'inferred' });
    addCommand({ command: 'cargo test', purpose: 'test', evidence: ['Cargo.toml'], confidence: 'inferred' });
    if (has('src/main.rs')) addCommand({ command: 'cargo run', purpose: 'run', evidence: ['Cargo.toml', 'src/main.rs'], confidence: 'inferred' });
  }

  // --- Go
  const gomod = text('go.mod');
  if (gomod) {
    const mod = gomod.match(/^module\s+(\S+)/m)?.[1];
    const goVersion = gomod.match(/^go\s+(\S+)/m)?.[1];
    if (mod) facts.push({ key: 'go-module', statement: `Go module: ${mod}`, evidence: ['go.mod'] });
    if (goVersion) facts.push({ key: 'go-version', statement: `Go version directive: ${goVersion}`, evidence: ['go.mod'] });
    addCommand({ command: 'go build ./...', purpose: 'build', evidence: ['go.mod'], confidence: 'inferred' });
    addCommand({ command: 'go test ./...', purpose: 'test', evidence: ['go.mod'], confidence: 'inferred' });
    if (mod && (has('main.go') || inventory.paths.some((p) => /^cmd\/[^/]+\/main\.go$/.test(p)))) {
      addCommand({ command: `go install ${mod}@latest`, purpose: 'install', evidence: ['go.mod'], confidence: 'inferred' });
    }
  }

  // --- Ruby
  if (has('Gemfile')) {
    const evidence = ['Gemfile', ...(has('Gemfile.lock') ? ['Gemfile.lock'] : [])];
    addCommand({ command: 'bundle install', purpose: 'install', evidence, confidence: 'evidence' });
  }
  const rakefile = text('Rakefile');
  if (rakefile !== undefined) {
    const rake = has('Gemfile') ? 'bundle exec rake' : 'rake';
    for (const task of rakeTasks(rakefile).slice(0, 12)) {
      addCommand({ command: `${rake} ${task}`, purpose: purposeForScript(task), evidence: ['Rakefile'], confidence: 'evidence' });
    }
  }
  for (const gemspec of inventory.paths.filter((p) => !p.includes('/') && /\.gemspec$/i.test(p))) {
    const content = text(gemspec);
    const name =
      content?.match(/^[ \t]*[A-Za-z_]\w*\.name[ \t]*=[ \t]*["']([^"']+)["']/m)?.[1] ??
      content?.match(/Gem::Specification\.new[ \t(]+["']([^"']+)["']/)?.[1];
    if (!name) continue;
    facts.push({ key: 'ruby-gem-name', statement: `Ruby gem name: ${name}`, evidence: [gemspec] });
    const command = `gem install ${name}`;
    addCommand({ command, purpose: 'install', evidence: [gemspec], confidence: 'inferred' });
    publishChecks.push({ command, note: `Whether "${name}" is published to RubyGems was not verified.` });
  }

  // --- Make / just
  for (const mk of ['Makefile', 'makefile', 'GNUmakefile']) {
    const content = text(mk);
    if (!content) continue;
    const targets = [...content.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)].map((m) => m[1] as string).filter((t) => !t.startsWith('.'));
    for (const t of [...new Set(targets)].slice(0, 12)) {
      addCommand({ command: `make ${t}`, purpose: purposeForScript(t), evidence: [mk], confidence: 'evidence' });
    }
  }
  for (const jf of ['justfile', 'Justfile']) {
    const content = text(jf);
    if (!content) continue;
    const recipes = [...content.matchAll(/^([A-Za-z0-9][\w-]*)(?:\s+[^:\n=]*)?:(?!=)/gm)].map((m) => m[1] as string);
    for (const r of [...new Set(recipes)].slice(0, 12)) addCommand({ command: `just ${r}`, purpose: purposeForScript(r), evidence: [jf], confidence: 'evidence' });
  }

  // --- Containers
  if (has('Dockerfile')) {
    addCommand({ command: `docker build -t ${ref.repo.toLowerCase()} .`, purpose: 'build', evidence: ['Dockerfile'], confidence: 'inferred' });
  }
  const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find(has);
  if (compose) addCommand({ command: 'docker compose up', purpose: 'run', evidence: [compose], confidence: 'inferred' });

  // --- Commands that literally appear in docs and CI
  for (const f of files) {
    if (f.category === 'readme' || f.category === 'docs') {
      for (const cmd of extractDocCommands(f.content).slice(0, 25)) {
        addCommand({ command: cmd, purpose: guessPurpose(cmd), evidence: [f.path], confidence: 'evidence' });
      }
    } else if (f.category === 'ci') {
      for (const m of f.content.matchAll(/^[ \t]*-?[ \t]*run:[ \t]+(?![|>])(\S[^\n]*)$/gm)) {
        const cmd = (m[1] as string).trim().replace(/^["']|["']$/g, '');
        if (!cmd || cmd.includes('${{') || /\$\{?(GITHUB_|RUNNER_)/.test(cmd) || cmd.length > 200) continue;
        // CI steps are evidence for build/test tooling, not user-facing usage.
        const purpose = guessPurpose(cmd);
        addCommand({ command: cmd, purpose: purpose === 'usage' ? 'other' : purpose, evidence: [f.path], confidence: 'evidence' });
      }
    }
  }

  // Registry-install commands only become facts when the repository's own docs use them.
  for (const pc of publishChecks) {
    const c = commands.find((x) => x.command === normalizeCommand(pc.command));
    if (!c || c.confidence === 'inferred') unknowns.push(pc.note);
  }
  if (!commands.some((c) => c.purpose === 'install')) unknowns.push('No installation method was found in the inspected files.');
  if (!commands.some((c) => c.purpose === 'test')) unknowns.push('No test command was found.');
  if (!files.some((f) => f.category === 'readme')) unknowns.push('The repository has no existing README.');
  if (inventory.selected.length === 0) warnings.push('No high-signal files (manifests, docs, entry points) were found; the README will be thin.');

  const evidenceUrls = new Set<string>();
  evidenceUrls.add(meta.htmlUrl);
  if (meta.homepage) evidenceUrls.add(meta.homepage);
  if (input.release?.htmlUrl) evidenceUrls.add(input.release.htmlUrl);
  for (const f of files) for (const u of extractUrls(f.content)) if (!u.includes('[REDACTED]')) evidenceUrls.add(u);

  const def = STYLES[style];
  return {
    schemaVersion: 1,
    repo: {
      owner: ref.owner,
      name: ref.repo,
      fullName: meta.fullName,
      url: meta.htmlUrl,
      description: meta.description,
      homepage: meta.homepage,
      defaultBranch: meta.defaultBranch,
      topics: meta.topics,
      license: meta.license,
      languages,
      latestRelease: input.release,
      archived: meta.archived,
      fork: meta.fork,
    },
    style: { id: def.id, label: def.label, instruction: def.instruction, preferredSections: def.preferredSections },
    facts,
    commands,
    files,
    structure: inventory.topLevel,
    paths: inventory.paths,
    unknowns,
    warnings,
    evidenceUrls: [...evidenceUrls].slice(0, 300),
  };
}

export function normalizeCommand(cmd: string): string {
  return cmd
    .trim()
    .replace(/^\$\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function runScript(pm: string, name: string): string {
  if (name === 'test' || name === 'start') return pm === 'bun' ? `bun run ${name}` : `${pm} ${name}`;
  if (pm === 'npm') return `npm run ${name}`;
  if (pm === 'bun') return `bun run ${name}`;
  return `${pm} ${name}`;
}

/**
 * Task names declared in a Rakefile, qualified with their enclosing `namespace` blocks
 * (e.g. `namespace :db do; task :migrate; end` yields `db:migrate`). Namespaces are tracked
 * by indentation: a block ends at an `end` aligned with its `namespace` line, or when a
 * declaration appears at or left of that indentation.
 */
export function rakeTasks(rakefile: string): string[] {
  const stack: { name: string; indent: number }[] = [];
  const tasks: string[] = [];
  const name = (m: RegExpMatchArray, from: number) => m.slice(from, from + 3).find((g) => g !== undefined) as string;
  for (const line of rakefile.split(/\r?\n/)) {
    const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    if (/^[ \t]*end\b/.test(line)) {
      if (stack.length && stack[stack.length - 1]!.indent === indent) stack.pop();
      continue;
    }
    const ns = line.match(/^[ \t]*namespace[ \t(]+(?::([A-Za-z0-9_]+)|:?["']([A-Za-z0-9_:.-]+)["']|([A-Za-z0-9_]+):)[ \t)]*(?:do\b|\{)/);
    const task = line.match(/^[ \t]*task[ \t(]+(?::([A-Za-z0-9_]+[?!]?)|:?["']([A-Za-z0-9_:.-]+)["']|([A-Za-z0-9_]+):(?!:))/);
    if (!ns && !task) continue;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    if (ns) {
      // A one-line `namespace :x { ... }` opens and closes on the same line.
      if (!/(?:\}|\bend)\s*$/.test(line)) stack.push({ name: name(ns, 1), indent });
      continue;
    }
    tasks.push([...stack.map((s) => s.name), name(task!, 1)].join(':'));
  }
  return [...new Set(tasks)];
}

function purposeForScript(name: string): CommandPurpose {
  const n = name.toLowerCase();
  if (/^(test|tests|check|coverage|spec|e2e)(:|$)/.test(n) || n.startsWith('test')) return 'test';
  if (/^(build|compile|bundle|dist|package)/.test(n)) return 'build';
  if (/^(dev|watch|serve)/.test(n)) return 'dev';
  if (/^(start|run)/.test(n)) return 'run';
  if (/^(lint|format|fmt|typecheck|type-check|tsc)/.test(n)) return 'lint';
  if (/^(install|setup|bootstrap|deps)/.test(n)) return 'install';
  return 'other';
}

function guessPurpose(cmd: string): CommandPurpose {
  if (/\b(install|add|sync|get)\b/.test(cmd) && /^(npm|pnpm|yarn|bun|pip|pip3|pipx|uv|poetry|cargo|go|brew|gem|composer|apt|apt-get|conda|deno)\b/.test(cmd)) return 'install';
  if (/\btest\b|pytest|vitest|jest/.test(cmd)) return 'test';
  if (/\bbuild\b/.test(cmd)) return 'build';
  if (/\blint\b|\bfmt\b|\bformat\b/.test(cmd)) return 'lint';
  return 'usage';
}

const SHELL_FENCE_LANGS = new Set(['', 'sh', 'bash', 'shell', 'console', 'zsh', 'terminal', 'shell-session', 'powershell', 'ps1', 'cmd', 'fish']);

/** Extract command lines from shell-like fenced code blocks. */
export function extractDocCommands(markdown: string): string[] {
  const out: string[] = [];
  const lines = markdown.split('\n');
  let inFence = false;
  let fenceLang = '';
  let fenceMarker = '';
  for (const line of lines) {
    const m = line.match(/^\s*(```+|~~~+)\s*([\w-]*)/);
    if (m) {
      if (!inFence) {
        inFence = true;
        fenceMarker = (m[1] as string)[0] as string;
        fenceLang = (m[2] ?? '').toLowerCase();
        continue;
      } else if ((m[1] as string)[0] === fenceMarker) {
        inFence = false;
        continue;
      }
    }
    if (!inFence || !SHELL_FENCE_LANGS.has(fenceLang)) continue;
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // In untagged/console blocks, only lines that look like commands.
    if ((fenceLang === '' || fenceLang === 'console') && !/^(\$|>)\s/.test(t) && !looksLikeCommand(t)) continue;
    if (fenceLang === 'console' && !/^(\$|>)\s/.test(t) && !looksLikeCommand(t)) continue;
    out.push(normalizeCommand(t));
  }
  return [...new Set(out)];
}

const COMMAND_PREFIXES =
  /^(npm|npx|pnpm|pnpx|yarn|bun|bunx|deno|node|pip|pip3|pipx|python|python3|uv|uvx|poetry|conda|cargo|rustup|go|make|just|docker|podman|kubectl|helm|git|gh|brew|apt|apt-get|dnf|yum|pacman|gem|bundle|rake|composer|php|mvn|gradle|\.\/gradlew|dotnet|swift|mix|flutter|dart|curl|wget|export|cd|mkdir|cp|mv|chmod|sudo|sh|bash|zsh|source|terraform|java|ruby|rails|nix)\b/;

export function looksLikeCommand(line: string): boolean {
  return COMMAND_PREFIXES.test(normalizeCommand(line));
}
