// Builds fx-demo.html from fx-demo.src.html by inlining fx.mjs (imports dropped, `export ` stripped:
// the same transform checkmarch/build.mjs uses for the game's modules).
// Usage: node build-demo.mjs          (writes fx-demo.html)
//        node build-demo.mjs --check  (exit 1 if fx-demo.html is stale)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function moduleToScript(src) {
  return src
    .replace(/^import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '');
}

export function buildDemo() {
  const tpl = readFileSync(join(here, 'fx-demo.src.html'), 'utf8');
  const code = moduleToScript(readFileSync(join(here, 'fx.mjs'), 'utf8'));
  if (code.includes('</script')) throw new Error('fx.mjs contains </script');
  if (!tpl.includes('/*@FX*/')) throw new Error('fx-demo.src.html: /*@FX*/ marker missing');
  return tpl.replace('/*@FX*/', () => '// ---- inlined from fx.mjs by build-demo.mjs ----\n' + code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const html = buildDemo();
  const out = join(here, 'fx-demo.html');
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(out, 'utf8'); } catch (e) { cur = ''; }
    if (cur !== html) { console.error('fx-demo.html is stale: run node build-demo.mjs'); process.exit(1); }
    console.log('fx-demo.html is fresh');
  } else {
    writeFileSync(out, html);
    console.log(`wrote fx-demo.html (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
  }
}
