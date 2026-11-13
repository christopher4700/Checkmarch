// Runs every Checkmarch test suite in order and fails if any of them fails.
// CI runs this (.github/workflows/tests.yml); run it locally with `node test-all.mjs` from the repository root.
import { spawn } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** The core suites, in order: each is a name, the folder it runs in, and its arguments to node. */
const CORE = [
  ['build game.html', 'checkmarch', ['build.mjs']],
  ['chess engine (perft 20/400/8902, mate, stalemate)', 'checkmarch', ['test-engine.mjs']],
  ['world integration', 'checkmarch', ['test-world.mjs']],
  ['balance check (win rate inside its target band)', 'checkmarch', ['balance-bot.mjs', '--check']],
];

/** Every module folder's own tests (checkmarch-*\/test-*.mjs), found on disk so a new module is picked up without editing this file. */
const MODULES = readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name.startsWith('checkmarch-'))
  .flatMap(d => readdirSync(join(ROOT, d.name)).filter(f => /^test-.*\.mjs$/.test(f)).map(f => [d.name.slice('checkmarch-'.length), '.', [`${d.name}/${f}`]]))
  .sort((a, b) => a[2][0].localeCompare(b[2][0]));

const SUITES = [...CORE, ...MODULES];

/** Runs one suite and resolves with its exit status and everything it printed. */
const run = ([name, dir, args]) => new Promise(done => {
  if (!existsSync(join(ROOT, dir, args[0]))) return done({ name, ok: false, secs: '0.0', out: `missing ${args[0]}` });
  const t = Date.now(), child = spawn(process.execPath, args, { cwd: join(ROOT, dir) });
  let out = '';
  child.stdout.on('data', b => out += b);
  child.stderr.on('data', b => out += b);
  child.on('close', code => done({ name, ok: code === 0, secs: ((Date.now() - t) / 1000).toFixed(1), out: out.trimEnd() }));
});

// the build goes first, since other suites read the built page; the rest run side by side to keep CI under a minute
const t0 = Date.now();
const results = [await run(SUITES[0]), ...(await Promise.all(SUITES.slice(1).map(run)))];
const failed = [];
for (const { name, ok, secs, out } of results) {
  if (!ok) failed.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${secs}s)`);
  // a passing suite shows only its last line; a failing one shows everything it printed
  if (ok) console.log(`      ${out.split('\n').pop()}`);
  else console.log(out.replace(/^/gm, '      '));
}
console.log(`\nwall time ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (failed.length) {
  console.log(`\n${failed.length} of ${SUITES.length} suites failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\nAll ${SUITES.length} suites passed.`);
