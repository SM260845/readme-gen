/**
 * Output handling: path resolution with overwrite protection, atomic writes,
 * and the human-readable summary.
 */
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OutputError } from './errors.js';
import type { ValidationReport } from './validate.js';

export const DEFAULT_OUTPUT = 'README.generated.md';

export interface ResolveOutputOptions {
  cwd: string;
  output?: string | undefined;
  /** True when the user explicitly named the output path (flag or prompt answer). */
  explicit: boolean;
  force: boolean;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the output path. The default path is never overwritten unless --force;
 * an explicitly named path may overwrite an existing file (the user asked for it).
 */
export async function resolveOutputPath(opts: ResolveOutputOptions): Promise<{ path: string; overwrites: boolean }> {
  const target = path.resolve(opts.cwd, opts.output && opts.output.trim() ? opts.output.trim() : DEFAULT_OUTPUT);
  let overwrites = false;
  try {
    const st = await stat(target);
    if (st.isDirectory()) throw new OutputError(`Output path ${target} is a directory.`, 'Pass a file path with --output, e.g. --output docs/README.md.');
    overwrites = true;
  } catch (err) {
    if (err instanceof OutputError) throw err;
  }
  if (overwrites && !opts.explicit && !opts.force) {
    throw new OutputError(
      `${path.relative(opts.cwd, target) || target} already exists; refusing to overwrite it.`,
      'Re-run with --force to replace it, or choose another file with --output <path>.',
    );
  }
  return { path: target, overwrites };
}

/** Write via a temp file in the same directory, then rename into place (atomic on POSIX). */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new OutputError(`Could not write ${target}: ${err instanceof Error ? err.message : String(err)}`, 'Check that the directory exists and is writable.');
  }
}

export interface SummaryInput {
  outputPath: string | null;
  repo: string;
  style: string;
  provider: string;
  sources: string[];
  excludedCounts: Record<string, number>;
  briefWarnings: string[];
  report: ValidationReport;
  requestCount: number;
}

export function formatSummary(s: SummaryInput): string {
  const lines: string[] = [];
  const traced = s.report.claims.filter((c) => c.evidence);
  lines.push(s.outputPath ? `Created ${s.outputPath}` : 'Dry run: README printed to stdout (nothing written).');
  lines.push(`  Repository: ${s.repo}   Style: ${s.style}   Generator: ${s.provider}`);
  lines.push(`  Sources inspected (${s.sources.length}): ${s.sources.length ? s.sources.join(', ') : 'none'}`);
  const excl = Object.entries(s.excludedCounts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  if (excl) lines.push(`  Excluded from analysis: ${excl}`);
  lines.push(`  GitHub requests: ${s.requestCount} (all read-only GET)`);
  lines.push(`  Claims traced to evidence: ${traced.length}; needing verification: ${s.report.unverified.length}`);
  const warnings = [...s.briefWarnings, ...s.report.warnings];
  if (warnings.length) {
    lines.push('Warnings:');
    for (const w of warnings) lines.push(`  - ${w}`);
  }
  if (s.report.unverified.length) {
    lines.push('Verify before publishing:');
    for (const c of s.report.unverified.slice(0, 20)) lines.push(`  - [${c.kind}] ${c.value} (line ${c.line}): ${c.note ?? ''}`);
    if (s.report.unverified.length > 20) lines.push(`  - …and ${s.report.unverified.length - 20} more (see the README's "Verify before publishing" section)`);
  }
  lines.push('Review the README before using it. repo2readme never commits or pushes anything.');
  return lines.join('\n');
}
