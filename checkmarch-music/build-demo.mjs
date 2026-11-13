// Builds demo.html (and the legacy name audio-demo.html, same content) by inlining audio.mjs into
// audio-demo.template.html. Same export-stripping transform as the game's build.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url);
const mod = readFileSync(new URL('audio.mjs', dir), 'utf8').replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '');
const tpl = readFileSync(new URL('audio-demo.template.html', dir), 'utf8');
const html = tpl.replace('__AUDIO_MODULE__', () => mod);
for (const f of ['demo.html', 'audio-demo.html']) writeFileSync(new URL(f, dir), html);
console.log('wrote demo.html, audio-demo.html');
