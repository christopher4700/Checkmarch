// Builds rival-demo.html from rival-demo.src.html by inlining map.mjs, map-render.mjs and rival.mjs
// (map.mjs and map-render.mjs are byte-identical copies from /home/user/checkmarch-map).
// Usage: node build-demo.mjs          (writes rival-demo.html)
//        node build-demo.mjs --check  (exit 1 if rival-demo.html is stale)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Turn an ES module source into classic-script source: drop imports, strip `export `. */
export function moduleToScript(src) {
  return src
    .replace(/^import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '');
}

export function inlinedRivalSource() {
  return '// ---- inlined from rival.mjs ----\n' + moduleToScript(readFileSync(join(here, 'rival.mjs'), 'utf8'));
}

export function buildDemo() {
  const parts = ['map.mjs', 'map-render.mjs', 'rival.mjs']
    .map(f => '// ---- inlined from ' + f + ' ----\n' + moduleToScript(readFileSync(join(here, f), 'utf8')));
  const code = parts.join('\n');
  if (code.includes('</script')) throw new Error('module source contains </script');
  return readFileSync(join(here, 'rival-demo.src.html'), 'utf8').replace('/*@INLINE*/', () => code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = buildDemo();
  const target = join(here, 'rival-demo.html');
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(target, 'utf8'); } catch (_) { /* missing */ }
    if (cur !== out) { console.error('rival-demo.html is stale: run node build-demo.mjs'); process.exit(1); }
    console.log('rival-demo.html up to date');
  } else {
    writeFileSync(target, out);
    console.log('wrote', target, out.length, 'bytes');
  }
}
