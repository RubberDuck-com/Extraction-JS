# Graph Generation Comparison: Cookiecutter (Python) vs Express (JS)

## Key Structural Differences

### 1. Node Count Relationships

| File | Graph Type | Cookiecutter (Python) | Express-1 (JS) |
|------|------------|----------------------|----------------|
| setup.py / lib/router/index.js | AST | 587 | - |
| | CFG | 652 | - |
| | DDG | 306 | - |
| | Enhanced CPG | **893** | - |
| **Whole Project** | AST | ~9,000 | 57,145 |
| | CFG | ~10,200 | 5,202 |
| | Unified CPG | **~15,000** | **57,145** (same as AST!) |

**Problem Identified**: In the JS extractor, `Unified CPG nodes == AST nodes`, meaning CFG synthetic nodes are not being added as separate entities.

### 2. CFG Node Types

**Cookiecutter (Python)** - CFG has unique nodes:
```
ENTRY node: {'label': 'ENTRY', 'type': 'entry', 'line': 1}
Import node: {'label': 'import os', 'type': 'import', 'line': 3}
```
CFG nodes include: ENTRY, EXIT, imports, assignments, control flow statements with unique IDs.

**Express (JS)** - CFG reuses AST IDs:
```javascript
// In analysis_bridge_v6.js line 406-412:
_n(label, type, an) {
  const id = an ? (this.nm.get(an) ?? nid()) : nid();  // Reuses AST node ID!
}
```

### 3. DDG Structure

**Cookiecutter (Python)**:
- Separate DDG nodes with types: `ASSIGN_TARGET`, `ASSIGN_VALUE`, `RETURN_VALUE`
- Edge types: `ASSIGN`, `USE`, `RETURN_USE`, `DDG`
- DDG has its OWN node set (different from AST)

**Express (JS)**:
- DDG reuses CFG nodes
- Edge types: `REACHING_DEF`, `REACHING_DEF_ALT`
- No separate DDG nodes

### 4. Enhanced/Unified CPG

**Cookiecutter (Python)**:
```
enhanced_cpg:
  - Nodes have: sources: ['AST', 'CFG', 'DDG'], ast_id: X
  - Edge types: 'AST+CFG+DDG' (combined)
  - Node count > AST (includes CFG-only and DDG-only nodes)
```

**Express (JS)**:
```
unified_cpg:
  - Nodes have: sources: ['ast'] or ['ast', 'cfg']
  - CPG node count == AST node count (no additional nodes)
```

## Root Cause Analysis

### Why JS CPG == AST?

1. **CFG Builder reuses AST IDs** (line 406-412 in analysis_bridge_v6.js):
   - When building CFG, it looks up the AST node in `nodeIdMap`
   - If found, reuses the AST node's ID instead of creating new
   - ENTRY/EXIT/JOIN nodes are created with AST nodes as reference

2. **buildCPG merges instead of union** (line 961-985):
   - Starts with all AST nodes
   - For each CFG node, if ID exists in AST, just updates `sources` array
   - Only adds CFG nodes if ID doesn't exist (rare due to #1)

### Expected Behavior (like Python extractor)

The Unified CPG should have:
```
CPG_nodes = AST_nodes ∪ CFG_synthetic_nodes ∪ DDG_synthetic_nodes
```

Where:
- `CFG_synthetic_nodes` = ENTRY, EXIT, JOIN, CATCH, FINALLY nodes
- `DDG_synthetic_nodes` = Variable definition/use tracking nodes

## Recommendations

### Fix 1: Generate Unique IDs for Synthetic CFG Nodes
```javascript
// In CFGBuilder._n():
_n(label, type, an) {
  // For synthetic nodes (ENTRY, EXIT, JOIN, etc), always generate new ID
  const syntheticTypes = new Set(['ENTRY', 'EXIT', 'JOIN', 'CATCH', 'FINALLY', ...]);
  if (syntheticTypes.has(type)) {
    const id = nid();  // Always new ID for synthetic
    // ...
    return id;
  }
  // For statement nodes, reuse AST ID
  const id = an ? (this.nm.get(an) ?? nid()) : nid();
  // ...
}
```

### Fix 2: Add DDG-specific Nodes
Currently DDG only has edges between existing nodes. Should add:
- Variable definition nodes
- Variable use nodes
- Data flow tracking nodes

### Fix 3: Proper CPG Merging
```javascript
function buildCPG(astN, astE, cfgN, cfgE, ddgN, ddgE) {
  const unified = new Map();

  // Add ALL AST nodes
  for (const n of astN) unified.set(n.id, {...n, sources: ['AST']});

  // Add ALL CFG nodes (even if some share IDs)
  for (const n of cfgN) {
    if (unified.has(n.id)) {
      unified.get(n.id).sources.push('CFG');
    } else {
      unified.set(n.id, {...n, sources: ['CFG']});  // NEW nodes from CFG
    }
  }

  // Add ALL DDG nodes
  for (const n of ddgN) {
    if (unified.has(n.id)) {
      unified.get(n.id).sources.push('DDG');
    } else {
      unified.set(n.id, {...n, sources: ['DDG']});  // NEW nodes from DDG
    }
  }
}
```

## Summary

| Aspect | Cookiecutter (Correct) | Express (Bug) |
|--------|----------------------|---------------|
| CPG vs AST ratio | CPG > AST (~1.5x) | CPG == AST |
| CFG synthetic nodes | Unique IDs | Reuse AST IDs |
| DDG nodes | Separate set | No DDG nodes |
| Edge diversity | AST, CFG, DDG, PDG | Mostly AST |
