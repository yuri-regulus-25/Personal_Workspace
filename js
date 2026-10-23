#!/usr/bin/env node
'use strict';

// Vue 2 preservation migration: graph-scoped, fail-closed, no dependencies added.
// Node.js >= 18. @babel/parser and @vue/compiler-sfc must exist in project node_modules.
const fs = require('node:fs');
const path = require('node:path');
const posix = path.posix;
const cp = require('node:child_process');
const { createRequire } = require('node:module');

const args = process.argv.slice(2);
let mode = 'dry-run', planFile = path.join(__dirname, 'vue2-preserve-plan.json'), repoArg = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') mode = 'dry-run';
  else if (args[i] === '--apply') mode = 'apply';
  else if (args[i] === '--plan' && args[i+1]) planFile = path.resolve(args[++i]);
  else if (args[i] === '--repo' && args[i+1]) repoArg = path.resolve(args[++i]);
  else throw new Error('Usage: node vue2-preserve.cjs [--dry-run|--apply] [--repo PATH] [--plan FILE]');
}

function git(cwd, argv) {
  const p = cp.spawnSync('git', argv, { cwd, encoding:'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (p.error || p.status !== 0) throw new Error('git '+ argv.join(' ') + ': '+(p.stderr || p.error || 'exit '+p.status));
  return p.stdout.trim();
}
const root = path.resolve(git(repoArg, ['rev-parse','--show-toplevel']));
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
if (plan.plan_version !== 1) throw new Error('Unsupported manifest plan_version');

const reportDir = path.resolve(root, git(root, ['rev-parse','--git-path','vue2-preserve-reports']));
const report = {
  mode, root, source_report: plan.source, plan_counts: plan.counts,
  copy_count: 0, rewrite_file_count: 0, rewrite_reference_count: 0,
  findings: [], manual_review: plan.other_resources_not_auto_copied.map(file => ({kind:'out_of_scope_resource', file, detail:'CSS/JSON: copy/rewrite policy not specified'})),
  files_to_copy: [], files_to_rewrite: [],
};
const findings = report.findings;
function issue(kind, file, detail) { findings.push({kind,file,detail:String(detail)}); }
function safePath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.startsWith('/') || !rel.startsWith('work/')) {
    throw new Error('Refusing invalid manifest source: '+String(rel));
  }
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new Error('Path escape: '+rel);
  // Refuse symlink traversal (including parent directories), even for destination paths.
  const parent = fs.realpathSync(path.dirname(abs));
  const realRoot = fs.realpathSync(root);
  if (!parent.startsWith(realRoot + path.sep)) throw new Error('Symlink path escape: '+rel);
  return abs;
}
function toV2(rel) {
  const e = posix.extname(rel);
  if (!['.js','.vue'].includes(e.toLowerCase())) throw new Error('Not a JS/Vue source: '+rel);
  return rel.slice(0,-e.length)+'_v2'+e;
}
function existsFile(rel) {
  try {
    const p = safePath(rel), stat = fs.lstatSync(p);
    if (!stat.isFile() || stat.isSymbolicLink()) { issue('not_regular_file',rel,'Symbolic link or not a regular file'); return false; }
    return true;
  } catch(e) { issue('missing_source',rel,e.code || e.message); return false; }
}
function moduleResolverFromProject() {
  const bases = ['workspace/npm/package.json','package.json','work/package.json'];
  for (const candidate of bases) {
    if (!fs.existsSync(path.join(root,candidate))) continue;
    const req = createRequire(path.join(root,candidate));
    try {
      return { parser: req('@babel/parser'), sfc: req('@vue/compiler-sfc'), base: candidate };
    } catch (e) { /* try next package root */ }
  }
  return null;
}
const dep = moduleResolverFromProject();
if (!dep) issue('missing_parser_dependencies','[project]', 'Need @babel/parser and @vue/compiler-sfc in project node_modules; install/resolve them before running. No automatic npm install.');

const sourceFiles = Array.from(new Set([...plan.copy_sources, ...plan.v2_entries])).sort();
const copySet = new Set(plan.copy_sources);
const v2Roots = new Set(plan.v2_entries);
const v3Roots = new Set(plan.v3_entries);
for (const rel of sourceFiles) {
  existsFile(rel);
  if (v3Roots.has(rel)) issue('v3_entry_in_write_scope',rel,'Vue 3 entry cannot be modified');
}
const destinationSet = new Set();
for (const source of plan.copy_sources) {
  const dest = toV2(source);
  if (destinationSet.has(dest)) issue('duplicate_destination',dest,'Manifest collision');
  destinationSet.add(dest);
  if (fs.existsSync(safePath(dest))) issue('destination_already_exists',dest,'Refusing to overwrite preexisting _v2 file (file or directory)');
}

// Require source files unchanged from HEAD. Unrelated webpack.mix.js differences are allowed.
try {
  const result = cp.spawnSync('git', ['status','--porcelain','--untracked-files=all','--',...sourceFiles], { cwd:root, encoding:'utf8', maxBuffer:16*1024*1024 });
  if (result.error || result.status !== 0) issue('git_status_failed','[repo]',result.stderr || result.error || result.status);
  else if (result.stdout.trim()) for (const line of result.stdout.trimEnd().split('\n')) issue('dirty_source','[git]',line);
} catch(e) { issue('git_status_failed','[repo]',e.message); }

// Deduplicate the graph edges shared by multiple entry graphs.
const edgesByImporter = new Map();
const seen = new Set();
for (const e of plan.v2_rewrites) {
  if (!copySet.has(e.target)) { issue('invalid_target',e.importer,e.target); continue; }
  if (!v2Roots.has(e.importer) && !copySet.has(e.importer)) { issue('invalid_importer',e.importer,'Outside v2 root/copy set'); continue; }
  const key = [e.importer,e.target,e.line,e.column].join('\0');
  if (seen.has(key)) continue;
  seen.add(key);
  if (!edgesByImporter.has(e.importer)) edgesByImporter.set(e.importer, []);
  edgesByImporter.get(e.importer).push({...e, matched: false});
}

function lineAt(text, offset) {
  let n = 1;
  for (let i=0;i<offset;i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
function staticLiteral(node) {
  return node && (node.type === 'StringLiteral' || (node.type === 'Literal' && typeof node.value==='string'));
}
function collectFromAst(ast, shift, source, rel) {
  const refs = [];
  const visited = new Set();
  const stack = [ast];
  function add(ref, stmt) {
    if (staticLiteral(ref)) refs.push({value: ref.value, start:shift+ref.start, end:shift+ref.end, line:lineAt(source,shift+stmt.start)});
    else issue('dynamic_import',rel,'Nonliteral import at line '+lineAt(source,shift+stmt.start));
  }
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object' || visited.has(n)) continue;
    visited.add(n);
    if (['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(n.type) && n.source) add(n.source,n);
    if ((n.type==='CallExpression' || n.type==='OptionalCallExpression') && n.callee) {
      if (n.callee.type === 'Identifier' && n.callee.name==='require') {
        if (n.arguments.length === 1) add(n.arguments[0],n);
        else issue('dynamic_require',rel,'Nonstandard require() at line '+lineAt(source,shift+n.start));
      } else if (n.callee.type==='Import') add(n.arguments[0],n);
      else if (n.callee.type==='MemberExpression' && n.callee.object && n.callee.object.name==='require' && n.callee.property && ['context','resolve'].includes(n.callee.property.name)) {
        issue('dynamic_require_api',rel,'require.'+n.callee.property.name+' at line '+lineAt(source,shift+n.start)+' needs manual review');
      }
    }
    if (n.type==='ImportExpression') add(n.source,n);
    for (const [k,v] of Object.entries(n)) {
      if (['loc','comments','tokens','errors','extra','leadingComments','trailingComments','innerComments'].includes(k)) continue;
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c === 'object' && c.type) stack.push(c);
      } else if (v && typeof v === 'object' && v.type) {
        stack.push(v);
      }
    }
  }
  return refs;
}
// Fallback for Vue 2 templates that @vue/compiler-sfc (Vue 3 parser) rejects.
// Preserve the *exact* character offsets, but hide all non-script markup from
// compiler-sfc. It will parse only the SFC script blocks; template syntax is
// irrelevant when rewriting static import specifiers.
function parseScriptOnlySfc(rel, source, originalError) {
  const opening = /<script\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  const closing = /<\/script\s*>/gi;
  const spans = [];
  let m;
  while ((m = opening.exec(source)) !== null) {
    closing.lastIndex = opening.lastIndex;
    const end = closing.exec(source);
    if (!end) throw new Error('Script-only fallback: missing </script> after offset '+m.index+'; original: '+originalError.message);
    spans.push({start:m.index,end:closing.lastIndex});
    opening.lastIndex = closing.lastIndex;
  }
  if (!spans.length) throw new Error('Script-only fallback: no script blocks found; original: '+originalError.message);
  if (spans.length > 2) throw new Error('Script-only fallback: ambiguous multiple <script> blocks ('+spans.length+'); original: '+originalError.message);

  // Build a syntactically benign SFC of equal UTF-16 length, including line breaks.
  const masked = Array.from({length:source.length},(_,i) => {
    const c=source[i]; return c==='\n'||c==='\r' ? c : ' ';
  });
  for (const span of spans) for(let i=span.start;i<span.end;i++) masked[i]=source[i];
  const parsed = dep.sfc.parse(masked.join(''), {filename:rel});
  if (parsed.errors && parsed.errors.length) throw new Error('Script-only fallback parse errors: '+parsed.errors.map(x=>x.message || String(x)).join('; '));
  const blocks = [parsed.descriptor.script, parsed.descriptor.scriptSetup].filter(Boolean);
  if (blocks.length !== spans.length) throw new Error('Script-only fallback: detected '+spans.length+' script spans but parsed '+blocks.length);
  for (const b of blocks) {
    const off=b.loc.start.offset;
    if (source.slice(off,off+b.content.length)!==b.content)
      throw new Error('Script-only fallback: source offset/content verification failed');
  }
  report.manual_review.push({kind:'vue2_template_parser_fallback',file:rel,
    detail:'Vue 3 SFC parser rejected template; script-only parser succeeded. Template was not rewritten. Original error: '+originalError.message});
  return parsed;
}
function scanSource(rel, source) {
  const parts=[];
  if (rel.endsWith('.vue')) {
    let parsed;
    try {
      parsed = dep.sfc.parse(source, {filename:rel});
      // Some compiler versions return errors rather than throwing.
      if (parsed.errors && parsed.errors.length) {
        throw new Error('SFC parsing issues: '+parsed.errors.map(x=>x.message || String(x)).join('; '));
      }
    } catch(e) {
      parsed = parseScriptOnlySfc(rel, source, e);
    }
    const desc = parsed.descriptor;
    for (const part of [desc.script,desc.scriptSetup].filter(Boolean)) {
      if (part.src) issue('external_sfc_script',rel,'<script src="'+part.src+'"> is not automatically rewritten');
      if (part.lang && !['js','jsx','ts','tsx'].includes(part.lang)) issue('unknown_sfc_language',rel,'<script lang='+part.lang+'>');
      parts.push({text:part.content, offset:part.loc.start.offset, ts: ['ts','tsx'].includes(part.lang)});
    }
    const templateMatch = source.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
    if (templateMatch && /\brequire\s*\(/i.test(templateMatch[1]))
      report.manual_review.push({kind:'vue_template_require',file:rel,detail:'Potential require() inside Vue template; graph coverage not guaranteed'});
  } else parts.push({text:source,offset:0,ts:false});
  const refs=[];
  for (const part of parts) {
    const plugins = ['jsx','decorators-legacy','dynamicImport','importMeta','topLevelAwait'];
    if (part.ts) plugins.push('typescript');
    const ast = dep.parser.parse(part.text,{sourceType:'unambiguous',plugins,allowReturnOutsideFunction:true});
    refs.push(...collectFromAst(ast,part.offset,source,rel));
  }
  return refs;
}
function compatible(spec, target) {
  const raw=spec.split('?')[0].split('#')[0];
  if (raw.includes('!') || raw.startsWith('data:')) return false;
  const last=posix.basename(raw.replace(/\/$/,''));
  const base=posix.basename(target);
  const stem=base.replace(/\.(vue|js)$/i,'');
  const specStem=last.replace(/\.(vue|js)$/i,'');
  if (last === base || specStem === stem) return true;
  if (base === 'index.js' && last === posix.basename(posix.dirname(target))) return true;
  return false;
}
function quoteLike(inputLiteral, value) {
  const first = inputLiteral[0];
  const delimiter = first === "'" ? "'" : '"';
  // Escape as a standard JS string while preserving the existing quote style.
  return delimiter + value.replace(/\\/g,'\\\\').replace(/\r/g,'\\r').replace(/\n/g,'\\n').replace(/\t/g,'\\t').replace(new RegExp(delimiter==='"'?'"':"'",'g'),'\\'+delimiter) + delimiter;
}
function rewrite(rel, source) {
  const edges=edgesByImporter.get(rel)||[];
  // Scan all preserved sources, including those with zero graph rewrite edges,
  // so unknown dynamic dependencies cannot silently escape preflight.
  const refs=scanSource(rel,source);
  if (edges.length===0) return {content:source,count:0};
  const changes=[];
  for (const ref of refs) {
    const candidates=edges.filter(e => !e.matched && e.line===ref.line && compatible(ref.value,e.target));
    if (candidates.length>1) {
      issue('ambiguous_import',rel,'Line '+ref.line+' '+ref.value+' matches '+candidates.map(x=>x.target).join(', '));
      continue;
    }
    if (candidates.length!==1) continue;
    const edge=candidates[0];edge.matched=true;
    const tailMatch=ref.value.match(/([?#].*)$/);
    const tail=tailMatch ? tailMatch[1] : '';
    let output=posix.relative(posix.dirname(rel),toV2(edge.target));
    if (!output.startsWith('.')) output='./'+output;
    output+=tail;
    changes.push({start:ref.start,end:ref.end,text:quoteLike(source.slice(ref.start,ref.end),output),before:ref.value,after:output});
  }
  for (const edge of edges) if (!edge.matched) issue('unmatched_graph_reference',rel,'Line '+edge.line+' imported '+edge.target+' but no matching static import/require was found');
  const ordered=changes.sort((a,b)=>b.start-a.start);
  let result=source;
  for (const c of ordered) result=result.slice(0,c.start)+c.text+result.slice(c.end);
  return {content:result,count:changes.length,changes};
}

const outputByOriginal=new Map();
if (dep && !findings.some(f=>['missing_source','not_regular_file','v3_entry_in_write_scope'].includes(f.kind))) {
  for (const rel of sourceFiles) {
    try {
      const source=fs.readFileSync(safePath(rel),'utf8');
      const result=rewrite(rel,source);
      outputByOriginal.set(rel,{original:source,content:result.content,count:result.count});
    } catch(e) { issue('parse_or_rewrite_error',rel,e.stack || e.message); }
  }
}

report.files_to_copy=plan.copy_sources.map(src=>({source:src,destination:toV2(src),reference_rewrites:outputByOriginal.get(src)?.count ?? null}));
report.files_to_rewrite=plan.v2_entries.filter(x=>outputByOriginal.get(x)?.count).map(x=>({file:x,reference_rewrites:outputByOriginal.get(x).count}));
report.copy_count=plan.copy_sources.length;
report.rewrite_file_count=[...outputByOriginal.values()].filter(x=>x.count).length;
report.rewrite_reference_count=[...outputByOriginal.values()].reduce((n,x)=>n+x.count,0);

function writeReport() {
  fs.mkdirSync(reportDir,{recursive:true});
  const prefix='vue2-preserve-'+mode;
  const jsonFile=path.join(reportDir,prefix+'.json');
  const txtFile=path.join(reportDir,prefix+'-issues.txt');
  fs.writeFileSync(jsonFile,JSON.stringify(report,null,2)+'\n');
  fs.writeFileSync(txtFile,
    'Mode: '+mode+'\nPlan: '+plan.source+'\nV2 entrypoints: '+plan.v2_entries.length+'\nCopy files: '+report.copy_count+'\nRewritten static references: '+report.rewrite_reference_count+'\n'+
    '\nFINDINGS ('+findings.length+'):\n'+findings.map(x=>'- ['+x.kind+'] '+x.file+': '+x.detail).join('\n')+
    '\n\nMANUAL REVIEW ('+report.manual_review.length+'):\n'+report.manual_review.map(x=>'- ['+x.kind+'] '+x.file+': '+x.detail).join('\n')+'\n');
  console.log('Report: '+jsonFile+'\nIssues: '+txtFile);
}
writeReport();
console.log('V2 entries:',plan.v2_entries.length,'| _v2 copies:',report.copy_count,'| planned ref rewrites:',report.rewrite_reference_count);
if (report.manual_review.length) console.log('Manual review:',report.manual_review.length,'(CSS/JSON etc.; see report)');
if (findings.length) {
  console.error('STOP: '+findings.length+' blocker(s). No code files written.');
  for (const i of findings.slice(0,12)) console.error(' - ['+i.kind+'] '+i.file+': '+i.detail.slice(0,190));
  process.exit(2);
}
if (mode==='dry-run') { console.log('DRY-RUN PASSED. Re-run with --apply to write files.'); process.exit(0); }

// Apply: create _v2 copies, then rewrite only the 19 original Vue2 entrypoints.
// Undo best-effort on filesystem errors, and never touch Vue3 entry files.
const created=[];
const changedRoots=[];
// Keep durable copies of entrypoint originals inside Git metadata before any writes.
const backupDir = path.join(reportDir, 'entry-backup-' + Date.now() + '-' + process.pid);
try {
  for (const src of plan.v2_entries) {
    const state = outputByOriginal.get(src);
    if (!state || !state.count) continue;
    const backupFile = path.join(backupDir, src);
    fs.mkdirSync(path.dirname(backupFile), {recursive:true});
    fs.writeFileSync(backupFile,state.original,{flag:'wx',mode:0o600});
  }
  console.log('Vue 2 entrypoint backups:',backupDir);
  for (const src of plan.copy_sources) {
    const dest=toV2(src), abs=safePath(dest);
    const state=outputByOriginal.get(src);
    fs.writeFileSync(abs,state.content,{flag:'wx',mode:fs.statSync(safePath(src)).mode & 0o777});
    created.push(abs);
  }
  for (const src of plan.v2_entries) {
    const state=outputByOriginal.get(src);
    if (!state || state.count===0) continue;
    const abs=safePath(src), st=fs.statSync(abs), temp=abs+'.vue2-preserve-tmp-'+process.pid;
    fs.writeFileSync(temp,state.content,{flag:'wx',mode:st.mode & 0o777});
    try { fs.renameSync(temp,abs); } catch(e) { try {fs.unlinkSync(temp);}catch {} throw e; }
    changedRoots.push({abs,original:state.original,mode:st.mode & 0o777});
  }
  console.log('APPLY OK: created '+created.length+' _v2 files; changed '+changedRoots.length+' Vue2 entrypoints.');
  console.log('Next: review git diff, verify copy paths and build; commit this checkpoint BEFORE running Vue3 codemods.');
} catch(e) {
  console.error('APPLY FAILED, attempting targeted rollback:',e.message);
  for (const x of changedRoots.reverse()) try {fs.writeFileSync(x.abs,x.original,{mode:x.mode});}catch(err){console.error('ROLLBACK ROOT FAILED:',x.abs,err.message);}
  for (const x of created.reverse()) try {fs.unlinkSync(x);}catch(err){console.error('ROLLBACK COPY FAILED:',x,err.message);}
  process.exit(3);
}
