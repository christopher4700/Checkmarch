// Builds map-demo.html from map-demo.src.html by inlining map.mjs + map-render.mjs.
// Usage: node build-demo.mjs          (writes map-demo.html)
//        node build-demo.mjs --check  (exit 1 if map-demo.html is stale)
// Same transform another page (game.html) can use: see MAP-API.md.
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

export function inlinedMapSource() {
  const a = moduleToScript(readFileSync(join(here, 'map.mjs'), 'utf8'));
  const b = moduleToScript(readFileSync(join(here, 'map-render.mjs'), 'utf8'));
  return '// ---- inlined from map.mjs ----\n' + a + '\n// ---- inlined from map-render.mjs ----\n' + b;
}

export function buildDemo() {
  const tpl = readFileSync(join(here, 'map-demo.src.html'), 'utf8');
  const code = inlinedMapSource();
  if (code.includes('</script')) throw new Error('module source contains </script');
  return tpl.replace('/*@INLINE*/', () => code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = buildDemo();
  const target = join(here, 'map-demo.html');
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(target, 'utf8'); } catch (_) { /* missing */ }
    if (cur !== out) { console.error('map-demo.html is stale: run node build-demo.mjs'); process.exit(1); }
    console.log('map-demo.html up to date');
  } else {
    writeFileSync(target, out);
    console.log('wrote', target, out.length, 'bytes');
  }
}
