// node build-demo.mjs  -> inlines forge.mjs (exports stripped) into forge-demo.html
import { readFileSync, writeFileSync } from 'node:fs';
const u = f => new URL(f, import.meta.url);
const lib = readFileSync(u('./forge.mjs'), 'utf8').replace(/^export /gm, '');
const src = readFileSync(u('./forge-demo.src.html'), 'utf8');
if (!src.includes('/*@FORGE@*/')) throw new Error('marker missing');
writeFileSync(u('./forge-demo.html'), src.replace('/*@FORGE@*/', () => lib));
console.log('wrote forge-demo.html');
