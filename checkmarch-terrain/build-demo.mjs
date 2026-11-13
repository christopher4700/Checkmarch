// node build-demo.mjs : inline terrain.mjs (exports stripped, same transform as checkmarch/build.mjs)
// into terrain-demo.src.html -> terrain-demo.html, then node --check the inline script.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const dir = new URL('.', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const toScript = (src) => src.replace(/^import\s[^;]*;\s*$/gm, '').replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '');
const code = toScript(read('terrain.mjs'));
if (/^export\s|^import\s/m.test(code)) throw new Error('terrain.mjs: leftover import/export');
if (code.includes('</script')) throw new Error('terrain.mjs contains </script');
const src = read('terrain-demo.src.html');
if (!src.includes('/*TERRAIN*/')) throw new Error('marker missing');
const html = src.replace('/*TERRAIN*/', () => code.trim());
writeFileSync(new URL('terrain-demo.html', dir), html);
const tmp = new URL('.inline-check.tmp.js', dir);
writeFileSync(tmp, html.match(/<script>([\s\S]*)<\/script>/)[1]);
try { execFileSync(process.execPath, ['--check', tmp.pathname], { stdio: 'inherit' }); console.log('node --check inline script: OK'); }
finally { unlinkSync(tmp); }
console.log(`terrain-demo.html written (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
