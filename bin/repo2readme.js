#!/usr/bin/env node
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`repo2readme requires Node.js 22 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

// Exit quietly when the reader goes away (e.g. `repo2readme --help | head`).
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

let cli;
try {
  cli = await import('../dist/cli.js');
} catch (err) {
  // Only a missing dist/cli.js means "not built"; other missing modules are real errors.
  const missingDist = err && err.code === 'ERR_MODULE_NOT_FOUND' && /[\\/]dist[\\/]cli\.js['"]?(\s|$)/.test(String(err.message));
  if (missingDist) {
    console.error('repo2readme: dist/ is missing. Run `npm run build` in the repo2readme checkout first.');
    process.exit(1);
  }
  throw err;
}

cli.main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`repo2readme: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
