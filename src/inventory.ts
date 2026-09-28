/**
 * File inventory and selection. Decides which repository files are high-signal
 * enough to read, and which must never be read or sent anywhere.
 */
import type { TreeEntry } from './github.js';

export interface InventoryLimits {
  /** Maximum number of files whose content is read. */
  maxFiles: number;
  /** Maximum total bytes of file content read. */
  maxTotalBytes: number;
  /** Maximum size of a single file to read. */
  maxFileBytes: number;
  /** Maximum number of tree entries kept in the inventory listing. */
  maxInventoryEntries: number;
}

export const DEFAULT_LIMITS: InventoryLimits = {
  maxFiles: 40,
  maxTotalBytes: 250_000,
  maxFileBytes: 60_000,
  maxInventoryEntries: 5_000,
};

export type FileCategory =
  | 'readme'
  | 'docs'
  | 'license'
  | 'manifest'
  | 'lockfile'
  | 'config-example'
  | 'ci'
  | 'container'
  | 'build'
  | 'entry-point'
  | 'other';

export type ExclusionReason = 'secret' | 'binary' | 'dependency-dir' | 'vendored' | 'generated' | 'too-large' | 'low-signal' | 'limit';

export interface SelectedFile {
  path: string;
  size: number;
  category: FileCategory;
  priority: number;
}

export interface ExcludedFile {
  path: string;
  size: number;
  reason: ExclusionReason;
}

export interface Inventory {
  totalFiles: number;
  totalDirs: number;
  treeTruncated: boolean;
  /** Top-level entries (dirs end with "/"), for structure hints. */
  topLevel: string[];
  /** All blob paths (bounded), used to resolve relative links in the output. */
  paths: string[];
  selected: SelectedFile[];
  excluded: ExcludedFile[];
}

const DEPENDENCY_DIRS = new Set([
  'node_modules',
  'bower_components',
  'jspm_packages',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'site-packages',
  'Pods',
  'Carthage',
  '.gradle',
  '.yarn',
  '.pnpm-store',
  '.bundle',
  '.cargo',
  'packages-cache',
]);

const VENDORED_DIRS = new Set(['vendor', 'vendors', 'third_party', 'third-party', 'thirdparty', 'external', 'deps', '_vendor']);

const GENERATED_DIRS = new Set(['dist', 'build', 'out', 'target', '.next', '.nuxt', '.output', 'coverage', '.cache', '.parcel-cache', '.git', '.svn', '.idea', '.vscode', 'obj']);

const BINARY_EXT = new Set(
  (
    'png jpg jpeg gif bmp ico icns webp avif tif tiff psd ai sketch fig svgz heic ' +
    'pdf doc docx xls xlsx ppt pptx odt ods key numbers pages ' +
    'zip tar gz tgz bz2 xz 7z rar zst lz4 jar war ear whl egg gem nupkg deb rpm apk ipa dmg iso img msi ' +
    'exe dll so dylib a lib o obj class pyc pyo pyd wasm bin dat db sqlite sqlite3 mdb ' +
    'woff woff2 ttf otf eot ' +
    'mp3 mp4 m4a wav ogg oga flac aac mov avi mkv webm wmv flv ' +
    'glb gltf fbx blend stl ' +
    'onnx pt pth ckpt safetensors h5 pb tflite npy npz pkl pickle parquet arrow feather'
  ).split(/\s+/),
);

const SECRET_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.htpasswd',
  '.pgpass',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials',
  'credentials.json',
  'client_secret.json',
  'service-account.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'secrets.toml',
  '.secrets',
  'master.key',
  'terraform.tfstate',
  'terraform.tfstate.backup',
  '.dockercfg',
  'config.json.secret',
]);

const SECRET_EXT = new Set(['pem', 'key', 'p12', 'pfx', 'keystore', 'jks', 'crt', 'cer', 'der', 'asc', 'gpg', 'pgp', 'ovpn', 'kdbx', 'tfvars', 'mobileprovision']);

const ENV_EXAMPLE_RE = /^\.env\.(example|sample|template|dist|defaults)$/i;

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'mix.lock',
  'pubspec.lock',
  'Podfile.lock',
  'flake.lock',
  'packages.lock.json',
]);

const MANIFESTS = new Set([
  'package.json',
  'deno.json',
  'deno.jsonc',
  'jsr.json',
  'tsconfig.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'requirements.txt',
  'requirements-dev.txt',
  'environment.yml',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
  'CMakeLists.txt',
  'meson.build',
  'stack.yaml',
  'cabal.project',
  'DESCRIPTION',
  'project.clj',
  'deps.edn',
  'build.sbt',
  'dub.json',
  'shard.yml',
  'vcpkg.json',
  'conanfile.txt',
  'action.yml',
  'action.yaml',
]);

const BUILD_FILES = new Set(['Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile', 'Taskfile.yml', 'Rakefile', 'noxfile.py', 'tox.ini', 'Procfile']);

const CONTAINER_FILES = new Set(['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Containerfile', 'devcontainer.json']);

const ENTRY_BASENAME_RE = /^(index|main|cli|app|server|__main__|__init__|mod|lib)\.(ts|tsx|js|mjs|cjs|jsx|py|go|rs|rb|php|java|kt|swift|cs|ex|exs|dart|c|cc|cpp|zig|lua|sh)$/;

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

/** Returns an exclusion reason if the path must never be read, else null. */
export function exclusionReason(path: string): ExclusionReason | null {
  const segments = path.split('/');
  const dirs = segments.slice(0, -1);
  const base = segments[segments.length - 1] ?? '';
  const lower = base.toLowerCase();

  for (const d of dirs) {
    if (DEPENDENCY_DIRS.has(d)) return 'dependency-dir';
    if (VENDORED_DIRS.has(d.toLowerCase())) return 'vendored';
    if (GENERATED_DIRS.has(d)) return 'generated';
  }

  // Secrets first: e.g. "server.key" must be excluded regardless of other rules.
  if ((lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')) && !ENV_EXAMPLE_RE.test(base)) return 'secret';
  if (SECRET_BASENAMES.has(lower)) return 'secret';
  if (SECRET_EXT.has(extname(base))) return 'secret';
  if (/(^|[._-])(secret|secrets|credential|credentials|private[-_]?key)([._-]|$)/i.test(base) && !/\.(md|rst|txt)$/i.test(base)) {
    return 'secret';
  }
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(lower)) return 'secret';

  if (BINARY_EXT.has(extname(base))) return 'binary';
  if (/\.(min|bundle)\.(js|css)$/i.test(base) || /\.map$/i.test(base)) return 'generated';
  return null;
}

export function categorize(path: string): { category: FileCategory; priority: number } {
  const base = basename(path);
  const depth = path.split('/').length - 1;
  const lower = base.toLowerCase();
  const ext = extname(base);
  // Higher priority = read first. Root-level files get a boost.
  const rootBoost = depth === 0 ? 10 : Math.max(0, 5 - depth * 2);

  if (/^readme(\.[a-z]+)?$/i.test(base)) return { category: 'readme', priority: 100 + rootBoost };
  if (/^(licen[cs]e|copying|unlicense)(\.[a-z]+)?$/i.test(base)) return { category: 'license', priority: 90 + rootBoost };
  if (MANIFESTS.has(base) || (depth === 0 && /\.gemspec$/i.test(base))) return { category: 'manifest', priority: 85 + rootBoost };
  if (ENV_EXAMPLE_RE.test(base) || /\.(example|sample|template)(\.[a-z]+)?$/i.test(base) || /^config\.example\./i.test(base)) {
    return { category: 'config-example', priority: 70 + rootBoost };
  }
  if (path.startsWith('.github/workflows/') && (ext === 'yml' || ext === 'yaml')) return { category: 'ci', priority: 65 };
  if (['.gitlab-ci.yml', '.travis.yml', 'azure-pipelines.yml', 'appveyor.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml'].includes(base) || path === '.circleci/config.yml') {
    return { category: 'ci', priority: 65 };
  }
  if (CONTAINER_FILES.has(base)) return { category: 'container', priority: 68 + rootBoost };
  if (BUILD_FILES.has(base)) return { category: 'build', priority: 75 + rootBoost };
  if (/^(contributing|changelog|changes|history|security|code_of_conduct|support|install|usage|faq|architecture)(\.[a-z]+)?$/i.test(base)) {
    return { category: 'docs', priority: 72 + rootBoost };
  }
  if (/^docs?\//i.test(path) && (ext === 'md' || ext === 'mdx' || ext === 'rst') && depth <= 2) {
    return { category: 'docs', priority: 55 - depth * 3 + (lower.startsWith('index') || lower.startsWith('readme') || lower.startsWith('getting') ? 5 : 0) };
  }
  if (ENTRY_BASENAME_RE.test(base) && depth <= 2) {
    return { category: 'entry-point', priority: 60 + rootBoost };
  }
  if (/^(cmd\/[^/]+\/main\.go|bin\/[^/]+|src\/bin\/[^/]+\.rs)$/.test(path)) return { category: 'entry-point', priority: 58 };
  if (LOCKFILES.has(base)) return { category: 'lockfile', priority: 20 + rootBoost };
  return { category: 'other', priority: 0 };
}

/**
 * Build the inventory from a repository tree. Pure function: no I/O.
 */
export function buildInventory(entries: TreeEntry[], treeTruncated: boolean, limits: InventoryLimits = DEFAULT_LIMITS): Inventory {
  const blobs = entries.filter((e) => e.type === 'blob');
  const dirs = entries.filter((e) => e.type === 'tree');
  const topLevel = [
    ...dirs.filter((d) => !d.path.includes('/')).map((d) => `${d.path}/`),
    ...blobs.filter((b) => !b.path.includes('/')).map((b) => b.path),
  ].sort();

  const excluded: ExcludedFile[] = [];
  const candidates: SelectedFile[] = [];

  for (const b of blobs) {
    const reason = exclusionReason(b.path);
    if (reason) {
      excluded.push({ path: b.path, size: b.size, reason });
      continue;
    }
    const { category, priority } = categorize(b.path);
    if (category === 'other') continue; // low-signal: listed in inventory only, never read
    if (b.size > limits.maxFileBytes) {
      excluded.push({ path: b.path, size: b.size, reason: 'too-large' });
      continue;
    }
    candidates.push({ path: b.path, size: b.size, category, priority });
  }

  candidates.sort((a, b) => b.priority - a.priority || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));

  // Keep at most a handful of CI files, docs and entry points so manifests win.
  const perCategoryCap: Partial<Record<FileCategory, number>> = { ci: 3, docs: 8, 'entry-point': 6, 'config-example': 4, lockfile: 2, container: 3 };
  const perCategoryCount: Partial<Record<FileCategory, number>> = {};
  const selected: SelectedFile[] = [];
  let bytes = 0;
  for (const c of candidates) {
    const cap = perCategoryCap[c.category];
    const count = perCategoryCount[c.category] ?? 0;
    if (cap !== undefined && count >= cap) {
      excluded.push({ path: c.path, size: c.size, reason: 'limit' });
      continue;
    }
    if (selected.length >= limits.maxFiles || bytes + c.size > limits.maxTotalBytes) {
      excluded.push({ path: c.path, size: c.size, reason: 'limit' });
      continue;
    }
    selected.push(c);
    perCategoryCount[c.category] = count + 1;
    bytes += c.size;
  }

  return {
    totalFiles: blobs.length,
    totalDirs: dirs.length,
    treeTruncated,
    topLevel: topLevel.slice(0, 60),
    paths: blobs.slice(0, limits.maxInventoryEntries).map((b) => b.path),
    selected,
    excluded,
  };
}
