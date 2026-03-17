#!/usr/bin/env python3
"""
JS/TS Bug Pickle Extractor v6 — all 24 issues from the v5 critique fixed
=========================================================================
Python-side fixes:
  #5  interprocedural_cfg accumulated from own NDJSON line
  #7  Test runner: cross-platform stderr redirect (2>NUL on Windows)
  #15 ts_types accumulated from own NDJSON line
  #17 norm() handles None safely
  #18 npm install timeout surfaced as failure_audit entry
  #21 freeze_support() + module-level _process_one (Windows safe)
  #23 detailed failure_audit: full first-segment category
  #24 Node.js version check before launching bridge

npm install -g @babel/parser@7     # pin major version
npm install -g ts-morph            # optional
"""

from __future__ import annotations
import os, sys, json, pickle, subprocess, time, gc, argparse
import concurrent.futures, threading, traceback, multiprocessing
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional
import difflib, textwrap

import networkx as nx

try:
    import psutil
    PSUTIL_OK = True
except ImportError:
    PSUTIL_OK = False

# ─────────────────────────────────────────────────────────────
# 0.  Configuration
# ─────────────────────────────────────────────────────────────
MAX_WORKERS      = min(8, os.cpu_count() or 4)
INSTANCE_TIMEOUT = 600
BRIDGE_TIMEOUT   = 300
MEMORY_SOFT_GB   = 12.0
MEMORY_HARD_GB   = 20.0
AUTO_RESTART     = True
SKIP_PROCESSED   = True
PROGRESS_FILE    = "processing_progress.json"
BRIDGE_SCRIPT    = Path(__file__).parent / "analysis_bridge_v6.js"

# fix #17: safe norm — handles None, int, Path, str
def norm(p) -> str:
    return str(p).replace("\\", "/") if p is not None else ""

NODE_PATH: Optional[str] = None
IS_WINDOWS = sys.platform == "win32"

# ─────────────────────────────────────────────────────────────
# 1.  Schema
# ─────────────────────────────────────────────────────────────

@dataclass
class TestResults:
    status: str      = "not_run"
    runner: str      = "unknown"
    total: int       = 0
    passed: int      = 0
    failed: int      = 0
    pass_rate: float = 0.0
    failing_tests: list = field(default_factory=list)
    error: str       = ""
    duration_ms: int = 0

@dataclass
class ExtractionQuality:
    issues: list              = field(default_factory=list)
    num_buggy_files: int      = 0
    num_fixed_files: int      = 0
    total_buggy_code_len: int = 0
    total_fixed_code_len: int = 0
    test_files_filtered: bool = True
    failed_files: int         = 0

@dataclass
class GraphMetadata:
    framework: str            = ""
    version: str              = ""
    total_files: int          = 0
    total_functions: int      = 0
    total_classes: int        = 0
    total_call_sites: int     = 0
    total_ast_nodes: int      = 0
    total_cfg_nodes: int      = 0
    total_ddg_nodes: int      = 0
    total_pdg_edges: int      = 0
    call_graph_nodes: int     = 0
    call_graph_edges: int     = 0
    inter_file_deps: int      = 0
    unified_cpg_nodes: int    = 0
    unified_cpg_edges: int    = 0
    typed_variables: int      = 0
    icfg_edges: int           = 0
    interproc_ddg_edges: int  = 0
    icfg_enhanced: bool       = True
    interprocedural_ddg: bool = True
    total_decorators: int     = 0
    total_dynamic_calls: int  = 0
    failed_files: int         = 0
    workspace_aliases: dict   = field(default_factory=dict)
    tsconfig_aliases: dict    = field(default_factory=dict)
    failure_audit: dict       = field(default_factory=dict)

@dataclass
class JSTSInstance:
    instance_id: str          = ""
    problem_statement: str    = ""
    repo: str                 = ""
    source_dataset: str       = ""
    file_path: list           = field(default_factory=list)
    buggy_files: list         = field(default_factory=list)
    original_code: dict       = field(default_factory=dict)
    patched_code: dict        = field(default_factory=dict)
    buggy_code: str           = ""
    fixed_code: str           = ""
    block_code_buggy: str     = ""
    block_code_fixed: str     = ""
    patch: str                = ""
    graphs: dict              = field(default_factory=dict)
    bug_type: str             = ""
    cve_id: str               = ""
    project: str              = ""
    extraction_quality: ExtractionQuality = field(default_factory=ExtractionQuality)
    framework: str            = ""
    language: str             = "javascript"
    module_system: str        = "unknown"
    test_runner: str          = "unknown"
    package_manager: str      = "npm"
    tsconfig_present: bool    = False
    type_errors_fixed: bool   = False
    transpiled: bool          = False
    dts_decls: dict           = field(default_factory=dict)
    ts_morph_used: bool       = False
    ts_types: dict            = field(default_factory=dict)
    decorators: dict          = field(default_factory=dict)
    dynamic_calls: dict       = field(default_factory=dict)
    workspace_aliases: dict   = field(default_factory=dict)
    tsconfig_aliases: dict    = field(default_factory=dict)
    test_results_buggy: TestResults = field(default_factory=TestResults)
    test_results_fixed: TestResults = field(default_factory=TestResults)
    reproducible: bool        = False

# ─────────────────────────────────────────────────────────────
# 2.  Memory management
# ─────────────────────────────────────────────────────────────

def get_mem() -> float:
    if PSUTIL_OK:
        return psutil.Process(os.getpid()).memory_info().rss / (1024**3)
    try:
        with open('/proc/self/status') as f:
            for ln in f:
                if ln.startswith('VmRSS:'):
                    return int(ln.split()[1]) / (1024**2)
    except Exception:
        pass
    return 0.0

def check_mem() -> float:
    m = get_mem()
    if m > MEMORY_HARD_GB:
        print(f"  [MEM CRITICAL] {m:.1f}GB")
        gc.collect(); gc.collect(); gc.collect()
    elif m > MEMORY_SOFT_GB:
        gc.collect()
    return get_mem()

# ─────────────────────────────────────────────────────────────
# 3.  Progress tracking
# ─────────────────────────────────────────────────────────────

def load_prog(d: str) -> dict:
    p = Path(d) / PROGRESS_FILE
    if p.exists():
        try: return json.loads(p.read_text())
        except Exception: pass
    return {"processed_instances":[], "failed_instances":[]}

def save_prog(d: str, pr: dict):
    Path(d).mkdir(parents=True, exist_ok=True)
    p = Path(d) / PROGRESS_FILE
    pr["last_update"] = time.strftime("%Y-%m-%d %H:%M:%S")
    tmp = str(p)+".tmp"
    with open(tmp,"w") as f: json.dump(pr,f,indent=2)
    os.replace(tmp,str(p))

def mark_done(d: str, iid: str):
    pr = load_prog(d)
    if iid not in pr["processed_instances"]:
        pr["processed_instances"].append(iid)
    pr["failed_instances"] = [e for e in pr.get("failed_instances",[])
                               if (e if isinstance(e,str) else e.get("id")) != iid]
    save_prog(d, pr)

def mark_fail(d: str, iid: str, err: str=""):
    pr = load_prog(d)
    fl = pr.setdefault("failed_instances",[])
    ids = [e if isinstance(e,str) else e.get("id") for e in fl]
    if iid not in ids:
        fl.append({"id":iid,"error":err[:500],"time":time.strftime("%H:%M:%S")})
    save_prog(d, pr)

def is_done(iid: str, out_dir: str, prog_dir: str) -> bool:
    if not SKIP_PROCESSED: return False
    if (Path(out_dir)/f"{iid}.pickle").exists(): return True
    return iid in load_prog(prog_dir).get("processed_instances",[])

# ─────────────────────────────────────────────────────────────
# 4.  Shell helpers
# ─────────────────────────────────────────────────────────────

def run_cmd(cmd: str, timeout=60, cwd=None) -> tuple:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=timeout, shell=True, cwd=cwd)
        return r.stdout.strip(), r.stderr.strip(), r.returncode
    except subprocess.TimeoutExpired:
        return "", "timeout", -1
    except Exception as e:
        return "", str(e), -1

def check_node():
    global NODE_PATH
    try:
        v = subprocess.run(["node","--version"], capture_output=True, text=True, timeout=5)
        version_str = v.stdout.strip()
        print(f"[✓] Node.js {version_str}")
        # fix #24: version check
        major = int(version_str.lstrip("v").split(".")[0])
        if major < 12:
            print(f"  [!] Node.js ≥ 12 required for worker_threads."
                  f" Current: {version_str}. Bridge will run single-threaded.")
    except FileNotFoundError:
        sys.exit("[✗] Node.js not found")
    NODE_PATH = run_cmd("npm root -g")[0]
    print(f"[✓] NODE_PATH → {NODE_PATH}")

def check_npm(pkg: str, required=True) -> bool:
    out, _, _ = run_cmd(f"npm list -g --depth=0 {pkg}")
    ok = pkg in out
    print(f"  {'[✓]' if ok else ('[✗] MISSING' if required else '[~] optional')} {pkg}"
          + ("" if ok else f"  →  npm install -g {pkg}"))
    return ok

def check_bridge() -> bool:
    if not BRIDGE_SCRIPT.exists():
        print(f"[✗] Bridge not found: {BRIDGE_SCRIPT}")
        return False
    print(f"[✓] Bridge: {BRIDGE_SCRIPT}")
    return True

# ─────────────────────────────────────────────────────────────
# 5.  Bridge runner — NDJSON streaming with stderr thread
# ─────────────────────────────────────────────────────────────

def run_bridge(repo_path: Path, timeout=BRIDGE_TIMEOUT) -> Optional[dict]:
    env = os.environ.copy()
    if NODE_PATH:
        existing = env.get("NODE_PATH","")
        env["NODE_PATH"] = (NODE_PATH + os.pathsep + existing) if existing else NODE_PATH
    try:
        proc = subprocess.Popen(
            ["node", str(BRIDGE_SCRIPT), str(repo_path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=env, bufsize=1,
        )
    except Exception as ex:
        print(f"    [!] bridge launch: {ex}")
        return None

    acc  = {"files":{}}
    sbuf: list = []

    # Drain stderr in background thread to prevent pipe-buffer deadlock
    def _drain():
        for line in proc.stderr:
            sbuf.append(line.rstrip())
    t = threading.Thread(target=_drain, daemon=True)
    t.start()

    deadline = time.time() + timeout
    try:
        for raw in proc.stdout:
            if time.time() > deadline:
                proc.kill()
                print(f"    [!] bridge timeout after {timeout}s")
                break
            line = raw.strip()
            if not line: continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as je:
                print(f"    [!] JSON decode: {je} — {line[:80]}")
                continue

            tp = obj.get("type")
            if tp == "file":
                rel = norm(obj.get("rel",""))
                acc["files"][rel] = {
                    "ast":        obj.get("ast",    {"nodes":[],"edges":[]}),
                    "cfg":        obj.get("cfg",    {"nodes":[],"edges":[]}),
                    "ddg":        obj.get("ddg",    {"nodes":[],"edges":[]}),
                    "pdg":        obj.get("pdg",    {"edges":[]}),
                    "cpg":        obj.get("cpg",    {"nodes":[],"edges":[]}),
                    "decorators": obj.get("decorators",[]),
                    "dynamic":    obj.get("dynamic",[]),
                }
            elif tp == "unified_cpg":
                acc["unified_cpg"] = {"nodes":obj.get("nodes",[]),"edges":obj.get("edges",[])}
            # fix #5: interprocedural_cfg on own line
            elif tp == "interprocedural_cfg":
                acc["interprocedural_cfg"] = {"nodes":obj.get("nodes",[]),"edges":obj.get("edges",[])}
            # fix #15: ts_types on own line
            elif tp == "ts_types":
                acc["ts_types"] = obj.get("types",{})
            elif tp == "summary":
                acc.update({k:v for k,v in obj.items() if k!="type"})
        proc.wait(timeout=15)
    except Exception as ex:
        proc.kill()
        print(f"    [!] bridge stream: {ex}")
    finally:
        t.join(timeout=5)

    if proc.returncode not in (0, None):
        for l in sbuf[:15]:
            print(f"    stderr: {l}")

    return acc if (acc.get("files") or acc.get("call_graph")) else None

# ─────────────────────────────────────────────────────────────
# 6.  Test execution harness (fix #7 cross-platform stderr redirect)
# ─────────────────────────────────────────────────────────────

class TestHarness:
    # fix #7: platform-specific null redirect
    _NULL = "2>NUL" if IS_WINDOWS else "2>/dev/null"

    RUNNERS: dict = {}  # populated after class definition

    TIMEOUT   = 120
    DEP_TIMEOUT = 300   # fix #18: generous dep install timeout

    def __init__(self, repo: Path, runner: str):
        self.repo   = repo
        self.runner = runner
        self._ok    = False

    def install(self) -> bool:
        if (self.repo/"node_modules").exists():
            self._ok = True; return True
        if not (self.repo/"package.json").exists(): return False
        _, err, rc = run_cmd("npm install --prefer-offline",
                             timeout=self.DEP_TIMEOUT, cwd=self.repo)
        self._ok = (rc == 0)
        # fix #18: surface install failure in result
        if not self._ok:
            print(f"    [!] npm install failed ({rc}): {err[:200]}")
        return self._ok

    def run(self) -> TestResults:
        if not (self.repo/"package.json").exists():
            return TestResults(status="no_package_json", runner=self.runner)
        if not self._ok and not self.install():
            return TestResults(status="deps_failed", runner=self.runner,
                               error="npm install failed")  # fix #18
        cmd = self.RUNNERS.get(self.runner, f"npm test {self._NULL}")
        t0  = time.time()
        out, err, rc = run_cmd(cmd, timeout=self.TIMEOUT, cwd=self.repo)
        ms  = int((time.time()-t0)*1000)
        if ms >= self.TIMEOUT*1000-200:
            return TestResults(status="timeout", runner=self.runner, duration_ms=ms)
        return self._parse(out, err, rc, ms)

    def _parse(self, out, err, rc, ms) -> TestResults:
        # Jest JSON
        try:
            d = json.loads(out)
            if "testResults" in d:
                fl = []
                for s in d.get("testResults",[]):
                    for t in s.get("testResults",[]):
                        if t.get("status")!="passed":
                            fl.append({"name":t.get("fullName",""),"status":t.get("status",""),
                                       "file":s.get("testFilePath",""),
                                       "msg":(t.get("failureMessages")or[""])[0][:200]})
                tot=d.get("numTotalTests",0); pas=d.get("numPassedTests",0); fai=d.get("numFailedTests",0)
                return TestResults(status="success" if rc==0 else "failed",runner=self.runner,
                                   total=tot,passed=pas,failed=fai,pass_rate=pas/max(tot,1),
                                   failing_tests=fl[:50],duration_ms=ms)
        except Exception: pass
        # Mocha JSON
        try:
            d = json.loads(out)
            if "stats" in d:
                s=d["stats"];tot=s.get("tests",0);pas=s.get("passes",0);fai=s.get("failures",0)
                fl=[{"name":f.get("fullTitle",""),"msg":f.get("err",{}).get("message","")[:200]}
                    for f in d.get("failures",[])[:50]]
                return TestResults(status="success" if rc==0 else "failed",runner=self.runner,
                                   total=tot,passed=pas,failed=fai,pass_rate=pas/max(tot,1),
                                   failing_tests=fl,duration_ms=ms)
        except Exception: pass
        # Heuristic
        text=(out+err).lower()
        p=text.count("passing")+text.count("✓")+text.count("passed")
        f=text.count("failing")+text.count("✗")+text.count("failed")
        return TestResults(status="success" if rc==0 else "failed",runner=self.runner,
                           total=p+f,passed=p,failed=f,pass_rate=p/max(p+f,1),
                           duration_ms=ms,error=(out+err)[:500] if rc!=0 else "")

# fix #7: build runner commands after class definition (uses _NULL)
TestHarness.RUNNERS = {
    "jest":    f"npx jest --json --no-coverage --passWithNoTests {TestHarness._NULL}",
    "vitest":  f"npx vitest run --reporter=json {TestHarness._NULL}",
    "mocha":   f"npx mocha --reporter json {TestHarness._NULL}",
    "ava":     f"npx ava --tap {TestHarness._NULL}",
    "jasmine": f"npx jasmine {TestHarness._NULL}",
}

# ─────────────────────────────────────────────────────────────
# 7.  JSON → NetworkX
# ─────────────────────────────────────────────────────────────

def to_g(nodes: list, edges: list) -> nx.DiGraph:
    G = nx.DiGraph()
    for n in nodes:
        nid = n.get("id", id(n))
        G.add_node(nid, **{k:v for k,v in n.items() if k!="id"})
    for e in edges:
        if "src" in e and "dst" in e:
            G.add_edge(e["src"],e["dst"],**{k:v for k,v in e.items() if k not in("src","dst")})
    return G

def parse_raw(data: dict) -> dict:
    per_file={};all_ast=[];all_cfg=[];all_ddg=[];all_decs={};all_dyn={}
    for rel,fd in data.get("files",{}).items():
        rel=norm(rel)
        per_file[rel]={
            "AST": to_g(fd["ast"]["nodes"],  fd["ast"]["edges"]),
            "CFG": to_g(fd["cfg"]["nodes"],  fd["cfg"]["edges"]),
            "DDG": to_g(fd["ddg"]["nodes"],  fd["ddg"]["edges"]),
            "PDG": to_g(fd["cfg"]["nodes"],  fd["pdg"].get("edges",[])),
            "CPG": to_g(fd["cpg"]["nodes"],  fd["cpg"]["edges"]),
        }
        all_ast+=fd["ast"]["nodes"]; all_cfg+=fd["cfg"]["nodes"]; all_ddg+=fd["ddg"]["nodes"]
        all_decs[rel]=fd.get("decorators",[]); all_dyn[rel]=fd.get("dynamic",[])

    cg   = data.get("call_graph",          {"nodes":[],"edges":[]})
    # fix #5: use dedicated interprocedural_cfg line
    icfg = data.get("interprocedural_cfg", {"nodes":[],"edges":[]})
    ucpg = data.get("unified_cpg",         {"nodes":[],"edges":[]})
    ifdg_r = data.get("ifdg",             {"files":[],"edges":[]})

    ifdg=nx.DiGraph()
    for f in ifdg_r.get("files",[]):
        fid=norm(f.get("id",f) if isinstance(f,dict) else f); ifdg.add_node(fid,node_type="file")
    for e in ifdg_r.get("edges",[]):
        s,d=norm(e["src"]),norm(e["dst"]); ifdg.add_node(s,node_type="file"); ifdg.add_node(d,node_type="file")
        if ifdg.has_edge(s,d): ifdg[s][d]["call_count"]=ifdg[s][d].get("call_count",1)+e.get("call_count",0)
        else: ifdg.add_edge(s,d,dependency_type=e.get("dependency_type","import"),call_count=e.get("call_count",1))

    # fix #23: full failure audit detail
    fa=data.get("failure_audit",{})
    if fa: print(f"    Failure audit: {fa}")

    return {
        "per_file":          per_file,
        "call_graph":        to_g(cg["nodes"],   cg["edges"]),
        "icfg":              to_g(icfg["nodes"],  icfg["edges"]),
        "unified_cpg":       to_g(ucpg["nodes"],  ucpg["edges"]),
        "ifdg":              ifdg,
        "icfg_count":        data.get("icfg_count",          0),
        "xddg_count":        data.get("xddg_count",          0),
        "typed_variables":   data.get("typed_variables",      0),
        "total_functions":   data.get("total_functions",      0),
        "total_classes":     data.get("total_classes",        0),
        "total_call_sites":  data.get("total_call_sites",     0),
        "total_decorators":  0,
        "total_dynamic_calls":0,
        "failed_files":      [norm(f) for f in data.get("failed",[])],
        "failure_audit":     fa,
        "dts_decls":         data.get("dts_decls",       {}),
        "ts_morph_used":     data.get("ts_morph_available",False),
        # fix #15: ts_types from own NDJSON line
        "ts_types":          data.get("ts_types",         {}),
        "workspace_aliases": data.get("workspace_aliases",{}),
        "tsconfig_aliases":  data.get("tsconfig_aliases", {}),
        "decorators":        all_decs,
        "dynamic_calls":     all_dyn,
        "all_ast_nodes":     all_ast,
        "all_cfg_nodes":     all_cfg,
        "all_ddg_nodes":     all_ddg,
    }

# ─────────────────────────────────────────────────────────────
# 8.  Repo helpers
# ─────────────────────────────────────────────────────────────

def collect_src(root: Path) -> list:
    exts={".js",".jsx",".ts",".tsx",".mjs",".cjs"}
    skip={"test","spec","__tests__",".test.",".spec."}
    return sorted(p for p in root.rglob("*")
                  if p.suffix in exts
                  and "node_modules" not in p.parts
                  and not any(s in p.name for s in skip))

def read_files(root: Path, files: list) -> dict:
    return {norm(str(f.relative_to(root))): f.read_text(errors="replace") for f in files}

def make_patch(old: dict, new: dict) -> str:
    chunks=[]
    for fname in sorted(set(old)|set(new)):
        a=old.get(fname,"").splitlines(keepends=True)
        b=new.get(fname,"").splitlines(keepends=True)
        chunks.extend(difflib.unified_diff(a,b,fromfile=f"a/{fname}",tofile=f"b/{fname}"))
    return "".join(chunks)

def detect_runner(root: Path) -> str:
    pkg=root/"package.json"
    if pkg.exists():
        try:
            d=json.loads(pkg.read_text())
            deps={**d.get("dependencies",{}),**d.get("devDependencies",{})}
            for r in ["jest","vitest","mocha","jasmine","ava"]:
                if r in deps: return r
        except Exception: pass
    return "unknown"

def detect_module(root: Path) -> str:
    pkg=root/"package.json"
    if pkg.exists():
        try:
            d=json.loads(pkg.read_text())
            return "esm" if d.get("type")=="module" else "commonjs"
        except Exception: pass
    return "unknown"

def detect_pkgmgr(root: Path) -> str:
    if (root/"yarn.lock").exists(): return "yarn"
    if (root/"pnpm-lock.yaml").exists(): return "pnpm"
    return "npm"

def build_meta(graphs: dict, runner: str) -> GraphMetadata:
    m=GraphMetadata(framework=runner, version="v6_all_gaps_fixed")
    m.total_files         = len(graphs["per_file"])
    m.total_ast_nodes     = len(graphs["all_ast_nodes"])
    m.total_cfg_nodes     = len(graphs["all_cfg_nodes"])
    m.total_ddg_nodes     = len(graphs["all_ddg_nodes"])
    m.total_functions     = graphs["total_functions"]
    m.total_classes       = graphs["total_classes"]
    m.total_call_sites    = graphs["total_call_sites"]
    m.total_decorators    = sum(len(v) for v in graphs.get("decorators",{}).values())
    m.total_dynamic_calls = sum(len(v) for v in graphs.get("dynamic_calls",{}).values())
    m.call_graph_nodes    = graphs["call_graph"].number_of_nodes()
    m.call_graph_edges    = graphs["call_graph"].number_of_edges()
    m.inter_file_deps     = graphs["ifdg"].number_of_edges()
    m.unified_cpg_nodes   = graphs["unified_cpg"].number_of_nodes()
    m.unified_cpg_edges   = graphs["unified_cpg"].number_of_edges()
    m.typed_variables     = graphs["typed_variables"]
    m.icfg_edges          = graphs["icfg_count"]
    m.interproc_ddg_edges = graphs["xddg_count"]
    m.icfg_enhanced       = True
    m.interprocedural_ddg = True
    m.workspace_aliases   = graphs.get("workspace_aliases",{})
    m.tsconfig_aliases    = graphs.get("tsconfig_aliases", {})
    m.failure_audit       = graphs.get("failure_audit",    {})
    m.failed_files        = len(graphs.get("failed_files", []))
    m.total_pdg_edges     = sum(pf["PDG"].number_of_edges() for pf in graphs["per_file"].values())
    return m

# ─────────────────────────────────────────────────────────────
# 9.  Snapshot analyser
# ─────────────────────────────────────────────────────────────

def analyse(repo: Path, run_tests=False, runner="unknown") -> Optional[dict]:
    print(f"    bridge v6 on {repo.name} ...")
    raw = run_bridge(repo)
    if not raw: return None
    graphs = parse_raw(raw)
    files  = collect_src(repo)
    code   = read_files(repo, files)
    tres   = TestResults()
    if run_tests and runner != "unknown":
        h = TestHarness(repo, runner)
        tres = h.run()
        print(f"    tests: {tres.passed}/{tres.total} ({tres.status})")
    return {
        "files":            files,
        "code":             code,
        "graphs":           graphs,
        "dts_decls":        raw.get("dts_decls",         {}),
        "ts_morph_used":    raw.get("ts_morph_available", False),
        "ts_types":         raw.get("ts_types",           {}),
        "decorators":       graphs.get("decorators",      {}),
        "dynamic_calls":    graphs.get("dynamic_calls",   {}),
        "workspace_aliases":raw.get("workspace_aliases",  {}),
        "tsconfig_aliases": raw.get("tsconfig_aliases",   {}),
        "test_results":     tres,
    }

# ─────────────────────────────────────────────────────────────
# 10.  Instance extraction
# ─────────────────────────────────────────────────────────────

def extract_instance(
    buggy_dir: Path, fixed_dir: Path,
    instance_id: str, problem_statement: str, source_dataset: str,
    bug_type: str="", cve_id: str="", run_tests: bool=False,
) -> JSTSInstance:
    inst = JSTSInstance()
    inst.instance_id       = instance_id
    inst.problem_statement = problem_statement
    inst.source_dataset    = source_dataset
    inst.repo              = norm(str(fixed_dir))
    inst.project           = fixed_dir.name
    inst.bug_type          = bug_type
    inst.cve_id            = cve_id
    inst.test_runner       = detect_runner(fixed_dir)
    inst.module_system     = detect_module(fixed_dir)
    inst.package_manager   = detect_pkgmgr(fixed_dir)
    inst.tsconfig_present  = (fixed_dir/"tsconfig.json").exists()
    inst.language          = "typescript" if inst.tsconfig_present else "javascript"
    inst.transpiled        = inst.tsconfig_present
    inst.framework         = inst.test_runner

    print("\n[→] Analysing buggy snapshot ...")
    b = analyse(buggy_dir, run_tests=run_tests, runner=inst.test_runner)
    print("\n[→] Analysing fixed snapshot ...")
    f = analyse(fixed_dir, run_tests=run_tests, runner=inst.test_runner)
    if not b or not f: raise RuntimeError("Snapshot analysis failed")

    inst.original_code    = b["code"]
    inst.buggy_code       = "\n\n".join(b["code"].values())
    inst.block_code_buggy = inst.buggy_code
    inst.file_path        = list(b["code"].keys())
    inst.patched_code     = f["code"]
    inst.fixed_code       = "\n\n".join(f["code"].values())
    inst.block_code_fixed = inst.fixed_code
    inst.buggy_files      = [p for p in inst.file_path if b["code"].get(p)!=f["code"].get(p,"")]
    inst.patch            = make_patch(b["code"], f["code"])
    inst.dts_decls        = {**b.get("dts_decls",{}), **f.get("dts_decls",{})}
    inst.ts_morph_used    = b.get("ts_morph_used", False)
    inst.ts_types         = {**b.get("ts_types",{}), **f.get("ts_types",{})}
    inst.decorators       = {"original":b.get("decorators",{}), "patched":f.get("decorators",{})}
    inst.dynamic_calls    = {"original":b.get("dynamic_calls",{}), "patched":f.get("dynamic_calls",{})}
    inst.workspace_aliases= b.get("workspace_aliases",{})
    inst.tsconfig_aliases = b.get("tsconfig_aliases", {})
    inst.test_results_buggy = b["test_results"]
    inst.test_results_fixed = f["test_results"]
    if run_tests:
        inst.reproducible = (inst.test_results_buggy.failed>0 and
                             inst.test_results_fixed.failed==0 and
                             inst.test_results_fixed.status=="success")

    def mkgd(snap):
        g=snap["graphs"]; meta=build_meta(g,inst.test_runner)
        return {
            "file_level":{"AST":{r:pf["AST"] for r,pf in g["per_file"].items()},
                          "CFG":{r:pf["CFG"] for r,pf in g["per_file"].items()},
                          "DDG":{r:pf["DDG"] for r,pf in g["per_file"].items()},
                          "PDG":{r:pf["PDG"] for r,pf in g["per_file"].items()}},
            "enhanced":  {"enhanced_cpg":{r:pf["CPG"] for r,pf in g["per_file"].items()},
                          "global_call_graph":g["call_graph"],
                          "inter_file_dependency_graph":g["ifdg"],
                          "unified_instance_cpg":g["unified_cpg"],
                          "metadata":asdict(meta)},
        }

    inst.graphs = {"original":mkgd(b), "patched":mkgd(f)}
    inst.extraction_quality = ExtractionQuality(
        num_buggy_files      = len(b["files"]),
        num_fixed_files      = len(f["files"]),
        total_buggy_code_len = len(inst.buggy_code),
        total_fixed_code_len = len(inst.fixed_code),
        test_files_filtered  = True,
        failed_files         = len(b["graphs"].get("failed_files",[])),
    )
    return inst

# ─────────────────────────────────────────────────────────────
# 11.  Parallel processor  (fix #21 — module-level for Windows)
# ─────────────────────────────────────────────────────────────

def _process_one(args: dict) -> dict:
    """Module-level — required for Windows ProcessPoolExecutor."""
    global NODE_PATH
    NODE_PATH = args.get("node_path","")
    iid = args["instance_id"]
    t0  = time.time()
    result = {"instance_id":iid,"status":"pending"}
    try:
        inst = extract_instance(
            buggy_dir         = Path(args["buggy_dir"]),
            fixed_dir         = Path(args["fixed_dir"]),
            instance_id       = iid,
            problem_statement = args.get("problem_statement",""),
            source_dataset    = args.get("source_dataset",""),
            bug_type          = args.get("bug_type",""),
            cve_id            = args.get("cve_id",""),
            run_tests         = args.get("run_tests",False),
        )
        pkl = save_pickle(inst, Path(args["out_dir"]))
        mark_done(args["prog_dir"], iid)
        result.update(status="success",size_kb=pkl.stat().st_size//1024,
                      elapsed=round(time.time()-t0,1),reproducible=inst.reproducible)
    except Exception as e:
        mark_fail(args["prog_dir"],iid,str(e))
        result.update(status="error",error=str(e)[:400],elapsed=round(time.time()-t0,1))
        traceback.print_exc()
    return result


def process_batch(jobs,out_dir,prog_dir,max_workers=MAX_WORKERS):
    results=[]
    with concurrent.futures.ProcessPoolExecutor(max_workers=max_workers) as ex:
        futs={ex.submit(_process_one,{**j,"out_dir":out_dir,"prog_dir":prog_dir,"node_path":NODE_PATH or ""}):j["instance_id"] for j in jobs}
        for fut in concurrent.futures.as_completed(futs,timeout=INSTANCE_TIMEOUT*len(jobs)):
            iid=futs[fut]
            try:
                res=fut.result(timeout=INSTANCE_TIMEOUT); results.append(res)
                s=res.get("status","?"); e=res.get("elapsed","?"); kb=res.get("size_kb","?")
                rep=" ✓repro" if res.get("reproducible") else ""
                print(f"  [{s.upper()}] {iid}  ({e}s  {kb}KB{rep})")
            except Exception as e:
                results.append({"instance_id":iid,"status":"error","error":str(e)})
                mark_fail(prog_dir,iid,str(e)); print(f"  [ERROR] {iid}: {e}")
            check_mem()
    return results

# ─────────────────────────────────────────────────────────────
# 12.  Pickle I/O + summary
# ─────────────────────────────────────────────────────────────

def save_pickle(inst: JSTSInstance, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / f"{inst.instance_id.replace('/','__').replace(' ','_')}.pickle"
    with open(p,"wb") as fh: pickle.dump(inst,fh,protocol=pickle.HIGHEST_PROTOCOL)
    return p

def print_summary(inst: JSTSInstance, pkl: Path, elapsed=0):
    bm=inst.graphs["original"]["enhanced"]["metadata"]
    fm=inst.graphs["patched"]["enhanced"]["metadata"]
    br=inst.test_results_buggy; fr=inst.test_results_fixed
    print("\n"+"═"*68)
    print(f"  instance_id            : {inst.instance_id}")
    print(f"  language               : {inst.language}")
    print(f"  module_system          : {inst.module_system}")
    print(f"  test_runner            : {inst.test_runner}")
    print(f"  ts_morph_used          : {inst.ts_morph_used}")
    print(f"  reproducible           : {inst.reproducible}")
    print(f"  version                : {bm['version']}")
    print(f"  workspace_aliases      : {len(inst.workspace_aliases)}")
    print(f"  tsconfig_aliases       : {len(inst.tsconfig_aliases)}")
    print(f"  files    (b/f)         : {bm['total_files']} / {fm['total_files']}")
    print(f"  failed files (b/f)     : {bm['failed_files']} / {fm['failed_files']}")
    print(f"  failure audit (b)      : {bm['failure_audit']}")
    print(f"  functions (b/f)        : {bm['total_functions']} / {fm['total_functions']}")
    print(f"  classes  (b/f)         : {bm['total_classes']} / {fm['total_classes']}")
    print(f"  call sites (b/f)       : {bm['total_call_sites']} / {fm['total_call_sites']}")
    print(f"  decorators (b/f)       : {bm['total_decorators']} / {fm['total_decorators']}")
    print(f"  dynamic calls (b/f)    : {bm['total_dynamic_calls']} / {fm['total_dynamic_calls']}")
    print(f"  AST nodes (b/f)        : {bm['total_ast_nodes']} / {fm['total_ast_nodes']}")
    print(f"  CFG nodes (b/f)        : {bm['total_cfg_nodes']} / {fm['total_cfg_nodes']}")
    print(f"  DDG nodes (b/f)        : {bm['total_ddg_nodes']} / {fm['total_ddg_nodes']}")
    print(f"  PDG edges (b/f)        : {bm['total_pdg_edges']} / {fm['total_pdg_edges']}")
    print(f"  call graph (b)         : {bm['call_graph_nodes']}n / {bm['call_graph_edges']}e")
    print(f"  unified CPG (b)        : {bm['unified_cpg_nodes']}n / {bm['unified_cpg_edges']}e")
    print(f"  inter-file deps (b)    : {bm['inter_file_deps']}")
    print(f"  ICFG edges (b)         : {bm['icfg_edges']}")
    print(f"  interproc DDG (b)      : {bm['interproc_ddg_edges']}")
    print(f"  typed vars (b)         : {bm['typed_variables']}")
    print(f"  tests buggy            : {br.passed}/{br.total} ({br.status})")
    print(f"  tests fixed            : {fr.passed}/{fr.total} ({fr.status})")
    print(f"  buggy files changed    : {len(inst.buggy_files)}")
    print(f"  patch lines            : {len(inst.patch.splitlines())}")
    if elapsed: print(f"  extraction time        : {elapsed:.1f}s")
    print(f"  pickle size            : {pkl.stat().st_size/1024:.1f} KB")
    print(f"  saved to               : {pkl}")
    print("═"*68)

def auto_restart(remaining: int):
    if AUTO_RESTART and remaining > 0:
        print(f"\n[AUTO-RESTART] {remaining} remaining ...")
        sys.stdout.flush()
        os.execv(sys.executable, [sys.executable]+sys.argv)

# ─────────────────────────────────────────────────────────────
# 13.  Sample repos
# ─────────────────────────────────────────────────────────────

BUGGY_FILES = {
    "src/base.js": textwrap.dedent("""\
        'use strict';
        class Animal {
          #name;
          constructor(name) { this.#name = name; }
          speak() { return `${this.#name} makes a noise.`; }
        }
        class Dog extends Animal {
          speak() { return `${this.#name} barks.`; }
        }
        Animal.prototype.breathe = function() { return 'breathing'; };
        module.exports = { Animal, Dog };
    """),
    "src/utils.js": textwrap.dedent("""\
        'use strict';
        const config = require('./config');
        function getUserById(users, id) {
          return users.find(u => u.id == id);         // BUG: loose ==
        }
        function formatUser(user) {
          return `${user.name} <${user.email}>`;      // BUG: no null guard
        }
        async function fetchUser(id) {
          const user = await getUserById([], id);
          return formatUser(user);
        }
        function* userGen(users) { for (const u of users) yield u; }
        function filterActive(users) {
          return users.filter(u => u.active = true);  // BUG: assignment
        }
        exports.getUserById    = getUserById;
        exports.formatUser     = formatUser;
        exports.fetchUser      = fetchUser;
        exports.userGen        = userGen;
        exports.filterActive   = filterActive;
    """),
    "src/config.js": "module.exports = { maxUsers: 100 };\n",
    "src/index.js": textwrap.dedent("""\
        'use strict';
        const { getUserById, formatUser, filterActive } = require('./utils');
        const { Dog } = require('./base');
        const users = [
          { id:1, name:'Alice', email:'alice@example.com', active:true },
          { id:2, name:'Bob',   email:'bob@example.com',   active:false },
        ];
        const d = new Dog('Rex');
        console.log(d.speak());
        Promise.resolve(getUserById(users,'1')).then(u=>formatUser(u)).catch(console.error);
        console.log(filterActive(users));
    """),
    "types/index.d.ts": textwrap.dedent("""\
        export interface User { id:number; name:string; email:string; active:boolean; }
        export declare function getUserById(users: User[], id: string|number): User|null;
        export declare function formatUser(user: User|null): string;
        export declare function filterActive(users: User[]): User[];
    """),
    "package.json": json.dumps({"name":"sample-bug","version":"1.0.0",
        "scripts":{"test":"jest"},"devDependencies":{"jest":"^29.0.0"}},indent=2),
}

FIXED_FILES = {
    **BUGGY_FILES,
    "src/utils.js": textwrap.dedent("""\
        'use strict';
        const config = require('./config');
        function getUserById(users, id) {
          const user = users.find(u => u.id === Number(id));   // FIX
          return user ?? null;
        }
        function formatUser(user) {
          if (!user) return 'Unknown user';                    // FIX
          return `${user.name} <${user.email}>`;
        }
        async function fetchUser(id) {
          const user = await getUserById([], id);
          return formatUser(user);
        }
        function* userGen(users) { for (const u of users) yield u; }
        function filterActive(users) {
          return users.filter(u => u.active === true);         // FIX
        }
        exports.getUserById    = getUserById;
        exports.formatUser     = formatUser;
        exports.fetchUser      = fetchUser;
        exports.userGen        = userGen;
        exports.filterActive   = filterActive;
    """),
}

def write_repo(base: Path, files: dict):
    for rel,content in files.items():
        p=base/rel; p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text(content,encoding="utf-8")

def load_csv(csv_path: str, max_n: int=0) -> list:
    import csv
    rows=[]
    with open(csv_path,newline="",encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows.append(row)
            if max_n and len(rows)>=max_n: break
    return rows

# ─────────────────────────────────────────────────────────────
# 14.  Entry point  (fix #21: freeze_support + module-level guard)
# ─────────────────────────────────────────────────────────────

def main():
    import tempfile
    # fix #21: required on Windows for ProcessPoolExecutor spawn
    multiprocessing.freeze_support()

    ap=argparse.ArgumentParser(description="JS/TS Extractor v6")
    ap.add_argument("--dataset",       default=None)
    ap.add_argument("--base-dir",      default=".")
    ap.add_argument("--output-dir",    default="output")
    ap.add_argument("--max-instances", type=int, default=0)
    ap.add_argument("--workers",       type=int, default=MAX_WORKERS)
    ap.add_argument("--run-tests",     action="store_true")
    ap.add_argument("--no-restart",    action="store_true")
    args=ap.parse_args()

    global AUTO_RESTART, MAX_WORKERS
    if args.no_restart: AUTO_RESTART=False
    MAX_WORKERS=args.workers

    print("── JS/TS Pickle Extractor v6 (all 24 issues fixed) ────")
    check_node()  # fix #24: version check inside

    print("\nChecking Node.js packages:")
    print("  Tip: pin with  npm install -g @babel/parser@7")
    missing=[p for p in ["@babel/parser"] if not check_npm(p,required=True)]
    check_npm("ts-morph",required=False)
    if missing: print(f"\nInstall:  npm install -g {' '.join(missing)}"); sys.exit(1)
    if not check_bridge(): sys.exit(1)
    print(f"[{'✓' if PSUTIL_OK else '!'}] psutil {'enabled' if PSUTIL_OK else 'not found — pip install psutil'}")

    if args.dataset:
        od=args.output_dir; pd=od; Path(od).mkdir(parents=True,exist_ok=True)
        rows=load_csv(args.dataset,args.max_instances)
        print(f"\nLoaded {len(rows)} instances")
        pr=load_prog(pd)
        done=set(pr.get("processed_instances",[]))
        fails=set(e if isinstance(e,str) else e.get("id") for e in pr.get("failed_instances",[]))
        exist={f.stem for f in Path(od).glob("*.pickle")}
        all_done=done|exist|fails
        rem=[r for r in rows if str(r.get("instance_id","")) not in all_done]
        print(f"Remaining: {len(rem)}")
        if not rem: print("All done!"); return
        base=Path(args.base_dir)
        jobs=[{"instance_id":str(r.get("instance_id","")),"buggy_dir":str(base/"buggy"/str(r.get("instance_id",""))),"fixed_dir":str(base/"fixed"/str(r.get("instance_id",""))),"problem_statement":r.get("problem_statement",""),"source_dataset":r.get("source_dataset",""),"bug_type":r.get("bug_type",""),"cve_id":r.get("cve_id",""),"run_tests":args.run_tests} for r in rem]
        t0=time.time(); results=process_batch(jobs,od,pd,MAX_WORKERS); elapsed=time.time()-t0
        ok=sum(1 for r in results if r.get("status")=="success")
        repro=sum(1 for r in results if r.get("reproducible"))
        print(f"\nBatch: {ok}/{len(results)} ok  {repro} reproducible  ({elapsed:.1f}s)")
        print(f"Memory: {get_mem():.1f} GB")
        auto_restart(len(rem)-len(results))
        return

    # Demo mode
    with tempfile.TemporaryDirectory() as tmp:
        tmp=Path(tmp); buggy=tmp/"buggy"; fixed=tmp/"fixed"
        print("\n[→] Writing sample repo ...")
        write_repo(buggy,BUGGY_FILES); write_repo(fixed,FIXED_FILES)
        t0=time.time()
        inst=extract_instance(
            buggy_dir=buggy, fixed_dir=fixed,
            instance_id="sample-bug__utils-v6",
            problem_statement="getUserById loose ==; formatUser null crash; filterActive assignment bug",
            source_dataset="sample", bug_type="logic",
            run_tests=args.run_tests,
        )
        elapsed=time.time()-t0

    out=Path("output"); pkl=save_pickle(inst,out)
    print_summary(inst,pkl,elapsed)

    with open(pkl,"rb") as fh: loaded=pickle.load(fh)
    assert loaded.instance_id==inst.instance_id
    assert "PDG" in loaded.graphs["original"]["file_level"]
    print("\n[✓] Pickle verified — PDG present, load OK")


if __name__ == "__main__":
    main()
