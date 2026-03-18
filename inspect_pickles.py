#!/usr/bin/env python3
"""Inspect BugsJS extraction results."""

import pickle
import sys
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

# Define the dataclasses that match the pickled objects
@dataclass
class TestResults:
    status: str = "not_run"
    runner: str = "unknown"
    total: int = 0
    passed: int = 0
    failed: int = 0
    pass_rate: float = 0.0
    failing_tests: list = field(default_factory=list)
    error: str = ""
    duration_ms: int = 0

@dataclass
class ExtractionQuality:
    issues: list = field(default_factory=list)
    num_buggy_files: int = 0
    num_fixed_files: int = 0
    total_buggy_code_len: int = 0
    total_fixed_code_len: int = 0
    test_files_filtered: bool = True
    failed_files: int = 0

@dataclass
class GraphMetadata:
    framework: str = ""
    version: str = ""
    total_files: int = 0
    total_functions: int = 0
    total_classes: int = 0
    total_call_sites: int = 0
    total_ast_nodes: int = 0
    total_cfg_nodes: int = 0
    total_ddg_nodes: int = 0
    total_pdg_edges: int = 0
    call_graph_nodes: int = 0
    call_graph_edges: int = 0
    inter_file_deps: int = 0
    unified_cpg_nodes: int = 0
    unified_cpg_edges: int = 0
    typed_variables: int = 0
    icfg_edges: int = 0
    interproc_ddg_edges: int = 0
    icfg_enhanced: bool = True
    interprocedural_ddg: bool = True
    total_decorators: int = 0
    total_dynamic_calls: int = 0
    failed_files: int = 0
    workspace_aliases: dict = field(default_factory=dict)
    tsconfig_aliases: dict = field(default_factory=dict)
    failure_audit: dict = field(default_factory=dict)

@dataclass
class JSTSInstance:
    instance_id: str = ""
    problem_statement: str = ""
    repo: str = ""
    source_dataset: str = ""
    file_path: list = field(default_factory=list)
    buggy_files: list = field(default_factory=list)
    original_code: dict = field(default_factory=dict)
    patched_code: dict = field(default_factory=dict)
    buggy_code: str = ""
    fixed_code: str = ""
    block_code_buggy: str = ""
    block_code_fixed: str = ""
    patch: str = ""
    graphs: dict = field(default_factory=dict)
    bug_type: str = ""
    cve_id: str = ""
    project: str = ""
    extraction_quality: ExtractionQuality = field(default_factory=ExtractionQuality)
    framework: str = ""
    language: str = "javascript"
    module_system: str = "unknown"
    test_runner: str = "unknown"
    package_manager: str = "npm"
    tsconfig_present: bool = False
    type_errors_fixed: bool = False
    transpiled: bool = False
    dts_decls: dict = field(default_factory=dict)
    ts_morph_used: bool = False
    ts_types: dict = field(default_factory=dict)
    decorators: dict = field(default_factory=dict)
    dynamic_calls: dict = field(default_factory=dict)
    workspace_aliases: dict = field(default_factory=dict)
    tsconfig_aliases: dict = field(default_factory=dict)
    test_results_buggy: TestResults = field(default_factory=TestResults)
    test_results_fixed: TestResults = field(default_factory=TestResults)
    reproducible: bool = False

# Handle multiprocessing pickle issue
import types
class CustomUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module == "__mp_main__" or module == "__main__":
            # Return our local classes
            if name == "JSTSInstance":
                return JSTSInstance
            if name == "TestResults":
                return TestResults
            if name == "ExtractionQuality":
                return ExtractionQuality
            if name == "GraphMetadata":
                return GraphMetadata
        return super().find_class(module, name)

def inspect_pickle(pkl_path):
    with open(pkl_path, "rb") as f:
        inst = CustomUnpickler(f).load()

    print(f"\n{'='*70}")
    print(f"Instance: {inst.instance_id}")
    print(f"{'='*70}")
    print(f"  Language:          {inst.language}")
    print(f"  Module System:     {inst.module_system}")
    print(f"  Test Runner:       {inst.test_runner}")
    print(f"  Problem Statement: {inst.problem_statement[:80]}...")

    # Buggy vs Fixed files
    print(f"\n  Source Files:")
    print(f"    Total files:     {len(inst.file_path)}")
    print(f"    Buggy files:     {len(inst.buggy_files)}")
    for f in inst.buggy_files[:5]:
        print(f"      - {f}")

    # Patch info
    print(f"\n  Patch:")
    print(f"    Lines:           {len(inst.patch.splitlines())}")

    # Show a snippet of the patch
    patch_lines = inst.patch.splitlines()[:20]
    print("    Preview:")
    for line in patch_lines:
        print(f"      {line[:80]}")

    # Graph stats
    bg = inst.graphs["original"]["enhanced"]["metadata"]
    fg = inst.graphs["patched"]["enhanced"]["metadata"]

    print(f"\n  Graph Statistics:")
    print(f"    {'Metric':<25} {'Buggy':>10} {'Fixed':>10}")
    print(f"    {'-'*25} {'-'*10} {'-'*10}")
    print(f"    {'Total files':<25} {bg['total_files']:>10} {fg['total_files']:>10}")
    print(f"    {'Total functions':<25} {bg['total_functions']:>10} {fg['total_functions']:>10}")
    print(f"    {'Total classes':<25} {bg['total_classes']:>10} {fg['total_classes']:>10}")
    print(f"    {'AST nodes':<25} {bg['total_ast_nodes']:>10} {fg['total_ast_nodes']:>10}")
    print(f"    {'CFG nodes':<25} {bg['total_cfg_nodes']:>10} {fg['total_cfg_nodes']:>10}")
    print(f"    {'DDG nodes':<25} {bg['total_ddg_nodes']:>10} {fg['total_ddg_nodes']:>10}")
    print(f"    {'PDG edges':<25} {bg['total_pdg_edges']:>10} {fg['total_pdg_edges']:>10}")
    print(f"    {'Call graph nodes':<25} {bg['call_graph_nodes']:>10} {fg['call_graph_nodes']:>10}")
    print(f"    {'Call graph edges':<25} {bg['call_graph_edges']:>10} {fg['call_graph_edges']:>10}")
    print(f"    {'Unified CPG nodes':<25} {bg['unified_cpg_nodes']:>10} {fg['unified_cpg_nodes']:>10}")
    print(f"    {'Unified CPG edges':<25} {bg['unified_cpg_edges']:>10} {fg['unified_cpg_edges']:>10}")
    print(f"    {'Inter-file deps':<25} {bg['inter_file_deps']:>10} {fg['inter_file_deps']:>10}")
    print(f"    {'ICFG edges':<25} {bg['icfg_edges']:>10} {fg['icfg_edges']:>10}")

    # Show file-level graphs available
    print(f"\n  Available Graph Types:")
    file_graphs = inst.graphs["original"]["file_level"]
    for graph_type in file_graphs:
        count = len(file_graphs[graph_type])
        print(f"    - {graph_type}: {count} files")

    enhanced = inst.graphs["original"]["enhanced"]
    for graph_name in enhanced:
        if graph_name != "metadata":
            if hasattr(enhanced[graph_name], 'number_of_nodes'):
                print(f"    - {graph_name}: {enhanced[graph_name].number_of_nodes()} nodes, {enhanced[graph_name].number_of_edges()} edges")

    return inst


def main():
    output_dir = Path(__file__).parent / "bugsjs_test" / "output"

    pickles = list(output_dir.glob("*.pickle"))
    print(f"Found {len(pickles)} pickle files in {output_dir}")

    for pkl in sorted(pickles):
        if pkl.name.startswith("Express"):
            inspect_pickle(pkl)


if __name__ == "__main__":
    main()
