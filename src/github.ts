/**
 * Read-only GitHub access: REST API (metadata, tree, releases) and raw file URLs.
 * The client only ever issues GET requests and never clones the repository.
 */
import { GitHubError, UsageError } from './errors.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RepoRef {
  owner: string;
  repo: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Parse a canonical public repository URL: https://github.com/<owner>/<repo>.
 * Accepts an optional trailing slash or `.git` suffix and a missing scheme.
 */
export function parseRepoUrl(input: string): RepoRef {
  const raw = (input ?? '').trim();
  const example = 'Expected a URL like https://github.com/owner/repo';
  if (!raw) throw new UsageError('No repository URL given.', example);

  if (/^git@/i.test(raw) || /^ssh:\/\//i.test(raw)) {
    throw new UsageError(`"${raw}" is an SSH remote, not a web URL.`, example);
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UsageError(`"${raw}" is not a valid URL.`, example);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError(`Unsupported URL scheme "${url.protocol}".`, example);
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw new UsageError(`Only github.com repositories are supported (got host "${url.hostname}").`, example);
  }
  if (url.username || url.password) {
    throw new UsageError('Repository URLs must not contain credentials.', example);
  }
  if (url.search || url.hash) {
    throw new UsageError('Repository URL must not include a query string or fragment.', example);
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new UsageError(`"${raw}" does not name a repository.`, example);
  }
  if (parts.length > 2) {
    throw new UsageError(
      `"${raw}" points inside a repository. Use the repository root URL.`,
      `Try https://github.com/${parts[0]}/${parts[1]}`,
    );
  }
  const owner = parts[0] as string;
  const repo = (parts[1] as string).replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner)) throw new UsageError(`"${owner}" is not a valid GitHub owner name.`, example);
  if (!REPO_RE.test(repo) || repo === '.' || repo === '..') {
    throw new UsageError(`"${repo}" is not a valid GitHub repository name.`, example);
  }
  return { owner, repo };
}

export interface RepoMetadata {
  fullName: string;
  htmlUrl: string;
  description: string | null;
  homepage: string | null;
  defaultBranch: string;
  topics: string[];
  license: { spdxId: string | null; name: string } | null;
  private: boolean;
  archived: boolean;
  fork: boolean;
  size: number;
  stars: number;
  language: string | null;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size: number;
}

export interface TreeResult {
  entries: TreeEntry[];
  truncated: boolean;
}

export interface ReleaseInfo {
  tagName: string;
  name: string | null;
  htmlUrl: string;
}

export interface GitHubClientOptions {
  token?: string | undefined;
  fetch?: FetchLike;
  timeoutMs?: number;
  apiBaseUrl?: string;
  rawBaseUrl?: string;
  userAgent?: string;
}

/** Record of every request made; used by the CLI's --verbose output and by tests. */
export interface RequestLogEntry {
  method: string;
  url: string;
  status: number | undefined;
}

export class GitHubClient {
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly apiBase: string;
  private readonly rawBase: string;
  private readonly userAgent: string;
  readonly requests: RequestLogEntry[] = [];

  constructor(opts: GitHubClientOptions = {}) {
    this.token = opts.token || undefined;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.apiBase = (opts.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.rawBase = (opts.rawBaseUrl ?? 'https://raw.githubusercontent.com').replace(/\/$/, '');
    this.userAgent = opts.userAgent ?? 'repo2readme';
  }

  get authenticated(): boolean {
    return Boolean(this.token);
  }

  /** The only network primitive. Always GET; never sends a body. */
  private async get(url: string, accept: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: accept,
      'User-Agent': this.userAgent,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const entry: RequestLogEntry = { method: 'GET', url, status: undefined };
    this.requests.push(entry);
    try {
      const res = await this.fetchImpl(url, { method: 'GET', headers, signal: controller.signal, redirect: 'follow' });
      entry.status = res.status;
      return res;
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new GitHubError('timeout', `GitHub did not respond within ${Math.round(this.timeoutMs / 1000)}s (${redactUrl(url)}).`, {
          hint: 'Check your connection or raise the limit with --timeout <ms>.',
        });
      }
      throw new GitHubError('network', `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`, {
        hint: 'Check your network connection and proxy settings.',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson<T>(path: string, ref: RepoRef): Promise<{ data: T; res: Response }> {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;
    const res = await this.get(url, 'application/vnd.github+json');
    if (!res.ok) throw await this.mapError(res, ref);
    try {
      return { data: (await res.json()) as T, res };
    } catch {
      throw new GitHubError('bad_response', `GitHub returned invalid JSON for ${redactUrl(url)}.`, { status: res.status });
    }
  }

  /** Follow RFC 5988 Link headers, bounded by maxPages. */
  async getPaginated<T>(path: string, ref: RepoRef, maxPages = 3): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    for (let page = 0; next && page < maxPages; page++) {
      const { data, res } = await this.getJson<T[]>(next, ref);
      if (!Array.isArray(data)) break;
      out.push(...data);
      next = parseNextLink(res.headers.get('link'));
    }
    return out;
  }

  async getRepo(ref: RepoRef): Promise<RepoMetadata> {
    const { data } = await this.getJson<Record<string, unknown>>(`/repos/${enc(ref.owner)}/${enc(ref.repo)}`, ref);
    const license = data.license as { spdx_id?: string | null; name?: string } | null | undefined;
    const meta: RepoMetadata = {
      fullName: String(data.full_name ?? `${ref.owner}/${ref.repo}`),
      htmlUrl: String(data.html_url ?? `https://github.com/${ref.owner}/${ref.repo}`),
      description: typeof data.description === 'string' && data.description.trim() ? data.description : null,
      homepage: typeof data.homepage === 'string' && data.homepage.trim() ? data.homepage.trim() : null,
      defaultBranch: String(data.default_branch ?? 'main'),
      topics: Array.isArray(data.topics) ? (data.topics as unknown[]).map(String) : [],
      license:
        license && typeof license === 'object'
          ? {
              spdxId: license.spdx_id && license.spdx_id !== 'NOASSERTION' ? license.spdx_id : null,
              name: String(license.name ?? 'Unknown'),
            }
          : null,
      private: Boolean(data.private),
      archived: Boolean(data.archived),
      fork: Boolean(data.fork),
      size: Number(data.size ?? 0),
      stars: Number(data.stargazers_count ?? 0),
      language: typeof data.language === 'string' ? data.language : null,
    };
    if (meta.private) {
      throw new GitHubError('private_repo', `${meta.fullName} is a private repository.`, {
        hint: 'repo2readme v1 only supports public repositories.',
      });
    }
    return meta;
  }

  async getLanguages(ref: RepoRef): Promise<Record<string, number>> {
    try {
      const { data } = await this.getJson<Record<string, number>>(`/repos/${enc(ref.owner)}/${enc(ref.repo)}/languages`, ref);
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      if (err instanceof GitHubError && (err.kind === 'not_found' || err.kind === 'server')) return {};
      throw err;
    }
  }

  async getLatestRelease(ref: RepoRef): Promise<ReleaseInfo | null> {
    try {
      const releases = await this.getPaginated<Record<string, unknown>>(
        `/repos/${enc(ref.owner)}/${enc(ref.repo)}/releases?per_page=10`,
        ref,
        1,
      );
      const rel = releases.find((r) => !r.draft && !r.prerelease) ?? releases.find((r) => !r.draft);
      if (!rel) return null;
      return {
        tagName: String(rel.tag_name ?? ''),
        name: typeof rel.name === 'string' ? rel.name : null,
        htmlUrl: String(rel.html_url ?? ''),
      };
    } catch (err) {
      if (err instanceof GitHubError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  async getTree(ref: RepoRef, branch: string): Promise<TreeResult> {
    const { data } = await this.getJson<{ tree?: Array<Record<string, unknown>>; truncated?: boolean }>(
      `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/trees/${enc(branch)}?recursive=1`,
      ref,
    );
    const entries: TreeEntry[] = (data.tree ?? []).map((e) => ({
      path: String(e.path),
      type: (e.type as TreeEntry['type']) ?? 'blob',
      size: Number(e.size ?? 0),
    }));
    if (entries.filter((e) => e.type === 'blob').length === 0) {
      throw emptyRepoError(ref);
    }
    return { entries, truncated: Boolean(data.truncated) };
  }

  /** Fetch a file's text via raw.githubusercontent.com (does not consume REST API quota). */
  async getRawFile(ref: RepoRef, branch: string, path: string, maxBytes: number): Promise<string | null> {
    const url = `${this.rawBase}/${enc(ref.owner)}/${enc(ref.repo)}/${encodePath(branch)}/${encodePath(path)}`;
    const res = await this.get(url, 'text/plain');
    if (res.status === 404) return null;
    if (!res.ok) throw await this.mapError(res, ref);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return null;
    return buf.includes(0) ? null : buf.toString('utf8');
  }

  private async mapError(res: Response, ref: RepoRef): Promise<GitHubError> {
    const full = `${ref.owner}/${ref.repo}`;
    let apiMessage = '';
    try {
      const body = (await res.json()) as { message?: string };
      apiMessage = body?.message ?? '';
    } catch {
      /* body not JSON */
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    const resetHeader = res.headers.get('x-ratelimit-reset');
    const retryAfter = res.headers.get('retry-after');
    const tokenHint = this.token
      ? 'Your GITHUB_TOKEN is in use; wait for the reset time.'
      : 'Set GITHUB_TOKEN to raise the limit from 60 to 5,000 requests/hour.';

    const isRateLimited =
      res.status === 429 || ((res.status === 403 || res.status === 429) && (remaining === '0' || /rate limit/i.test(apiMessage)));
    if (isRateLimited) {
      let resetAt: Date | undefined;
      if (resetHeader && /^\d+$/.test(resetHeader)) resetAt = new Date(Number(resetHeader) * 1000);
      else if (retryAfter && /^\d+$/.test(retryAfter)) resetAt = new Date(Date.now() + Number(retryAfter) * 1000);
      const when = resetAt ? ` Limit resets at ${formatLocal(resetAt)}.` : '';
      return new GitHubError('rate_limited', `GitHub API rate limit exceeded.${when}`, {
        status: res.status,
        ...(resetAt ? { resetAt } : {}),
        hint: tokenHint,
      });
    }
    switch (res.status) {
      case 401:
        return new GitHubError('unauthorized', 'GitHub rejected the credentials (401 Unauthorized).', {
          status: 401,
          hint: 'Your GITHUB_TOKEN is invalid or expired. Create a new token or unset GITHUB_TOKEN to use anonymous access.',
        });
      case 403:
        return new GitHubError('forbidden', `GitHub refused access to ${full} (403 Forbidden)${apiMessage ? `: ${apiMessage}` : ''}.`, {
          status: 403,
          hint: this.token
            ? 'Check that your GITHUB_TOKEN is allowed to read public repositories (fine-grained tokens need "Public repositories" read access).'
            : 'The repository may be blocked or restricted. Try again later or set GITHUB_TOKEN.',
        });
      case 404:
        return new GitHubError('not_found', `Repository ${full} was not found, or it is private.`, {
          status: 404,
          hint: 'Check the owner/repo spelling. repo2readme v1 supports public repositories only.',
        });
      case 409:
        return emptyRepoError(ref);
      case 451:
        return new GitHubError('forbidden', `${full} is unavailable for legal reasons (451).`, { status: 451 });
      default:
        if (res.status >= 500) {
          return new GitHubError('server', `GitHub returned a server error (${res.status}).`, {
            status: res.status,
            hint: 'GitHub may be having problems; check https://www.githubstatus.com and retry.',
          });
        }
        return new GitHubError('bad_response', `Unexpected GitHub response ${res.status}${apiMessage ? `: ${apiMessage}` : ''}.`, {
          status: res.status,
        });
    }
  }
}

function emptyRepoError(ref: RepoRef): GitHubError {
  return new GitHubError('empty_repo', `Repository ${ref.owner}/${ref.repo} is empty; there is nothing to describe.`, {
    status: 409,
    hint: 'Push some code to the repository first.',
  });
}

export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1] ?? null;
  }
  return null;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function redactUrl(url: string): string {
  return url.replace(/([?&](?:access_token|token)=)[^&]+/gi, '$1[REDACTED]');
}

export function formatLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    ` (UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`
  );
}
