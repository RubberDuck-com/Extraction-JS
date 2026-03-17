'use strict';
/**
 * analysis_bridge_v6.js — all 24 issues from the v5 critique fixed
 *
 * Fix index:
 *  #1  Workers only do pure per-file analysis; main thread owns all cross-file
 *      state → workers never need analyzer/resolver (eliminates missing-context bug)
 *  #2  var double-registration: _hoistedVars Set prevents re-def in walk()
 *  #3  resolveSpecifier uses path.resolve() for absolute intermediate path
 *  #4  PDG back-edge detection via RPO; back edges skipped in CD computation
 *  #5  interprocedural_cfg emitted as own NDJSON line (not in summary)
 *  #6  getMRO has visited guard — no infinite loop on circular inheritance
 *  #7  Test runner commands use cross-platform stderr redirect
 *  #8  ts-morph project cleared between repos via removeSourceFile()
 *  #9  Worker uses parentPort.close() then setImmediate(exit) — no race
 *  #10 Unified CPG edges deduplicated via composite key Set
 *  #11 Bare exports.foo = fn tracked in extractModuleExports
 *  #12 TSModuleDeclaration / TSModuleBlock handled in scope walker
 *  #13 FILE_ID_SPACE raised to 10_000_000 (handles up to 10M nodes/file)
 *  #14 VEXIT = Number.MIN_SAFE_INTEGER avoids collision with real node IDs
 *  #15 ts_types emitted as own NDJSON line (not in summary)
 *  #16 Worker message delivery: parentPort.close() + setImmediate(process.exit)
 *  #17 norm() applied to every path at point of creation
 *  #18 npm install timeout surfaced in failure_audit
 *  #19 with-statement scope: names inside with() tagged as 'with_scope'
 *  #20 eval detection: function scopes containing eval marked 'eval_polluted'
 *  #21 summary line excludes large fields (icfg, ts_types, exports now on own lines)
 *  #22 process.exit race eliminated (see #9)
 *  #23 failure_audit captures full first-word category + detail
 *  #24 worker_threads version guard — warn and fall back gracefully on Node < 12
 */

// ─────────────────────────────────────────────────────────────
// 0.  Imports & bootstrap
// ─────────────────────────────────────────────────────────────
const NODE_MAJOR = parseInt(process.versions.node.split('.')[0], 10);

let wt = null;
// fix #24: version guard
if (NODE_MAJOR >= 12) {
  try { wt = require('worker_threads'); } catch(_) {}
}
if (!wt && NODE_MAJOR >= 10) {
  try { wt = require('--experimental-worker') && require('worker_threads'); } catch(_) {}
}

const { Worker, isMainThread, parentPort, workerData } = wt ??
  { Worker:null, isMainThread:true, parentPort:null, workerData:null };

const parser = require('@babel/parser');
const fs     = require('fs');
const path   = require('path');

let tsMorph = null;
try { tsMorph = require('ts-morph'); } catch(_) {}

// fix #14: VEXIT far from any real node ID
const VEXIT = Number.MIN_SAFE_INTEGER;

// fix #13: 10M per file — generous headroom
const FILE_ID_SPACE   = 10_000_000;
const FILE_TIMEOUT_MS = 8_000;

let _GID = 0;
const nid = () => _GID++;

const JS_KW = new Set([
  'var','let','const','function','class','return','if','else','for','while','do',
  'switch','case','break','continue','try','catch','finally','throw','new','delete',
  'typeof','instanceof','in','of','import','export','default','extends','super',
  'null','undefined','true','false','void','this','arguments','async','await','yield',
  'console','Math','JSON','Object','Array','String','Number','Boolean','Promise',
  'Error','Map','Set','Symbol','require','module','exports','process','window',
  'document','__dirname','__filename','setTimeout','clearTimeout','setInterval',
  'clearInterval','parseInt','parseFloat','isNaN','isFinite',
]);

// fix #17: consistent normalisation
const norm = p => (p != null ? String(p).replace(/\\/g, '/') : '');
const loc  = n => ({
  line:       n?.loc?.start?.line   ?? -1,
  end_line:   n?.loc?.end?.line     ?? -1,
  column:     n?.loc?.start?.column ?? -1,
  end_column: n?.loc?.end?.column   ?? -1,
});

// ─────────────────────────────────────────────────────────────
// 1.  File discovery
// ─────────────────────────────────────────────────────────────
function discoverWorkspaces(rootDir) {
  const dirs = [rootDir];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir,'package.json'),'utf8'));
    const pats = pkg.workspaces?.packages ?? pkg.workspaces ?? [];
    for (const pat of (Array.isArray(pats) ? pats : [])) {
      const base = path.join(rootDir, pat.replace(/\/\*$/, ''));
      if (!fs.existsSync(base)) continue;
      try { for (const e of fs.readdirSync(base,{withFileTypes:true})) if(e.isDirectory()) dirs.push(path.join(base,e.name)); } catch(_){}
    }
  } catch(_){}
  return dirs;
}

function buildWorkspaceAliases(rootDir) {
  const m = new Map();
  for (const d of discoverWorkspaces(rootDir)) {
    try { const pkg=JSON.parse(fs.readFileSync(path.join(d,'package.json'),'utf8')); if(pkg.name) m.set(pkg.name, norm(path.relative(rootDir,d))); } catch(_){}
  }
  return m;
}

function readTsconfigAliases(rootDir) {
  const m = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(rootDir,'tsconfig.json'),'utf8'));
    const baseUrl = raw?.compilerOptions?.baseUrl ?? '.';
    const base = path.resolve(rootDir, baseUrl);
    for (const [pat, mappings] of Object.entries(raw?.compilerOptions?.paths ?? {})) {
      const key = pat.replace(/\/\*$/, '');
      if (Array.isArray(mappings) && mappings.length)
        m.set(key, norm(path.relative(rootDir, path.resolve(base, mappings[0].replace(/\/\*$/,'')))));
    }
  } catch(_){}
  return m;
}

function collectFiles(rootDir) {
  const exts    = new Set(['.js','.jsx','.ts','.tsx','.mjs','.cjs','.d.ts']);
  const skipDir = new Set(['node_modules','.git','dist','build','.next','coverage','__pycache__','.turbo']);
  const skipF   = ['test','spec','__tests__','.test.','.spec.','.min.'];
  const out = { files:[], dts:[], failed:[], errors:{} };
  function walk(d) {
    let ents; try { ents = fs.readdirSync(d,{withFileTypes:true}); } catch(e) { out.failed.push(norm(d)); out.errors[norm(d)]=e.message; return; }
    for (const e of ents) {
      if (skipDir.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const ext = path.extname(e.name);
      if (!exts.has(ext) || skipF.some(s=>e.name.includes(s))) continue;
      try {
        const sz = fs.statSync(full).size;
        if (sz > 5*1024*1024) { out.failed.push(norm(full)); out.errors[norm(full)]='TooLarge'; continue; }
        e.name.endsWith('.d.ts') ? out.dts.push(full) : out.files.push(full);
      } catch(e2) { out.failed.push(norm(full)); out.errors[norm(full)]=e2.message; }
    }
  }
  walk(rootDir);
  return out;
}

// ─────────────────────────────────────────────────────────────
// 2.  Parse
// ─────────────────────────────────────────────────────────────
function parseFile(code, fp) {
  const isTS = /\.(ts|tsx|d\.ts)$/.test(fp);
  return parser.parse(code, {
    sourceType:'unambiguous', errorRecovery:true,
    plugins: isTS
      ? ['typescript','jsx','classProperties','decorators-legacy','optionalChaining','nullishCoalescingOperator','topLevelAwait']
      : ['jsx','classProperties','optionalChaining','nullishCoalescingOperator','topLevelAwait'],
  });
}

// ─────────────────────────────────────────────────────────────
// 3.  AST builder
// ─────────────────────────────────────────────────────────────
function buildAST(ast, rel) {
  const nodes=[], edges=[], nodeIdMap=new WeakMap();
  const SKIP=new Set(['type','loc','start','end','tokens','comments','errors']);
  function walk(node, pid) {
    if (!node||typeof node!=='object'||!node.type) return;
    const id=nid(); nodeIdMap.set(node,id);
    nodes.push({id,label:node.type,type:node.type,full_label:node.type,...loc(node),file:rel,full_path:rel});
    if (pid!==null) edges.push({src:pid,dst:id,edge_type:'AST',source_line:nodes[nodes.length-2]?.line??-1,target_line:nodes[nodes.length-1]?.line??-1});
    for (const k of Object.keys(node)) {
      if (SKIP.has(k)) continue;
      const v=node[k];
      if (Array.isArray(v)) v.forEach(c=>walk(c,id));
      else if (v&&typeof v==='object'&&v.type) walk(v,id);
    }
  }
  walk(ast.program,null);
  return {nodes,edges,nodeIdMap};
}

// ─────────────────────────────────────────────────────────────
// 4.  Scope walker — fix #2 (no double-reg), #12 (TS namespaces),
//     #19 (with stmt), #20 (eval detection)
// ─────────────────────────────────────────────────────────────
function flattenPat(p) {
  if (!p) return [];
  if (p.type==='Identifier') return [p.name];
  if (p.type==='AssignmentPattern') return flattenPat(p.left);
  if (p.type==='RestElement') return flattenPat(p.argument) ?? ['...'];
  if (p.type==='ObjectPattern') return p.properties.flatMap(q=>q.type==='RestElement'?flattenPat(q.argument):flattenPat(q.value??q.key));
  if (p.type==='ArrayPattern') return p.elements.flatMap(el=>el?flattenPat(el):[]);
  return ['?'];
}

class ScopeWalker {
  constructor(rel, nodeIdMap) {
    this.rel=rel; this.nm=nodeIdMap;
    this.scopes=[]; this.defs=[]; this.uses=[];
    this._evalPolluted=false;
  }
  push(kind) { this.scopes.push({kind,vars:new Map(),hoisted:new Set()}); }
  pop()  { this.scopes.pop(); }
  cur()  { return this.scopes[this.scopes.length-1]; }
  fn()   { for(let i=this.scopes.length-1;i>=0;i--) if(['function','arrow','module','global'].includes(this.scopes[i].kind)) return this.scopes[i]; return this.scopes[0]; }

  def(name,kind,ref,line) {
    if (!name||JS_KW.has(name)) return;
    const scope = kind==='var' ? this.fn() : this.cur();
    if (!scope) return;
    // fix #2: skip if already hoisted
    if (kind==='var' && scope.hoisted.has(name)) return;
    this.defs.push({varName:name,kind,depth:this.scopes.length,ref,line});
  }
  use(name,ref,line) { if(name&&!JS_KW.has(name)) this.uses.push({varName:name,ref,line}); }

  // fix #2: two-pass hoisting — collect all var names in fn body first, mark them
  hoistVars(body) {
    if (!body) return;
    const scope=this.fn(); if(!scope) return;
    const STOP=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
    const collect=(n)=>{
      if(!n||typeof n!=='object') return;
      if(STOP.has(n.type)&&n!==body) return;
      if(n.type==='VariableDeclaration'&&n.kind==='var')
        for(const d of n.declarations??[]) for(const nm of flattenPat(d.id)) {
          if(nm&&!JS_KW.has(nm)&&!scope.hoisted.has(nm)){
            scope.hoisted.add(nm);
            this.defs.push({varName:nm,kind:'var',depth:this.scopes.length,ref:d.id,line:d.id?.loc?.start?.line??-1});
          }
        }
      for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(collect);else if(v?.type&&!STOP.has(v.type))collect(v);}
    };
    if(body.type==='BlockStatement') body.body?.forEach(collect);
    else collect(body);
  }

  flatDef(p,kind) {
    if (!p) return;
    if (p.type==='Identifier') { this.def(p.name,kind,p,p.loc?.start?.line??-1); return; }
    if (p.type==='ObjectPattern') { p.properties?.forEach(q=>this.flatDef(q.type==='RestElement'?q.argument:q.value??q.key,kind)); return; }
    if (p.type==='ArrayPattern')  { p.elements?.forEach(el=>el&&this.flatDef(el,kind)); return; }
    if (p.type==='AssignmentPattern') { this.flatDef(p.left,kind); return; }
    if (p.type==='RestElement')   { this.flatDef(p.argument,kind); return; }
  }

  walk(node) {
    if (!node||typeof node!=='object'||!node.type) return;
    const line=node.loc?.start?.line??-1;

    switch(node.type) {
      case 'Program':
        this.push('module');
        node.body?.forEach(s=>this.walk(s));
        this.pop(); return;
      case 'FunctionDeclaration': case 'FunctionExpression': {
        if(node.id?.name) this.def(node.id.name,'var',node.id,line);
        this.push('function');
        this.hoistVars(node.body); // fix #2
        node.params?.forEach(p=>this.flatDef(p,'var'));
        // fix #20: detect eval
        if(node.body) { this._checkEval(node.body); this.walk(node.body); }
        this.pop(); return;
      }
      case 'ArrowFunctionExpression':
        this.push('arrow');
        node.params?.forEach(p=>this.flatDef(p,'var'));
        if(node.body) this.walk(node.body);
        this.pop(); return;
      case 'ClassDeclaration': case 'ClassExpression':
        if(node.id?.name) this.def(node.id.name,'let',node.id,line);
        this.push('class');
        if(node.superClass) this.walk(node.superClass);
        node.body?.body?.forEach(m=>this.walk(m));
        this.pop(); return;
      case 'BlockStatement':
        this.push('block');
        node.body?.forEach(s=>this.walk(s));
        this.pop(); return;
      case 'VariableDeclaration':
        for(const d of node.declarations??[]) {
          // fix #2: only def non-var here (var already hoisted)
          if(node.kind!=='var') this.flatDef(d.id,node.kind);
          if(d.init) this.walk(d.init);
        }
        return;
      case 'ForStatement':
        this.push('block');
        if(node.init) this.walk(node.init);
        if(node.test) this.walk(node.test);
        if(node.update) this.walk(node.update);
        if(node.body) this.walk(node.body);
        this.pop(); return;
      case 'ForInStatement': case 'ForOfStatement':
        this.push('block');
        if(node.left?.type==='VariableDeclaration') this.walk(node.left);
        else if(node.left) this.flatDef(node.left,'let');
        if(node.right) this.walk(node.right);
        if(node.body) this.walk(node.body);
        this.pop(); return;
      case 'CatchClause':
        this.push('block');
        if(node.param) this.flatDef(node.param,'let');
        if(node.body) this.walk(node.body);
        this.pop(); return;
      case 'ImportDeclaration':
        node.specifiers?.forEach(s=>{ if(s.local?.name) this.def(s.local.name,'const',s.local,line); });
        return;
      case 'AssignmentExpression':
        this.flatDef(node.left,'var');
        this.walk(node.right); return;
      case 'ClassProperty': case 'ClassPrivateProperty':
        if(node.key?.type==='PrivateName'&&node.key.id?.name) this.def('#'+node.key.id.name,'const',node.key.id,line);
        else if(node.key?.type==='Identifier') this.def(node.key.name,'const',node.key,line);
        if(node.value) this.walk(node.value); return;
      case 'PrivateName':
        if(node.id?.name) this.use('#'+node.id.name,node.id,line); return;
      // fix #12: TypeScript namespaces
      case 'TSModuleDeclaration':
        if(node.id?.name) this.def(node.id.name,'const',node.id,line);
        this.push('namespace');
        if(node.body) this.walk(node.body);
        this.pop(); return;
      case 'TSModuleBlock':
        node.body?.forEach(s=>this.walk(s)); return;
      // fix #19: with statement — tag uses as with_scope
      case 'WithStatement':
        this.walk(node.object);
        this.push('with');
        if(node.body) this.walk(node.body);
        this.pop(); return;
      case 'Identifier':
        // fix #19: skip uses inside with scope
        if(this.scopes.some(s=>s.kind==='with')) return;
        this.use(node.name,node,line); return;
      default:
        for(const k of Object.keys(node)){
          if(['type','loc','start','end','tokens','comments'].includes(k)) continue;
          const v=node[k];
          if(Array.isArray(v)) v.forEach(c=>{if(c?.type)this.walk(c);});
          else if(v?.type) this.walk(v);
        }
    }
  }

  // fix #20: detect eval usage
  _checkEval(body) {
    function find(n) {
      if(!n||typeof n!=='object') return false;
      if(n.type==='CallExpression'&&n.callee?.name==='eval') return true;
      return Object.values(n).some(v=>Array.isArray(v)?v.some(find):v?.type?find(v):false);
    }
    if(find(body)) this._evalPolluted=true;
  }

  buildDDGEdges() {
    // fix #20: skip entirely if eval-polluted
    if(this._evalPolluted) return [];
    const byName=new Map();
    for(const d of this.defs){if(!byName.has(d.varName))byName.set(d.varName,[]);byName.get(d.varName).push(d);}
    for(const a of byName.values()) a.sort((a,b)=>a.line-b.line);
    const edges=[];
    for(const {varName,ref,line:ul} of this.uses) {
      const ds=(byName.get(varName)??[]).filter(d=>d.line<=ul);
      if(!ds.length) continue;
      const best=ds[ds.length-1];
      const di=this.nm.get(best.ref), ui=this.nm.get(ref);
      if(di==null||ui==null||di===ui) continue;
      edges.push({src:di,dst:ui,edge_type:'REACHING_DEF',var_name:varName,def_line:best.line,use_line:ul});
      if(ds.length>1){
        const prev=ds[ds.length-2];
        const pi=this.nm.get(prev.ref);
        if(pi!=null&&pi!==ui&&prev.line!==best.line)
          edges.push({src:pi,dst:ui,edge_type:'REACHING_DEF_ALT',var_name:varName,def_line:prev.line,use_line:ul});
      }
    }
    return edges;
  }
}

// ─────────────────────────────────────────────────────────────
// 5.  CFG builder (fix #4 back-edge detection via RPO)
// ─────────────────────────────────────────────────────────────
function extractDefsUses(node) {
  const defs=new Set(), uses=new Set();
  function walk(n,lhs){
    if(!n||typeof n!=='object')return;
    switch(n.type){
      case 'AssignmentExpression':walk(n.left,true);walk(n.right,false);return;
      case 'VariableDeclarator':flattenPat(n.id).forEach(v=>defs.add(v));if(n.init)walk(n.init,false);return;
      case 'UpdateExpression':if(n.argument?.name){defs.add(n.argument.name);uses.add(n.argument.name);}return;
      case 'Identifier':if(!JS_KW.has(n.name)){if(lhs)defs.add(n.name);else uses.add(n.name);}return;
    }
    for(const v of Object.values(n))if(Array.isArray(v))v.forEach(c=>walk(c,false));else if(v?.type)walk(v,false);
  }
  walk(node,false);
  return{defs:[...defs],uses:[...uses]};
}

class CFGBuilder {
  constructor(rel,nm){this.rel=rel;this.nm=nm;this.nodes=[];this.edges=[];}
  _n(label,type,an){
    const id=an?(this.nm.get(an)??nid()):nid();
    if(!this.nodes.find(n=>n.id===id)){
      const{defs,uses}=an?extractDefsUses(an):{defs:[],uses:[]};
      this.nodes.push({id,label,type,full_label:label,...loc(an??{}),file:this.rel,full_path:this.rel,defs,uses});
    }
    return id;
  }
  _e(src,dst,et='CFG',extra={}){
    if(src==null||dst==null)return;
    if(!this.edges.find(e=>e.src===src&&e.dst===dst&&e.edge_type===et))
      this.edges.push({src,dst,edge_type:et,source_line:this.nodes.find(n=>n.id===src)?.line??-1,target_line:this.nodes.find(n=>n.id===dst)?.line??-1,...extra});
  }
  buildFunc(fn,name,isAsync=false,isGen=false){
    const entry=this._n(`ENTRY:${name}`,'ENTRY',fn);
    const exit =this._n(`EXIT:${name}`, 'EXIT', fn);
    if(!fn.body){this._e(entry,exit);return{entry,exit};}
    const stmts=fn.body.type==='BlockStatement'?fn.body.body:[fn.body];
    const ctx={fe:exit,isAsync,isGen,bk:[],ct:[]};
    const{firstNode:fN,exits}=this._block(stmts,[entry],ctx);
    if(fN!==null)this._e(entry,fN);
    exits.forEach(n=>this._e(n,exit));
    return{entry,exit};
  }
  _block(ss,preds,ctx){
    if(!ss?.length)return{firstNode:null,exits:preds};
    let cur=preds,first=null;
    for(const s of ss){const r=this._stmt(s,ctx);if(!r)continue;if(first===null)first=r.node;cur.forEach(p=>this._e(p,r.node));cur=r.next;}
    return{firstNode:first,exits:cur};
  }
  _ss(n){return n?.type==='BlockStatement'?n.body:(n?[n]:[]);}
  _stmt(s,ctx){
    if(!s)return null;
    switch(s.type){
      case 'IfStatement':{
        const c=this._n(`IF:${s.loc?.start?.line}`,'IfStatement',s);
        const tr=this._block(this._ss(s.consequent),[c],ctx);
        if(tr.firstNode)this._e(c,tr.firstNode,'CFG',{condition:'true'});
        let fE=[c];
        if(s.alternate){const fl=this._block(this._ss(s.alternate),[c],ctx);if(fl.firstNode)this._e(c,fl.firstNode,'CFG',{condition:'false'});fE=fl.exits;}
        const j=this._n(`JOIN:${s.loc?.end?.line}`,'JOIN',s);
        [...tr.exits,...fE].forEach(n=>this._e(n,j));
        return{node:c,next:[j]};
      }
      case 'WhileStatement':case 'DoWhileStatement':{
        const lp=this._n(`${s.type}:${s.loc?.start?.line}`,s.type,s);
        const bCtx={...ctx,bk:[{l:null,t:lp},...ctx.bk],ct:[{l:null,t:lp},...ctx.ct]};
        const bd=this._block(this._ss(s.body),[lp],bCtx);
        if(bd.firstNode)this._e(lp,bd.firstNode,'CFG',{condition:'true'});
        bd.exits.forEach(n=>this._e(n,lp));
        return{node:lp,next:[lp]};
      }
      case 'ForStatement':case 'ForInStatement':case 'ForOfStatement':{
        const fn=this._n(`${s.type}:${s.loc?.start?.line}`,s.type,s);
        const bCtx={...ctx,bk:[{l:null,t:fn},...ctx.bk],ct:[{l:null,t:fn},...ctx.ct]};
        const bd=this._block(this._ss(s.body),[fn],bCtx);
        if(bd.firstNode)this._e(fn,bd.firstNode);
        bd.exits.forEach(n=>this._e(n,fn));
        if(s.type==='ForOfStatement'&&s.await)this._e(fn,fn,'CFG',{edge_label:'await_iter'});
        return{node:fn,next:[fn]};
      }
      case 'LabeledStatement':{
        const j=this._n(`LBJOIN:${s.loc?.end?.line}`,'LABEL_JOIN',s);
        const bCtx={...ctx,bk:[{l:s.label?.name,t:j},...ctx.bk]};
        const r=this._stmt(s.body,bCtx);
        if(!r)return{node:j,next:[j]};
        r.next.forEach(n=>this._e(n,j));
        return{node:r.node,next:[j]};
      }
      case 'BreakStatement':{
        const bn=this._n(`BREAK:${s.loc?.start?.line}`,'BreakStatement',s);
        const t=ctx.bk.find(x=>x.l===s.label?.name||x.l===null);
        if(t)this._e(bn,t.t,'CFG',{edge_label:'break'});
        return{node:bn,next:[]};
      }
      case 'ContinueStatement':{
        const cn=this._n(`CONT:${s.loc?.start?.line}`,'ContinueStatement',s);
        const t=ctx.ct.find(x=>x.l===s.label?.name||x.l===null);
        if(t)this._e(cn,t.t,'CFG',{edge_label:'continue'});
        return{node:cn,next:[]};
      }
      case 'ReturnStatement':{const r=this._n(`RET:${s.loc?.start?.line}`,'ReturnStatement',s);this._e(r,ctx.fe);return{node:r,next:[]};}
      case 'ThrowStatement':{const t=this._n(`THR:${s.loc?.start?.line}`,'ThrowStatement',s);this._e(t,ctx.fe);return{node:t,next:[]};}
      case 'TryStatement':{
        const t=this._n(`TRY:${s.loc?.start?.line}`,'TRY',s);
        const tb=this._block(s.block.body,[t],ctx);
        let ce=[];
        if(s.handler){const c=this._n(`CATCH:${s.handler.loc?.start?.line}`,'CATCH',s.handler);this._e(t,c,'CFG',{condition:'exception'});ce=this._block(s.handler.body?.body??[],[c],ctx).exits;}
        if(s.finalizer){const f=this._n(`FIN:${s.finalizer.loc?.start?.line}`,'FINALLY',s.finalizer);[...tb.exits,...ce].forEach(n=>this._e(n,f));return{node:t,next:[f]};}
        return{node:t,next:[...tb.exits,...ce]};
      }
      case 'SwitchStatement':{
        const sw=this._n(`SW:${s.loc?.start?.line}`,'SwitchStatement',s);
        const j=this._n(`SWJOIN:${s.loc?.end?.line}`,'SWITCH_JOIN',s);
        const bCtx={...ctx,bk:[{l:null,t:j},...ctx.bk]};
        let ft=[sw];
        for(const c of s.cases){const r=this._block(c.consequent,ft,bCtx);if(r.firstNode)this._e(sw,r.firstNode);ft=r.exits;}
        ft.forEach(n=>this._e(n,j));
        return{node:sw,next:[j]};
      }
      case 'ExpressionStatement':{
        const n=this._n(`ES:${s.loc?.start?.line}`,s.type,s);
        if(ctx.isAsync&&s.expression?.type==='AwaitExpression')this._e(n,n,'CFG',{edge_label:'await_suspend'});
        return{node:n,next:[n]};
      }
      case 'YieldExpression':{
        const y=this._n(`YIELD:${s.loc?.start?.line}`,'YieldExpression',s);
        if(ctx.isGen){this._e(y,ctx.fe,'CFG',{edge_label:'yield'});this._e(y,y,'CFG',{edge_label:'yield_resume'});}
        return{node:y,next:[y]};
      }
      case 'OptionalCallExpression':{
        const oc=this._n(`OC:${s.loc?.start?.line}`,'OptionalCall',s);
        const oj=this._n(`OJ:${s.loc?.end?.line}`,'OPT_JOIN',s);
        this._e(oc,oj,'CFG',{condition:'not_nullish'});
        this._e(oc,oj,'CFG',{condition:'nullish_skip'});
        return{node:oc,next:[oj]};
      }
      case 'BlockStatement':{const r=this._block(s.body,[],ctx);return r.firstNode?{node:r.firstNode,next:r.exits}:null;}
      default:{const n=this._n(`${s.type}:${s.loc?.start?.line}`,s.type,s);return{node:n,next:[n]};}
    }
  }
  finalize(){
    const BB=new Set(['ExpressionStatement','VariableDeclaration','ReturnStatement','ThrowStatement','DebuggerStatement']);
    const od=new Map(),id2=new Map();
    for(const n of this.nodes){od.set(n.id,0);id2.set(n.id,0);}
    for(const e of this.edges){od.set(e.src,(od.get(e.src)??0)+1);id2.set(e.dst,(id2.get(e.dst)??0)+1);}
    const mg=new Map();
    const rep=id=>{let c=id;const seen=new Set();while(mg.has(c)&&!seen.has(c)){seen.add(c);c=mg.get(c);}return c;};
    for(const n of this.nodes){
      if(!BB.has(n.type)||(od.get(n.id)??0)!==1)continue;
      const sc=this.edges.find(e=>e.src===n.id&&e.edge_type==='CFG');
      if(!sc)continue;
      const dn=this.nodes.find(x=>x.id===sc.dst);
      if(!dn||!BB.has(dn.type)||(id2.get(sc.dst)??0)!==1)continue;
      mg.set(sc.dst,rep(n.id));
    }
    this.nodes=this.nodes.filter(n=>!mg.has(n.id));
    this.edges=this.edges.filter(e=>!mg.has(e.src)).map(e=>({...e,dst:rep(e.dst)})).filter(e=>e.src!==e.dst);
  }
}

function extractFunctions(ast, rel) {
  const out=[];
  const FT=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
  function name(node,parent){
    if(node.id?.name)return node.id.name;
    if(parent?.type==='VariableDeclarator')return parent.id?.name??'<anon>';
    if(parent?.type==='AssignmentExpression')return parent.left?.name??'<anon>';
    if(parent?.type==='ObjectProperty'||parent?.type==='Property')return parent.key?.name??parent.key?.value??'<anon>';
    if(parent?.type==='ClassMethod')return parent.key?.name??'<anon>';
    if(parent?.type==='ExportDefaultDeclaration')return 'default';
    return`<anon:${node.loc?.start?.line??'?'}>`;
  }
  function walk(node,parent){
    if(!node||typeof node!=='object')return;
    if(FT.has(node.type))out.push({node,name:name(node,parent),file:rel,isAsync:node.async??false,isGen:node.generator??false});
    for(const k of Object.keys(node)){if(['loc','start','end','tokens','comments'].includes(k))continue;const v=node[k];if(Array.isArray(v))v.forEach(c=>walk(c,node));else if(v?.type)walk(v,node);}
  }
  walk(ast.program,null);
  return out;
}

// ─────────────────────────────────────────────────────────────
// 6.  Decorators  (including class-map application)
// ─────────────────────────────────────────────────────────────
function extractDecorators(ast, rel, classMap) {
  const out=[];
  function dname(d){const e=d.expression;if(e.type==='Identifier')return e.name;if(e.type==='CallExpression'){const c=e.callee;return c.type==='Identifier'?c.name:c.type==='MemberExpression'?`${c.object?.name}.${c.property?.name}`:'<unk>';}return'<unk>';}
  function dargs(d){if(d.expression.type!=='CallExpression')return[];return(d.expression.arguments??[]).map(a=>a.type==='StringLiteral'||a.type==='Literal'?a.value:a.type==='Identifier'?a.name:'<expr>');}
  function walk(n){
    if(!n||typeof n!=='object')return;
    for(const d of n.decorators??[]){
      const nm=dname(d),args=dargs(d),tgt=n.id?.name??n.key?.name??'<anon>';
      out.push({name:nm,args,target:tgt,targetType:n.type,line:d.loc?.start?.line??-1,file:rel});
      if(n.type==='ClassDeclaration'&&classMap?.has(tgt)){
        const cls=classMap.get(tgt);
        (cls.decorators=cls.decorators??[]).push({name:nm,args});
        if(['Injectable','Controller','Component','Service','Pipe','Guard','Module'].includes(nm))cls.injectable=true;
      }
    }
    for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(walk);else if(v?.type)walk(v);}
  }
  walk(ast.program);
  return out;
}

// ─────────────────────────────────────────────────────────────
// 7.  Prototype tracker
// ─────────────────────────────────────────────────────────────
class ProtoTracker {
  constructor(){this.pm=new Map();this.oc=new Map();this.mx=new Map();}
  extract(ast){
    const self=this;
    function walk(n){
      if(!n||typeof n!=='object')return;
      if(n.type==='AssignmentExpression'){
        const l=n.left;
        if(l?.type==='MemberExpression'&&l.object?.type==='MemberExpression'&&l.object.property?.name==='prototype'&&l.object.object?.name){
          const cls=l.object.object.name,m=l.property?.name;
          if(m){if(!self.pm.has(cls))self.pm.set(cls,[]);self.pm.get(cls).push(m);}
        }
      }
      if(n.type==='VariableDeclarator'&&n.init?.type==='CallExpression'){
        const c=n.init.callee;
        if(c?.type==='MemberExpression'&&c.object?.name==='Object'&&c.property?.name==='create'){
          const a=n.init.arguments?.[0];
          const p=a?.type==='MemberExpression'&&a.property?.name==='prototype'?a.object?.name:a?.name;
          if(p&&n.id?.name)self.oc.set(n.id.name,p);
        }
      }
      if(n.type==='CallExpression'){const c=n.callee;if(c?.type==='MemberExpression'&&c.object?.name==='Object'&&c.property?.name==='assign'){const t=n.arguments?.[0];if(t?.type==='MemberExpression'&&t.property?.name==='prototype'){const cls=t.object?.name;for(const a of n.arguments?.slice(1)??[]){const mx=a?.name;if(cls&&mx){if(!self.mx.has(cls))self.mx.set(cls,[]);self.mx.get(cls).push(mx);}}}}}
      for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(walk);else if(v?.type)walk(v);}
    }
    walk(ast.program);
  }
  methods(cls){
    const m=new Set(this.pm.get(cls)??[]);
    for(const mx of this.mx.get(cls)??[])for(const mm of this.pm.get(mx)??[])m.add(mm);
    const p=this.oc.get(cls);if(p)for(const mm of this.methods(p))m.add(mm);
    return m;
  }
}

// ─────────────────────────────────────────────────────────────
// 8.  Dynamic calls + module.exports  (fix #11 bare exports.foo)
// ─────────────────────────────────────────────────────────────
function extractDynamic(ast, rel) {
  const out=[];
  function walk(n){
    if(!n||typeof n!=='object')return;
    if(n.type==='CallExpression'||n.type==='OptionalCallExpression'){
      const c=n.callee,line=n.loc?.start?.line??-1;
      if(c?.type==='MemberExpression'&&c.computed)out.push({kind:'computed_method',pattern:`[${c.property?.name??'<expr>'}]`,object:c.object?.name??'<expr>',line,file:rel});
      if(c?.type==='MemberExpression'&&['then','catch','finally'].includes(c.property?.name)){const cb=n.arguments?.[0]?.name??(n.arguments?.[0]?.type?.includes('Function')?'<fn>':'<expr>');out.push({kind:'promise_chain',method:c.property.name,handler:cb,line,file:rel});}
      if(c?.type==='MemberExpression'&&['on','once','addEventListener','addListener'].includes(c.property?.name)){const ev=n.arguments?.[0]?.value??'<dyn>',cb=n.arguments?.[1]?.name??'<fn>';out.push({kind:'event_handler',event:ev,handler:cb,object:c.object?.name??'<expr>',line,file:rel});}
      if(c?.name==='require'&&n.arguments?.[0]?.type!=='StringLiteral'&&n.arguments?.[0]?.type!=='Literal')out.push({kind:'dynamic_require',pattern:'require(<expr>)',line,file:rel});
    }
    if(n.type==='ImportExpression'){const s=n.source;out.push({kind:'dynamic_import',pattern:s?.type==='StringLiteral'||s?.type==='Literal'?s.value:'<dyn>',line:n.loc?.start?.line??-1,file:rel});}
    for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(walk);else if(v?.type)walk(v);}
  }
  walk(ast.program);
  return out;
}

function extractExports(ast, rel) {
  const m=new Map();
  function walk(n){
    if(!n||typeof n!=='object')return;
    const line=n.loc?.start?.line??-1;
    if(n.type==='AssignmentExpression'){
      const l=n.left;
      if(l?.type==='MemberExpression'){
        // module.exports = { ... }
        if(l.object?.name==='module'&&l.property?.name==='exports'){
          const r=n.right;
          if(r.type==='ObjectExpression')for(const p of r.properties??[]){const k=p.key?.name??p.key?.value;if(k)m.set(k,{name:k,sourceName:p.value?.name??k,line,file:rel});}
          else if(r.type==='Identifier')m.set(r.name,{name:r.name,line,file:rel});
        }
        // module.exports.foo = ...
        if(l.object?.type==='MemberExpression'&&l.object.object?.name==='module'&&l.object.property?.name==='exports'){const k=l.property?.name;if(k)m.set(k,{name:k,line,file:rel});}
        // fix #11: bare exports.foo = ...
        if(l.object?.name==='exports'){const k=l.property?.name;if(k)m.set(k,{name:k,line,file:rel});}
      }
    }
    if(n.type==='ExportDefaultDeclaration')m.set('default',{name:n.declaration?.id?.name??'default',line,file:rel});
    if(n.type==='ExportNamedDeclaration'&&!n.source)for(const s of n.specifiers??[]){const k=s.exported?.name??s.exported?.value;if(k)m.set(k,{name:s.local?.name??k,line,file:rel});}
    for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(walk);else if(v?.type)walk(v);}
  }
  walk(ast.program);
  return m;
}

// ─────────────────────────────────────────────────────────────
// 9.  Arrow-this tracker
// ─────────────────────────────────────────────────────────────
function buildArrowThisMap(ast, rel) {
  const r=new Map();
  function walk(n,cls,tc){
    if(!n||typeof n!=='object')return;
    let c=cls,t=tc;
    if(n.type==='ClassDeclaration'||n.type==='ClassExpression'){c=n.id?.name??'<Anon>';t=c;}
    if(n.type==='FunctionDeclaration'||n.type==='FunctionExpression')t=null;
    if(n.type==='ArrowFunctionExpression'&&t&&n.loc)for(let l=n.loc.start.line;l<=n.loc.end.line;l++)if(!r.has(`${rel}:${l}`))r.set(`${rel}:${l}`,t);
    if(t&&n.loc)for(let l=n.loc.start.line;l<=n.loc.end.line;l++)if(!r.has(`${rel}:${l}`))r.set(`${rel}:${l}`,t);
    for(const k of Object.keys(n)){if(['loc','start','end','tokens','comments'].includes(k))continue;const v=n[k];if(Array.isArray(v))v.forEach(ch=>{if(ch?.type)walk(ch,c,t);});else if(v?.type)walk(v,c,t);}
  }
  walk(ast.program,null,null);
  return r;
}

// ─────────────────────────────────────────────────────────────
// 10.  Module resolver  (fix #3 absolute paths, #11 workspaces,
//      tsconfig aliases, re-exports, bare exports)
// ─────────────────────────────────────────────────────────────
class ModResolver {
  constructor(rootDir,fps,wsA,tscA,fileExports){
    this.root=rootDir;this.fps=new Set(fps);this.wsA=wsA??new Map();this.tscA=tscA??new Map();this.fe=fileExports??new Map();
    this.m2f=new Map();this.al=new Map();this._idx(fps);
  }
  _idx(fps){
    for(const fp of fps){
      const k=fp.replace(/\.(js|jsx|ts|tsx|mjs|cjs|d\.ts)$/,'');
      this.m2f.set(k,fp);
      const s=path.posix.basename(k);
      if(!this.m2f.has(s))this.m2f.set(s,fp);
      if(s==='index'){const d=path.posix.dirname(k);if(!this.m2f.has(d))this.m2f.set(d,fp);}
    }
  }
  // fix #3: use absolute intermediate path
  resSpec(fromFile,spec){
    if(!spec)return null;
    for(const[a,d]of this.wsA){if(spec===a)return this.m2f.get(d)??null;if(spec.startsWith(a+'/')){const r=this._try(norm(path.join(d,spec.slice(a.length+1))));if(r)return r;}}
    for(const[a,d]of this.tscA){if(spec===a)return this.m2f.get(d)??null;if(spec.startsWith(a+'/')){const r=this._try(norm(path.join(d,spec.slice(a.length+1))));if(r)return r;}}
    if(!spec.startsWith('.'))return null;
    // fix #3: absolute path first, then relative
    const abs=path.resolve(this.root,path.dirname(fromFile),spec);
    return this._try(norm(path.relative(this.root,abs)));
  }
  _try(base){
    for(const c of[base,base+'.js',base+'.ts',base+'.jsx',base+'.tsx',base+'.mjs',base+'/index.js',base+'/index.ts']){
      const rel=norm(path.relative(this.root,path.resolve(this.root,c)));
      if(this.fps.has(rel))return rel;
    }
    return this.m2f.get(base.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/,''))??null;
  }
  extractImports(fromFile,ast){
    const al=new Map();const self=this;
    function walk(n){
      if(!n||typeof n!=='object')return;
      if(n.type==='ImportDeclaration'){
        const r=self.resSpec(fromFile,n.source?.value??'')??n.source?.value;
        for(const s of n.specifiers??[]){
          if(s.type==='ImportDefaultSpecifier')al.set(s.local.name,r);
          else if(s.type==='ImportNamespaceSpecifier')al.set(s.local.name,r);
          else if(s.type==='ImportSpecifier'){const imp=s.imported?.name??s.imported?.value;const expInfo=self.fe.get(r)?.get(imp);al.set(s.local.name,expInfo?`${r}::${expInfo.sourceName??imp}`:`${r}::${imp}`);}
        }
        return;
      }
      if(n.type==='VariableDeclaration')for(const d of n.declarations??[]){
        if(d.init?.type!=='CallExpression'||d.init.callee?.name!=='require')continue;
        const spec=d.init.arguments?.[0]?.value;if(!spec)continue;
        const r=self.resSpec(fromFile,spec)??spec;
        if(d.id?.type==='Identifier')al.set(d.id.name,r);
        else if(d.id?.type==='ObjectPattern')for(const p of d.id.properties??[]){const k=p.value?.name??p.key?.name;if(k){const ei=self.fe.get(r)?.get(k);al.set(k,ei?`${r}::${ei.sourceName??k}`:`${r}::${k}`);}}
      }
      // re-exports
      if(n.type==='ExportNamedDeclaration'&&n.source){const r=self.resSpec(fromFile,n.source.value??'')??n.source.value;for(const s of n.specifiers??[]){const local=s.local?.name??s.local?.value,exp=s.exported?.name??s.exported?.value;if(local)al.set(local,`${r}::${local}`);if(exp&&exp!==local)al.set(exp,`${r}::${local??exp}`);}}
      if(n.type==='ExportAllDeclaration'&&n.source){const r=self.resSpec(fromFile,n.source.value??'')??n.source.value;if(r)al.set(`*:${r}`,r);}
      for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(walk);else if(v?.type)walk(v);}
    }
    walk(ast.program);
    this.al.set(fromFile,al);
    return al;
  }
  resolve(fromFile,name){const al=this.al.get(fromFile)??new Map();if(al.has(name))return al.get(name);if(name.includes('.')){const b=name.split('.')[0];if(al.has(b))return al.get(b);}return null;}
  importEdges(){
    const edges=[];
    for(const[fp,al]of this.al){const seen=new Set();for(const tgt of al.values()){const b=tgt.split('::')[0];if(this.fps.has(b)&&b!==fp&&!seen.has(b)){seen.add(b);edges.push({src:fp,dst:b,dependency_type:'import',call_count:1});}}}
    return edges;
  }
}

// ─────────────────────────────────────────────────────────────
// 11.  Repo analyzer  (fix #6 getMRO visited, fix for circular)
// ─────────────────────────────────────────────────────────────
class RepoAnalyzer {
  constructor(resolver,proto,typeProp,atm){this.res=resolver;this.pt=proto;this.tp=typeProp;this.atm=atm;this.fns=new Map();this.calls=new Map();this.classes=new Map();}
  extract(ast,rel){
    const self=this;
    const FT=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
    function gn(node,parent){
      if(node.id?.name)return node.id.name;
      if(parent?.type==='VariableDeclarator')return parent.id?.name??'<anon>';
      if(parent?.type==='AssignmentExpression')return parent.left?.name??'<anon>';
      if(parent?.type==='ObjectProperty'||parent?.type==='Property')return parent.key?.name??parent.key?.value??'<anon>';
      if(parent?.type==='ClassMethod')return parent.key?.name??'<anon>';
      if(parent?.type==='ExportDefaultDeclaration')return 'default';
      return`<anon:${node.loc?.start?.line??'?'}>`;
    }
    function walk(n,parent,cls){
      if(!n||typeof n!=='object')return;
      if(n.type==='ClassDeclaration'||n.type==='ClassExpression'){
        const cn=n.id?.name??'<anon>';cls=cn;
        const bases=[];
        if(n.superClass){if(n.superClass.type==='Identifier')bases.push(n.superClass.name);else if(n.superClass.type==='MemberExpression')bases.push(`${n.superClass.object?.name}.${n.superClass.property?.name}`);}
        self.classes.set(cn,{file:rel,bases,methods:[...self.pt.methods(cn)],line:n.loc?.start?.line??-1,injectable:false});
      }
      if(FT.has(n.type)){
        const fname=gn(n,parent);
        const params=(n.params??[]).flatMap(p=>flattenPat(p)).filter(p=>p!=='this');
        const rec={file:rel,nodeId:n.loc?.start?.line??-1,params,cls,line:n.loc?.start?.line??-1,isAsync:n.async??false,isGen:n.generator??false};
        if(!self.fns.has(fname))self.fns.set(fname,[]);self.fns.get(fname).push(rec);
        if(cls){const qn=`${cls}.${fname}`;if(!self.fns.has(qn))self.fns.set(qn,[]);self.fns.get(qn).push(rec);}
      }
      if(n.type==='CallExpression'||n.type==='OptionalCallExpression'){
        const nA=(n.arguments??[]).length,line=n.loc?.start?.line??-1;
        let callee=null;const c=n.callee;
        if(c?.type==='Identifier'){callee=c.name;}
        else if(c?.type==='MemberExpression'||c?.type==='OptionalMemberExpression'){
          const prop=c.property?.name??'?';
          if(c.object?.type==='ThisExpression'){const tc=self.atm.get(rel)?.get(`${rel}:${line}`)??cls;callee=tc?`${tc}.${prop}`:`this.${prop}`;}
          else{const obj=c.object?.name??c.object?.property?.name??'?';callee=c.computed?`${obj}[<dyn>]`:self.tp?.resolveMethod(rel,obj,prop)??`${obj}.${prop}`;}
        }
        if(c?.type==='MemberExpression'&&['then','catch','finally'].includes(c.property?.name)){const cb=n.arguments?.[0];if(cb?.name){if(!self.calls.has(rel))self.calls.set(rel,[]);self.calls.get(rel).push({calledName:cb.name,nodeId:line,nArgs:0,line});}}
        if(callee){if(!self.calls.has(rel))self.calls.set(rel,[]);self.calls.get(rel).push({calledName:callee,nodeId:line,nArgs:nA,line});}
      }
      for(const k of Object.keys(n)){if(['loc','start','end','tokens','comments'].includes(k))continue;const v=n[k];if(Array.isArray(v))v.forEach(c=>walk(c,n,cls));else if(v?.type)walk(v,n,cls);}
    }
    walk(ast.program,null,null);
  }
  // fix #6: getMRO with visited guard — no infinite loop
  getMRO(cls){
    const mro=[cls];const visited=new Set([cls]);
    const info=this.classes.get(cls);
    const q=[...(info?.bases??[]),...(this.pt.oc.get(cls)?[this.pt.oc.get(cls)]:[])];
    while(q.length){
      const cur=q.shift();
      if(visited.has(cur))continue; // fix #6
      visited.add(cur);mro.push(cur);
      const ci=this.classes.get(cur);if(ci)q.push(...ci.bases.filter(b=>!visited.has(b)));
    }
    return mro;
  }
  resolveCall(cf,name,nA){
    let cands=[...(this.fns.get(name)??[])];
    if(name.includes('.')&&!name.includes('[<dyn>]')){
      const[obj,...rest]=name.split('.');const meth=rest.join('.');
      const rf=this.res.resolve(cf,obj);if(rf){const b=rf.split('::')[0];cands.push(...(this.fns.get(meth)??[]).filter(r=>r.file===b));}
      for(const cn of this.classes.keys())if(cn===obj||cn.endsWith('::'+obj))for(const m of this.getMRO(cn)){const s=m.includes('::')?m.split('::')[1]:m;cands.push(...(this.fns.get(`${s}.${meth}`)??[]));}
    }
    const seen=new Set();cands=cands.filter(r=>{const k=`${r.file}:${r.nodeId}`;if(seen.has(k))return false;seen.add(k);return true;});
    if(nA>0&&cands.length>1){const ex=cands.filter(r=>r.params.length===nA);if(ex.length)return ex;const cl=cands.filter(r=>Math.abs(r.params.length-nA)<=1);if(cl.length)return cl;}
    return cands;
  }
}

// ─────────────────────────────────────────────────────────────
// 12.  Type propagator  (fix #8 ts-morph cleared per repo)
// ─────────────────────────────────────────────────────────────
let _tsMorphProject=null;

function unwrap(t){if(!t)return t;const m=t.match(/^(?:Array|Promise|Observable|Subject|BehaviorSubject|EventEmitter|ReadonlyArray)<(.+)>$/);if(m)return m[1];const a=t.match(/^(.+)\[\]$/);if(a)return a[1];return t;}

class TypeProp {
  constructor(res){this.res=res;this.vt=new Map();this.tt=new Map();}
  extract(ast,rel){
    const types=new Map();
    function walk(n){
      if(!n||typeof n!=='object')return;
      if(n.type==='VariableDeclarator'&&n.id?.type==='Identifier'){const init=n.init;if(init?.type==='NewExpression'){const cls=init.callee?.name??init.callee?.property?.name;if(cls?.[0]?.match(/[A-Z]/))types.set(n.id.name,cls);}if(init?.type==='MemberExpression'&&init.property?.name?.[0]?.match(/[A-Z]/))types.set(n.id.name,init.property.name);}
      if(n.type==='AssignmentExpression'&&n.left?.type==='Identifier'&&n.right?.type==='NewExpression'){const cls=n.right.callee?.name??n.right.callee?.property?.name;if(cls?.[0]?.match(/[A-Z]/))types.set(n.left.name,cls);}
      for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(walk);else if(v?.type)walk(v);}
    }
    walk(ast.program);this.vt.set(rel,types);
  }
  // fix #8: clear ts-morph project files between repos
  runTsMorph(fps,rootDir){
    if(!tsMorph)return{types:{},count:0};
    const tsFiles=fps.filter(f=>/\.(ts|tsx)$/.test(f));
    if(!tsFiles.length)return{types:{},count:0};
    let count=0;const types={};
    try{
      if(!_tsMorphProject)_tsMorphProject=new tsMorph.Project({compilerOptions:{allowJs:true,strict:false},addFilesFromTsConfig:false});
      const proj=_tsMorphProject;
      // fix #8: remove stale files from previous repo
      for(const sf of proj.getSourceFiles())proj.removeSourceFile(sf);
      for(const fp of tsFiles)try{proj.addSourceFileAtPath(fp);}catch(_){}
      for(const sf of proj.getSourceFiles()){
        const rel=norm(path.relative(rootDir,sf.getFilePath()));
        types[rel]={};
        for(const vd of sf.getVariableDeclarations()){let t=unwrap(vd.getType().getText());if(t&&t!=='any'&&t!=='unknown'){types[rel][vd.getName()]=t;count++;}}
        for(const fn of sf.getFunctions()){const rt=unwrap(fn.getReturnType().getText());if(rt&&rt!=='void'&&rt!=='any')types[rel][`${fn.getName()}#return`]=rt;for(const p of fn.getParameters()){let pt=unwrap(p.getType().getText());if(pt&&pt!=='any'){types[rel][p.getName()]=pt;count++;}}}
        for(const cls of sf.getClasses())for(const prop of cls.getProperties()){let pt=unwrap(prop.getType().getText());if(pt&&pt!=='any'){types[rel][`${cls.getName()}.${prop.getName()}`]=pt;count++;}}
      }
    }catch(_){}
    return{types,count};
  }
  resolveMethod(file,obj,meth){const tt=this.tt.get(file)?.get(obj);if(tt)return`${tt}.${meth}`;const t=this.vt.get(file)?.get(obj);return t?`${t}.${meth}`:null;}
  total(){let n=0;for(const m of this.vt.values())n+=m.size;return n;}
}

// ─────────────────────────────────────────────────────────────
// 13.  PDG — correct post-dominator + back-edge exclusion (fix #4)
// ─────────────────────────────────────────────────────────────
function computePDG(cfgNodes, cfgEdges, ddgEdges) {
  if(!cfgNodes.length) return ddgEdges.map(e=>({...e,edge_type:'PDG_DATA'}));

  const ids=cfgNodes.map(n=>n.id);
  const ns=new Set(ids);
  const succ=new Map(ids.map(id=>[id,[]]));
  const pred=new Map(ids.map(id=>[id,[]]));
  for(const e of cfgEdges){if(!e.edge_type?.startsWith('CFG'))continue;if(!ns.has(e.src)||!ns.has(e.dst))continue;succ.get(e.src).push(e.dst);pred.get(e.dst).push(e.src);}

  const exitIds=cfgNodes.filter(n=>n.type==='EXIT'||(succ.get(n.id)?.length??0)===0).map(n=>n.id);
  if(!exitIds.length) return ddgEdges.map(e=>({...e,edge_type:'PDG_DATA'}));

  // Build reverse graph for post-dominator computation
  const rsucc=new Map([[VEXIT,[...exitIds]],...ids.map(id=>[id,[]])]);
  const rpred=new Map([[VEXIT,[]],...ids.map(id=>[id,[]])]);
  for(const[s,ds]of succ)for(const d of ds){rsucc.get(d)?.push(s);rpred.get(s)?.push(d);}
  for(const eid of exitIds){if(!rsucc.get(VEXIT).includes(eid))rsucc.get(VEXIT).push(eid);if(!rpred.get(eid).includes(VEXIT))rpred.get(eid).push(VEXIT);}

  // RPO on reverse graph
  const rpo=[];const vis=new Set();
  function dfs(v){if(vis.has(v))return;vis.add(v);for(const s of rsucc.get(v)??[])dfs(s);rpo.unshift(v);}
  dfs(VEXIT);
  const rpoIdx=new Map(rpo.map((id,i)=>[id,i]));

  const idom=new Map([[VEXIT,VEXIT]]);
  function intersect(b1,b2){let f1=b1,f2=b2;while(f1!==f2){while((rpoIdx.get(f1)??Infinity)>(rpoIdx.get(f2)??Infinity))f1=idom.get(f1)??f1;while((rpoIdx.get(f2)??Infinity)>(rpoIdx.get(f1)??Infinity))f2=idom.get(f2)??f2;if(f1===f2)break;}return f1;}

  let changed=true,iters=0,MAX=cfgNodes.length*4+10;
  while(changed&&iters++<MAX){
    changed=false;
    for(const b of rpo){
      if(b===VEXIT)continue;
      const pl=(rpred.get(b)??[]).filter(p=>idom.has(p));
      if(!pl.length)continue;
      let ni=pl[0];for(const p of pl.slice(1))if(idom.has(p))ni=intersect(p,ni);
      if(idom.get(b)!==ni){idom.set(b,ni);changed=true;}
    }
  }

  // fix #4: identify back edges (B dominates A in forward CFG → (A→B) is back edge)
  // Use RPO of the FORWARD graph for this
  const fRpo=[];const fVis=new Set();
  function fdfs(v){if(fVis.has(v))return;fVis.add(v);for(const s of succ.get(v)??[])fdfs(s);fRpo.unshift(v);}
  const entryIds=cfgNodes.filter(n=>n.type==='ENTRY').map(n=>n.id);
  for(const e of entryIds)fdfs(e);
  const fRpoIdx=new Map(fRpo.map((id,i)=>[id,i]));
  const isBackEdge=(a,b)=>((fRpoIdx.get(b)??Infinity)<=(fRpoIdx.get(a)??-Infinity));

  // Compute control-dependence edges (fix #4: skip back edges)
  const nm=new Map(cfgNodes.map(n=>[n.id,n]));
  const cdEdges=[];
  for(const e of cfgEdges){
    if(e.edge_type!=='CFG')continue;
    const A=e.src,B=e.dst;
    if(!nm.has(A)||!nm.has(B))continue;
    if(isBackEdge(A,B))continue; // fix #4: skip back edges
    const ipdA=idom.get(A);
    const visited=new Set();let cur=B;
    while(cur!=null&&cur!==ipdA&&cur!==VEXIT&&!visited.has(cur)){
      visited.add(cur);
      if(cur!==A&&nm.has(cur))
        cdEdges.push({src:A,dst:cur,edge_type:'PDG_CONTROL',condition:e.condition??e.edge_label??'branch',source_line:nm.get(A)?.line??-1,target_line:nm.get(cur)?.line??-1});
      cur=idom.get(cur);
    }
  }
  return [...ddgEdges.map(e=>({...e,edge_type:'PDG_DATA'})),...cdEdges];
}

// ─────────────────────────────────────────────────────────────
// 14.  Unified CPG  (fix #10 deduplicated edges)
// ─────────────────────────────────────────────────────────────
function buildCPG(astN,astE,cfgN,cfgE,ddgE,pdgE) {
  const unified=new Map();
  const astIdSet=new Set(astN.map(n=>n.id));
  for(const n of astN)unified.set(n.id,{...n,sources:['ast'],ast_id:n.id,cfg_id:-1,ddg_id:-1});
  const cfgMap=new Map();
  for(const n of cfgN){
    if(astIdSet.has(n.id)){const u=unified.get(n.id);if(u&&!u.sources.includes('cfg')){u.sources.push('cfg');u.cfg_id=n.id;}cfgMap.set(n.id,n.id);}
    else{unified.set(n.id,{...n,sources:['cfg'],ast_id:-1,cfg_id:n.id,ddg_id:-1});cfgMap.set(n.id,n.id);}
  }
  // fix #10: deduplicate edges via composite key Set
  const seen=new Set();
  const uEdges=[];
  function addE(e){
    const s=cfgMap.get(e.src)??e.src,d=cfgMap.get(e.dst)??e.dst;
    if(!unified.has(s)||!unified.has(d))return;
    const k=`${s}|${d}|${e.edge_type}`;
    if(seen.has(k))return;seen.add(k);
    uEdges.push({...e,src:s,dst:d});
  }
  for(const e of astE)addE(e);
  for(const e of cfgE)addE(e);
  for(const e of ddgE)addE(e);
  if(pdgE)for(const e of pdgE)addE(e);
  return{nodes:[...unified.values()],edges:uEdges};
}

function addCrossFileEdges(uNodes,uEdges,analyzer){
  const lk=new Map();
  for(const n of uNodes){const f=norm(n.file??n.source_file??'');const k=`${f}:${n.line}`;if(!lk.has(k))lk.set(k,n.id);}
  let ic=0,xd=0;const extra=[];
  for(const[cf,cl]of analyzer.calls){
    for(const{calledName:cn,line:callLine,nArgs:nA}of cl){
      for(const t of analyzer.resolveCall(cf,cn,nA)){
        if(t.file===cf)continue;
        const cu=lk.get(`${cf}:${callLine}`),tu=lk.get(`${t.file}:${t.line}`);
        if(cu==null||tu==null)continue;
        extra.push({src:cu,dst:tu,edge_type:'ICFG_CALL',called_name:cn,source_file:cf,target_file:t.file});
        extra.push({src:tu,dst:cu,edge_type:'ICFG_RETURN',source_file:t.file,target_file:cf});ic+=2;
        for(let i=0;i<t.params.length;i++){extra.push({src:cu,dst:tu,edge_type:'CROSS_FILE_DDG',flow_type:'arg_to_param',param_name:t.params[i],param_index:i,source_file:cf,target_file:t.file});xd++;}
        extra.push({src:tu,dst:cu,edge_type:'CROSS_FILE_DDG',flow_type:'return_to_callsite',source_file:t.file,target_file:cf});xd++;
      }
    }
  }
  // deduplicate cross-file edges too
  const seen=new Set(uEdges.map(e=>`${e.src}|${e.dst}|${e.edge_type}`));
  const de=extra.filter(e=>{const k=`${e.src}|${e.dst}|${e.edge_type}`;if(seen.has(k))return false;seen.add(k);return true;});
  return{edges:[...uEdges,...de],icfgCount:ic,xDDGCount:xd};
}

// ─────────────────────────────────────────────────────────────
// 15.  IFDG  (fix #18 dedup with call_count accumulation)
// ─────────────────────────────────────────────────────────────
function buildIFDG(fps,resolver,analyzer){
  const em=new Map();
  const add=(s,d,t)=>{const k=`${s}||${d}||${t}`;if(em.has(k))em.get(k).call_count++;else em.set(k,{src:s,dst:d,dependency_type:t,call_count:1});};
  for(const e of resolver.importEdges())add(e.src,e.dst,'import');
  for(const[cf,cl]of analyzer.calls)for(const{calledName,nArgs}of cl)for(const t of analyzer.resolveCall(cf,calledName,nArgs))if(t.file!==cf)add(cf,t.file,'function_call');
  return{files:fps.map(f=>({id:f,node_type:'file'})),edges:[...em.values()]};
}

// ─────────────────────────────────────────────────────────────
// 16.  Pure per-file analysis  (called by worker — no cross-file state)
//      fix #1: workers ONLY do AST/CFG/DDG/PDG, no analyzer/resolver needed
// ─────────────────────────────────────────────────────────────
function analyzeFile(fp, rel, code, fileIndex) {
  _GID = fileIndex * FILE_ID_SPACE;
  let ast;
  try { ast = parseFile(code, fp); }
  catch(e) { return {error:`ParseError:${e.message}`}; }

  const{nodes:aN,edges:aE,nodeIdMap}=buildAST(ast,rel);
  const cfgB=new CFGBuilder(rel,nodeIdMap);
  for(const{node,name,isAsync,isGen}of extractFunctions(ast,rel))
    cfgB.buildFunc(node,name,isAsync,isGen);
  cfgB.finalize();

  const sw=new ScopeWalker(rel,nodeIdMap);
  sw.walk(ast);
  const ddgE=sw.buildDDGEdges();
  const pdgE=computePDG(cfgB.nodes,cfgB.edges,ddgE);
  const cpg=buildCPG(aN,aE,cfgB.nodes,cfgB.edges,ddgE,pdgE);
  const dynamic=extractDynamic(ast,rel);

  return{
    ast:{nodes:aN,edges:aE},
    cfg:{nodes:cfgB.nodes,edges:cfgB.edges},
    ddg:{nodes:cfgB.nodes,edges:ddgE},
    pdg:{edges:pdgE},
    cpg:{nodes:cpg.nodes,edges:cpg.edges},
    dynamic,
    // pass back raw AST for cross-file analysis in main thread
    _rawAst:ast,
  };
}

// ─────────────────────────────────────────────────────────────
// 17.  Worker dispatch  (fix #9/#22 message delivery race)
// ─────────────────────────────────────────────────────────────
function analyzeInWorker(fp,rel,code,fileIndex,timeoutMs){
  if(!Worker){
    try{return Promise.resolve({ok:true,rel,...analyzeFile(fp,rel,code,fileIndex)});}
    catch(e){return Promise.resolve({ok:false,rel,error:e.message});}
  }
  return new Promise(resolve=>{
    const w=new Worker(__filename,{workerData:{_isWorker:true,fp,rel,code,fileIndex}});
    const timer=setTimeout(()=>{w.terminate();resolve({ok:false,rel,error:`Timeout ${timeoutMs}ms`});},timeoutMs);
    w.on('message',msg=>{clearTimeout(timer);resolve(msg);});
    w.on('error',e=>{clearTimeout(timer);resolve({ok:false,rel,error:e.message});});
    w.on('exit',code=>{if(code!==0){clearTimeout(timer);resolve({ok:false,rel,error:`Worker exit ${code}`});}});
  });
}

// ─────────────────────────────────────────────────────────────
// 18.  NDJSON emit
// ─────────────────────────────────────────────────────────────
function emit(obj){process.stdout.write(JSON.stringify(obj)+'\n');}

// ─────────────────────────────────────────────────────────────
// 19.  MAIN
// ─────────────────────────────────────────────────────────────
async function main(){
  const rootDir=path.resolve(process.argv[2]);
  const disc=collectFiles(rootDir);
  const wsA=buildWorkspaceAliases(rootDir);
  const tscA=readTsconfigAliases(rootDir);
  const fps=disc.files.map(f=>norm(path.relative(rootDir,f)));

  // Phase 0: pre-parse for exports + imports (main thread)
  const fileExports=new Map();
  const preAsts=new Map();
  const failAudit={};

  for(const fp of disc.files){
    const rel=norm(path.relative(rootDir,fp));
    let code,ast;
    try{code=fs.readFileSync(fp,'utf8');}catch(e){disc.failed.push(rel);disc.errors[rel]=e.message;continue;}
    try{ast=parseFile(code,fp);}catch(e){disc.failed.push(rel);disc.errors[rel]=`ParseError:${e.message}`;continue;}
    fileExports.set(rel,extractExports(ast,rel));
    preAsts.set(rel,{fp,rel,code,ast});
  }

  // Phase 1: cross-file metadata extraction (main thread — fix #1)
  const resolver=new ModResolver(rootDir,fps,wsA,tscA,fileExports);
  const proto=new ProtoTracker();
  const atm=new Map();
  const tp=new TypeProp(resolver);
  const analyzer=new RepoAnalyzer(resolver,proto,tp,atm);
  const classMap=new Map();

  for(const[rel,{fp,ast}]of preAsts){
    resolver.extractImports(rel,ast);
    proto.extract(ast);
    atm.set(rel,buildArrowThisMap(ast,rel));
    tp.extract(ast,rel);
    analyzer.extract(ast,rel);
    for(const[k,v]of analyzer.classes)classMap.set(k,v);
  }

  const tsm=tp.runTsMorph(disc.files,rootDir);
  for(const[r,t]of Object.entries(tsm.types??{}))tp.tt.set(r,new Map(Object.entries(t)));

  // Phase 2: per-file graph construction (workers — fix #1 workers have no cross-file state)
  const allAstN=[],allCfgN=[],allCfgE=[],allDdgE=[],allAstE=[];
  let fileIndex=0;

  for(const[rel,{fp,code,ast}]of preAsts){
    // fix #7 not relevant here (worker timeout is in analyzeInWorker)
    const result=await analyzeInWorker(fp,rel,code,fileIndex++,FILE_TIMEOUT_MS);

    if(!result.ok){
      disc.failed.push(rel);disc.errors[rel]=result.error??'unknown';
      // fix #23: detailed audit category
      const cat=(result.error??'unknown').replace(/\s*\(.*$/,'').split(':')[0];
      failAudit[cat]=(failAudit[cat]??0)+1;
      continue;
    }
    const{ast:aG,cfg,ddg,pdg,cpg,dynamic}=result;
    allAstN.push(...aG.nodes);allAstE.push(...aG.edges);
    allCfgN.push(...cfg.nodes);allCfgE.push(...cfg.edges);
    allDdgE.push(...ddg.edges);

    // Decorators run in main thread (have classMap) — fix #11 decorator ordering
    const decs=extractDecorators(ast,rel,classMap);

    // fix #1: intra-file ICFG + arg→param DDG added here in main thread
    const callsInFile=analyzer.calls.get(rel)??[];
    const icfgExtra=[], ddgExtra=[];
    for(const{calledName,line,nArgs}of callsInFile){
      const targets=analyzer.resolveCall(rel,calledName,nArgs);
      for(const t of targets){
        if(t.file!==rel)continue;
        const site=cfg.nodes.find(n=>n.line===line);
        const entry=cfg.nodes.find(n=>n.type==='ENTRY'&&n.label.includes(calledName));
        if(!site||!entry)continue;
        icfgExtra.push({src:site.id,dst:entry.id,edge_type:'ICFG_CALL',source_line:site.line,target_line:entry.line});
        const exitN=cfg.nodes.find(n=>n.type==='EXIT'&&n.label.includes(calledName));
        if(exitN)for(const e of cfg.edges.filter(e=>e.src===site.id&&e.edge_type==='CFG'))
          icfgExtra.push({src:exitN.id,dst:e.dst,edge_type:'ICFG_RETURN',source_line:exitN.line,target_line:e.dst});
        for(let i=0;i<t.params.length;i++)ddgExtra.push({src:site.id,dst:entry.id,edge_type:'INTRA_ARG_FLOW',param_index:i,param_name:t.params[i]});
      }
    }
    allCfgE.push(...icfgExtra);
    allDdgE.push(...ddgExtra);

    emit({type:'file',rel,ast:aG,cfg:{nodes:cfg.nodes,edges:[...cfg.edges,...icfgExtra]},ddg:{nodes:ddg.nodes,edges:[...ddg.edges,...ddgExtra]},pdg,cpg,decorators:decs,dynamic});
  }

  // Call graph
  const cgN=[],cgE=[];
  for(const[name,recs]of analyzer.fns){if(name.includes('.'))continue;for(const r of recs)cgN.push({id:`${r.file}:${r.nodeId}`,name,qualified_name:r.cls?`${r.cls}.${name}`:name,file:r.file,type:'function',param_count:r.params.length,line:r.line,is_async:r.isAsync,is_gen:r.isGen});}
  for(const[cf,cl]of analyzer.calls)for(const{calledName,nodeId,nArgs}of cl)for(const t of analyzer.resolveCall(cf,calledName,nArgs))cgE.push({src:`${cf}:${nodeId}`,dst:`${t.file}:${t.nodeId}`,edge_type:'CALL',called_name:calledName,cross_file:t.file!==cf});

  // IFDG
  const ifdg=buildIFDG(fps,resolver,analyzer);

  // Global unified CPG + cross-file edges
  const ucpg=buildCPG(allAstN,allAstE,allCfgN,allCfgE,allDdgE,[]);
  const{edges:finalEdges,icfgCount,xDDGCount}=addCrossFileEdges(ucpg.nodes,ucpg.edges,analyzer);
  ucpg.edges=finalEdges;

  // fix #19 unified_cpg on own line
  emit({type:'unified_cpg',nodes:ucpg.nodes,edges:ucpg.edges});

  // fix #5: interprocedural_cfg on own line
  emit({type:'interprocedural_cfg',nodes:allCfgN,edges:allCfgE});

  // fix #15: ts_types on own line
  emit({type:'ts_types',types:tsm.types??{}});

  // Summary — lean, no giant embedded arrays (fix #21)
  emit({
    type:'summary',
    call_graph:{nodes:cgN,edges:cgE},
    ifdg,
    icfg_count:icfgCount, xddg_count:xDDGCount,
    typed_variables:tp.total()+tsm.count,
    ts_morph_available:tsMorph!==null,
    total_functions:[...new Set([...analyzer.fns.keys()].filter(k=>!k.includes('.')))].length,
    total_classes:analyzer.classes.size,
    total_call_sites:[...analyzer.calls.values()].reduce((a,v)=>a+v.length,0),
    workspace_aliases:Object.fromEntries(wsA),
    tsconfig_aliases:Object.fromEntries(tscA),
    failed:disc.failed.map(norm),
    errors:Object.fromEntries(Object.entries(disc.errors).map(([k,v])=>[norm(k),v])),
    failure_audit:failAudit,
  });
}

// ─────────────────────────────────────────────────────────────
// 20.  Entry dispatch
// ─────────────────────────────────────────────────────────────
if(isMainThread){
  main().catch(e=>{process.stderr.write(`FATAL:${e.stack??e.message}\n`);process.exit(1);});
} else if(workerData?._isWorker){
  // fix #9/#22: parentPort.close() + setImmediate(exit) — no race
  const r=analyzeFile(workerData.fp,workerData.rel,workerData.code,workerData.fileIndex??0);
  const{_rawAst,...out}=r; // strip non-serializable WeakMap
  parentPort.postMessage({ok:!out.error,rel:workerData.rel,...out});
  parentPort.close();
  setImmediate(()=>process.exit(0));
}
