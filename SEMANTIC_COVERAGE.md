# JavaScript/TypeScript Semantic Coverage Analysis

## Currently Captured

### AST (Abstract Syntax Tree)
| Feature | Status | Notes |
|---------|--------|-------|
| All Babel node types | FULL | Complete AST from @babel/parser |
| Location info | FULL | line, column, end_line, end_column |
| Parent-child edges | FULL | AST edge_type |
| Node labels | FULL | type field |

### CFG (Control Flow Graph)
| Feature | Status | Notes |
|---------|--------|-------|
| Function entry/exit | FULL | ENTRY/EXIT synthetic nodes |
| If/else branching | FULL | condition=true/false labels |
| For loops | FULL | ForStatement, ForInStatement, ForOfStatement |
| While/do-while | FULL | WhileStatement, DoWhileStatement |
| Switch/case | FULL | SWITCH_JOIN nodes |
| Try/catch/finally | FULL | TRY, CATCH, FINALLY nodes |
| Break/continue | FULL | edge_label=break/continue |
| Return/throw | FULL | Edges to EXIT |
| Labeled statements | FULL | LABEL_JOIN nodes |
| Optional chaining | FULL | OPT_JOIN with nullish_skip |
| Async/await | PARTIAL | await_suspend edges |
| Generator yield | PARTIAL | yield/yield_resume edges |
| **Short-circuit operators** | **FULL** | **LogicalLeft/LogicalRight/LOGICAL_JOIN nodes** |
| **Ternary expressions** | **FULL** | **TernaryTest/TernaryTrue/TernaryFalse/TERNARY_JOIN nodes** |

### DDG (Data Dependency Graph)
| Feature | Status | Notes |
|---------|--------|-------|
| Variable definitions | FULL | ASSIGN_TARGET nodes |
| Variable uses | FULL | VAR_USE nodes |
| Reaching definitions | FULL | USE/USE_ALT edges |
| var hoisting | FULL | Two-pass hoisting |
| Destructuring (basic) | PARTIAL | Extracts bound names |
| with statement | PARTIAL | Tagged as with_scope |
| eval detection | PARTIAL | Marks scope as eval_polluted |
| **Property writes** | **FULL** | **PROPERTY_WRITE nodes for obj.prop = value** |
| **Property reads** | **FULL** | **PROPERTY_READ nodes for x = obj.prop** |
| **Property flow** | **FULL** | **PROPERTY_FLOW edges linking writes to reads** |
| **Closure capture** | **FULL** | **CLOSURE_CAPTURE nodes and edges** |
| **Exception throw** | **FULL** | **EXCEPTION_THROW nodes** |
| **Exception catch** | **FULL** | **EXCEPTION_CATCH nodes** |
| **Exception flow** | **FULL** | **EXCEPTION_FLOW edges from throw to catch** |
| **Conditional values** | **FULL** | **CONDITIONAL_VALUE nodes for &&/\|\|/?:** |
| **Destructure targets** | **FULL** | **DESTRUCTURE_TARGET nodes with property mapping** |
| **Destructure flow** | **FULL** | **DESTRUCTURE_FLOW edges** |

### PDG (Program Dependence Graph)
| Feature | Status | Notes |
|---------|--------|-------|
| Control dependence | FULL | Post-dominator based |
| Data dependence | FULL | From DDG edges |
| Back-edge detection | FULL | RPO-based |
| **Conditional control** | **FULL** | **PDG_CONDITIONAL for short-circuit paths** |
| **Ternary true branch** | **FULL** | **PDG_TERNARY_TRUE edges** |
| **Ternary false branch** | **FULL** | **PDG_TERNARY_FALSE edges** |

### Call Graph
| Feature | Status | Notes |
|---------|--------|-------|
| Function definitions | FULL | Named/anonymous functions |
| Direct calls | FULL | foo(), obj.method() |
| Computed methods | PARTIAL | obj[expr]() tracked as dynamic |
| Promise chains | PARTIAL | then/catch/finally handlers |
| Event handlers | PARTIAL | on/addEventListener tracked |
| Cross-file resolution | FULL | Via ModResolver |

### Cross-File Analysis
| Feature | Status | Notes |
|---------|--------|-------|
| ES6 imports | FULL | import/export |
| CommonJS require | FULL | require() calls |
| Re-exports | FULL | export * from, export { x } from |
| Workspace aliases | FULL | yarn/npm workspaces |
| tsconfig paths | FULL | paths: {} mappings |
| ICFG edges | FULL | ICFG_CALL/ICFG_RETURN |
| Cross-file DDG | FULL | CROSS_FILE_DDG |

### TypeScript-Specific
| Feature | Status | Notes |
|---------|--------|-------|
| Type annotations | PARTIAL | Via ts-morph |
| Namespaces | FULL | TSModuleDeclaration |
| Decorators | FULL | Extracted with args |
| .d.ts files | PARTIAL | Collected but not analyzed |

---

## New Node Types (v6 Enhanced)

### DDG Nodes
| Node Type | Purpose | Fields |
|-----------|---------|--------|
| PROPERTY_WRITE | `obj.prop = value` assignment | object_name, property_name |
| PROPERTY_READ | `x = obj.prop` read | object_name, property_name |
| CLOSURE_CAPTURE | Variable captured from outer scope | var_name, captured_from_depth, captured_to_depth |
| EXCEPTION_THROW | `throw expr` | line |
| EXCEPTION_CATCH | `catch(e)` parameter | param_name |
| CONDITIONAL_VALUE | Short-circuit/ternary conditional value | operator (&&, \|\|, ??, ternary_true, ternary_false) |
| DESTRUCTURE_TARGET | Destructuring binding target | target_name, source_name, source_prop |

### CFG Nodes
| Node Type | Purpose | Fields |
|-----------|---------|--------|
| LogicalLeft | Left operand of `&&`/`\|\|`/`??` | operator |
| LogicalRight | Right operand of `&&`/`\|\|`/`??` | operator |
| LOGICAL_JOIN | Merge point after logical expression | operator |
| TernaryTest | Test condition of `?:` | - |
| TernaryTrue | Consequent of `?:` | - |
| TernaryFalse | Alternate of `?:` | - |
| TERNARY_JOIN | Merge point after ternary | - |

## New Edge Types (v6 Enhanced)

### DDG Edges
| Edge Type | Purpose | Fields |
|-----------|---------|--------|
| PROPERTY_FLOW | Property write -> property read | object_name, property_name |
| CLOSURE_CAPTURE | Outer scope def -> inner scope use | var_name, captured_from_depth, captured_to_depth |
| EXCEPTION_FLOW | throw -> catch parameter | throw_line, catch_line |
| CONDITIONAL_USE | Conditionally reached use | operator, condition_line |
| DESTRUCTURE_FLOW | Property read -> destructure target | target_name, source_name, source_prop |

### PDG Edges
| Edge Type | Purpose | Fields |
|-----------|---------|--------|
| PDG_CONDITIONAL | Short-circuit control dependency | short_circuit: true |
| PDG_TERNARY_TRUE | Ternary true-branch control dep | ternary_branch: 'consequent' |
| PDG_TERNARY_FALSE | Ternary false-branch control dep | ternary_branch: 'alternate' |

### CFG Edges (Enhanced)
| Edge Property | Purpose |
|---------------|---------|
| short_circuit: true | Marks edges that skip evaluation |
| ternary_branch: 'consequent'/'alternate' | Marks ternary branch edges |

---

## Remaining Gaps

### Medium Priority

1. **Array Element Data Flow**
   - `arr[i] = value` -> `x = arr[j]` flow not tracked
   - Need: ARRAY_WRITE/ARRAY_READ nodes

2. **Spread Operator Data Flow**
   - `{...obj}` / `[...arr]` data flow missing
   - Need: SPREAD_SOURCE edges

3. **Getter/Setter Invocations**
   - `obj.prop` may invoke getter
   - `obj.prop = x` may invoke setter
   - Need: ACCESSOR_CALL edges

4. **Promise Async Data Flow**
   - `await p` -> resolved value flow
   - `p.then(x => ...)` callback parameter flow
   - Need: ASYNC_RESOLVE edges

5. **Generator Value Flow**
   - `yield value` -> `gen.next().value`
   - Need: GENERATOR_YIELD edges

6. **Template Literal Expressions**
   - `` `${expr}` `` expression data flow
   - Need to track interpolated values

7. **Class Field Initializers**
   - `class { field = expr }` initialization flow
   - Need: FIELD_INIT edges

8. **Private Fields**
   - `#field` access tracking
   - Currently tracked but not connected to class scope

### Lower Priority

9. **Symbol Property Access**
    - `obj[Symbol.iterator]` tracking
    - Complex due to runtime nature

10. **Proxy Trap Invocations**
    - `new Proxy()` handler trap calls
    - Very dynamic, hard to static analyze

11. **Computed Property Names**
    - `{ [expr]: value }` object literals
    - Dynamic key resolution

12. **Tagged Template Literals**
    - `` tag`string` `` function call semantics
    - Need: TAG_TEMPLATE_CALL edges

13. **Import.meta**
    - `import.meta.url` etc.
    - ESM-specific metadata

---

## Estimated Impact of v6 Enhancements

Based on typical JavaScript codebase analysis:

| Enhancement | Estimated New Nodes/Edges | Common Patterns |
|-------------|---------------------------|-----------------|
| Property accesses | ~5000+ nodes | obj.prop reads/writes |
| Closure captures | ~500+ edges | callbacks, middleware |
| Short-circuit | ~200+ paths | `a && b`, `a \|\| default` |
| Ternary flow | ~50+ paths | `cond ? a : b` |
| Exception flow | ~100+ edges | try/catch handlers |
| Destructuring | ~300+ nodes | `const {a, b} = obj` |

**Total estimated increase: ~20-30% more semantic information captured**
