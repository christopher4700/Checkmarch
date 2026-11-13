// Build: inline the modules (imports dropped, export keywords stripped) into game.src.html -> game.html,
// check for top-level name clashes between them, then node --check the inline script.
// Modules, in order: engine.mjs, map.mjs + map-render.mjs (verbatim copies from ../checkmarch-map),
// audio.mjs (../checkmarch-music, the music expansion), fx.mjs (../checkmarch-fx), rival.mjs (../checkmarch-rival),
// forge.mjs (../checkmarch-forge), terrain.mjs (../checkmarch-terrain), content.mjs (../checkmarch-content),
// skills.mjs (../checkmarch-skills), discovery.mjs (../checkmarch-discovery), tutorial.mjs (../checkmarch-tutorial:
// the coach marks, verbatim), fairy.mjs (../checkmarch-fairy: fairy pieces, verbatim, namespaced FY), world.mjs (map <-> game glue).
// content.mjs exports a few names that clash with engine/forge (UNITS, DOCTRINES, RESOURCES), so it is inlined
// inside a function scope and exposed as one namespace object, CONTENT (world.mjs does `import * as CONTENT`).
// skills.mjs and discovery.mjs are namespaced the same way (SK, DSC). A namespaced module's named imports from
// another namespaced module become a destructuring line at the top of its scope (discovery imports content);
// named imports from flat modules (map.mjs) resolve to the inlined globals.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
// Size pass: acorn (from /opt/node-tools when not installed here) drives minJs below; without it the build still
// works and the UI script just stays line-compacted.
let acorn = null;
for (const base of [import.meta.url, 'file:///opt/node-tools/']) { try { acorn = createRequire(base)('acorn'); break; } catch (e) { /* not here */ } }
// P1 pass (size): the inlined modules drop their full-line // comments (v6: also trailing // comments and the leading
// indentation of code lines) (the .mjs files stay byte-identical; the tests
// check game.html against slimJs(module)). A small JS scanner finds real comments only: strings, template literals
// (with nested ${...}) and regex literals are skipped, so a "//" inside them is never touched. Code, indentation and
// trailing comments stay as they are.
const KW_BEFORE_RE = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
export function slimJs(src) {
  const drop = []; // [start, end) ranges of whole comment lines
  let i = 0, n = src.length, prev = '', word = '';
  const stack = []; // template-literal brace depths
  const lineStart = k => { let j = k - 1; while (j >= 0 && (src[j] === ' ' || src[j] === '\t')) j--; return j < 0 || src[j] === '\n' ? j + 1 : -1; };
  const skipQuote = q => { i++; while (i < n && src[i] !== q) { if (src[i] === '\\') i++; else if (src[i] === '\n') throw new Error('slimJs: newline in string'); i++; } i++; };
  const skipTemplate = () => { // at a backtick or a closing } of ${...}: scan the literal text
    i++;
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { i++; return false; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; stack.push(0); return true; }
      i++;
    }
    throw new Error('slimJs: open template');
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const ls = lineStart(i); let e = src.indexOf('\n', i); if (e < 0) e = n; else e++;
      if (ls >= 0 && !stack.length) drop.push([ls, e]);
      else if (!stack.length) { let a = i; while (a > 0 && (src[a - 1] === ' ' || src[a - 1] === '\t')) a--; drop.push([a, src[e - 1] === '\n' ? e - 1 : e]); } // v6: trailing comments too
      i = src[e - 1] === '\n' && ls < 0 ? e - 1 : e; continue;
    }
    // v6 (size): leading indentation of code lines goes too (template literal text is skipped above, so its
    // whitespace is never touched; strings and regexes cannot span lines)
    if (c === '\n' && !stack.length) { let j = i + 1; while (j < n && (src[j] === ' ' || src[j] === '\t')) j++; if (j > i + 1) drop.push([i + 1, j]); }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) throw new Error('slimJs: open comment'); i = e + 2; continue; }
    if (c === '"' || c === "'") { skipQuote(c); prev = 'a'; word = ''; continue; }
    if (c === '`') { skipTemplate(); prev = 'a'; word = ''; continue; }
    if (c === '/') {
      const re = prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || KW_BEFORE_RE.has(word);
      if (re) {
        i++; let cls = false;
        while (i < n) { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '\n') throw new Error('slimJs: newline in regex'); if (cls) { if (d === ']') cls = false; } else if (d === '[') cls = true; else if (d === '/') break; i++; }
        i++; while (i < n && /[a-z]/i.test(src[i])) i++;
        prev = 'a'; word = ''; continue;
      }
      prev = '/'; word = ''; i++; continue;
    }
    if (stack.length && c === '{') { stack[stack.length - 1]++; prev = c; word = ''; i++; continue; }
    if (stack.length && c === '}') {
      if (stack[stack.length - 1] === 0) { stack.pop(); i--; const more = skipTemplate(); if (!more) { prev = 'a'; word = ''; } else { prev = '{'; word = ''; } continue; }
      stack[stack.length - 1]--; prev = c; word = ''; i++; continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) { let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++; word = src.slice(i, j); prev = 'a'; i = j; continue; }
    if (!/\s/.test(c)) { prev = c; word = ''; }
    i++;
  }
  if (stack.length) throw new Error('slimJs: unbalanced template');
  let out = '', at = 0;
  drop.sort((x, y) => x[0] - y[0]);
  for (const [a, b] of drop) { if (a < at) { at = Math.max(at, b); continue; } out += src.slice(at, a); at = b; }
  return out + src.slice(at);
}
const dir = new URL('.', import.meta.url);
const read = f => readFileSync(new URL(f, dir), 'utf8');
// same transform as checkmarch-map/build-demo.mjs moduleToScript()
const toScript = src => src.replace(/^import\s[^;]*;\s*$/gm, '').replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '');
export const MODULES = ['engine.mjs', 'map.mjs', 'map-render.mjs', 'audio.mjs', 'fx.mjs', 'rival.mjs', 'forge.mjs', 'terrain.mjs', 'content.mjs', 'skills.mjs', 'discovery.mjs', 'tutorial.mjs', 'fairy.mjs', 'world.mjs'];
export const NAMESPACED = { 'content.mjs': 'CONTENT', 'skills.mjs': 'SK', 'discovery.mjs': 'DSC', 'fairy.mjs': 'FY' };
// `import { a, b } from './x.mjs'` where x.mjs is namespaced -> `const { a, b } = NS;`
const nsImports = src => [...src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+)';\s*$/gm)].filter(m => NAMESPACED[m[2]]).map(m => `const {${m[1]}} = ${NAMESPACED[m[2]]};\n`).join('');
const exportNames = src => [...src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
export function moduleScripts() {
  return MODULES.map(f => {
    const src = slimJs(read(f));
    if (f === 'engine.mjs') return [f, src.replace(/^export /gm, '')];
    if (NAMESPACED[f]) return [f, `const ${NAMESPACED[f]} = (() => {\n${nsImports(src)}${toScript(src)}\nreturn { ${exportNames(src).join(', ')} };\n})();\n`, [NAMESPACED[f]]];
    return [f, toScript(src)];
  });
}
// the page template (CSS, markup, UI script) is lightly compacted: leading indentation, full-line // comments and CSS
// /* comments */ go. The inlined modules stay verbatim (the tests check that game.html contains them).
// The <style> block also loses the spaces around { } ; and after : and , (values and media queries only: no
// selector in the page has a space after a colon or comma that matters).
const minCss = css => css.replace(/;\s*}/g, '}').replace(/\s*([{};])\s*/g, '$1').replace(/:\s+/g, ':').replace(/,\s+/g, ',');
const compact = t => t.replace(/\/\*(?!ENGINE\*\/)[\s\S]*?\*\//g, '').replace(/^[ \t]+/gm, '').replace(/^\/\/.*\n/gm, '').replace(/\n{2,}/g, '\n')
  .replace(/<style>([\s\S]*?)<\/style>/, (m, css) => `<style>${minCss(css)}</style>`);
// Size pass: token-level whitespace minifier for the page's own UI script (never the inlined modules: the tests
// check game.html contains slimJs(module) verbatim, so `keep` = the module block's [start, end) stays byte-exact).
// acorn's parser supplies the tokens (so regex vs divide, template literals and ${...} nesting are exact); every
// token's text is copied verbatim and only the whitespace/comment gaps between tokens change: a gap becomes
// nothing, one space where two tokens would otherwise fuse (a b, + +, - -, / /, regex flags, 1 .x, < !, - >, ? .),
// or a newline (kept wherever ASI may depend on it: only dropped after ; , ( [ { and binary/assign operators or
// before } ) ] , ;). No renaming, no reordering. The caller checks the result parses to the identical AST.
const ID_CH = new RegExp('[A-Za-z0-9_$\\\\' + String.fromCharCode(0x80) + '-' + String.fromCharCode(0xffff) + ']');
const LINE_T = new RegExp('[' + String.fromCharCode(10, 13, 0x2028, 0x2029) + ']');
const NL_DROP_AFTER = new Set([';', ',', '(', '[', '{', '=', '+=', '-=', '*=', '/=', '%=', '&&', '||', '??', '?', ':', '=>', '.', '?.', '&&=', '||=', '??=']);
const NL_DROP_BEFORE = new Set(['}', ')', ']', ',', ';']);
export function minJs(src, keep = [0, 0]) {
  const toks = [];
  acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', onToken: toks });
  const free = t => t.end <= keep[0] || t.start >= keep[1];
  let out = '', prev = null;
  for (const t of toks) {
    if (t.type === acorn.tokTypes.eof) { if (prev) out += src.slice(prev.end); break; }
    const text = src.slice(t.start, t.end);
    if (prev && t.start > prev.end && free(prev) && free(t)) {
      const gap = src.slice(prev.end, t.start), p = src.slice(prev.start, prev.end);
      const pv = prev.type === acorn.tokTypes.regexp ? 'a' : p[p.length - 1], nx = text[0];
      if (LINE_T.test(gap) && !NL_DROP_AFTER.has(p) && !NL_DROP_BEFORE.has(text)) out += '\n';
      else if ((ID_CH.test(pv) && (ID_CH.test(nx) || nx === '#')) || (prev.type === acorn.tokTypes.num && nx === '.')
        || (t.type === acorn.tokTypes.num && nx === '.' && (ID_CH.test(pv) || pv === '.' || pv === '?'))
        || (pv === '+' && nx === '+') || (pv === '-' && nx === '-') || (pv === '/' && (nx === '/' || nx === '*'))
        || (pv === '<' && nx === '!') || (pv === '-' && nx === '>') || (pv === '?' && nx === '.')) out += ' ';
    } else if (prev) out += src.slice(prev.end, t.start);
    else out += src.slice(0, t.start);
    out += text; prev = t;
  }
  return out;
}
const astOf = src => JSON.stringify(acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' }), (k, v) => k === 'start' || k === 'end' ? undefined : v);
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) build();
function build() {
const src = read('game.src.html');
if (!src.includes('/*ENGINE*/')) throw new Error('marker missing');
const parts = moduleScripts().concat([['game.src.html (UI)', src.split('/*ENGINE*/')[1].split('</script>')[0]]]);
// top-level declaration clash check (duplicate `function` names would silently override each other)
const seen = new Map();
for (const [f, code, only] of parts) {
  // names come from the unslimmed source (slimmed code has no indentation, so nested declarations would look top-level)
  const scan = f.endsWith('.mjs') ? toScript(read(f)) : code;
  const names = only || [...scan.matchAll(/^(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|class)\s+([A-Za-z_$][\w$]*))/gm)].map(m => m[1] || m[2]);
  for (const n of names) {
    if (seen.has(n)) throw new Error(`top-level name clash: ${n} in ${seen.get(n)} and ${f}`);
    seen.set(n, f);
  }
  if (/^export\s/m.test(code) || /^import\s/m.test(code)) throw new Error(`${f}: leftover import/export`);
  if (code.includes('</script')) throw new Error(`${f} contains </script`);
}
const code = parts.slice(0, -1).map(([f, c]) => `// ==== inlined from ${f} ====\n${c}`).join('\n');
const html0 = compact(src).replace('/*ENGINE*/', () => code);
// Size pass: minJs the inline script outside the module block, guarded: the result must parse to exactly the same
// AST (positions aside) as the line-compacted script and still hold the module block byte-for-byte; otherwise the
// unminified script ships and the build says so.
let html = html0;
if (acorn) {
  const a = html0.indexOf('<script>') + 8, b = html0.lastIndexOf('</script>'), js = html0.slice(a, b), k = js.indexOf(code);
  let mini = null;
  try { mini = minJs(js, [k, k + code.length]); } catch (e) { console.log(`WARNING minJs failed (${e.message}); UI script left unminified`); }
  if (mini && (k < 0 || !mini.includes(code) || astOf(mini) !== astOf(js))) { console.log('WARNING minJs changed the program; UI script left unminified'); mini = null; }
  if (mini) { html = html0.slice(0, a) + mini + html0.slice(b); console.log(`minJs UI script: ${((Buffer.byteLength(js) - Buffer.byteLength(mini)) / 1024).toFixed(1)} KB saved, AST identical`); }
} else console.log('info acorn not found; UI script left unminified');
if (html.split('</script').length !== 2 || html.split('<script').length !== 2) throw new Error('script tag count changed');
writeFileSync(new URL('game.html', dir), html);
const m = html.match(/<script>([\s\S]*)<\/script>/);
const tmp = new URL('.inline-check.js', dir);
writeFileSync(tmp, m[1]);
try { execFileSync(process.execPath, ['--check', tmp.pathname], { stdio: 'inherit' }); console.log('node --check inline script: OK'); }
finally { unlinkSync(tmp); }
console.log(`game.html written (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
}
