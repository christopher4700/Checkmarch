// Builds audio-demo.html by inlining audio.mjs into audio-demo.template.html.
import { readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url);
const mod = readFileSync(new URL('audio.mjs', dir), 'utf8').replace(/^export function createAudio/m, 'function createAudio');
const tpl = readFileSync(new URL('audio-demo.template.html', dir), 'utf8');
writeFileSync(new URL('audio-demo.html', dir), tpl.replace('__AUDIO_MODULE__', () => mod));
console.log('wrote audio-demo.html');
