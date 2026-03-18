#!/usr/bin/env python3
"""Compare graph structures between two pickle formats."""

import pickle
import sys
from pathlib import Path

def inspect_any_pickle(pkl_path):
    """Inspect a pickle file and show its structure."""
    print(f"\n{'='*70}")
    print(f"Inspecting: {pkl_path}")
    print(f"File size: {Path(pkl_path).stat().st_size / 1024 / 1024:.2f} MB")
    print(f"{'='*70}")

    with open(pkl_path, "rb") as f:
        data = pickle.load(f)

    print(f"\nType: {type(data).__name__}")

    if hasattr(data, '__dict__'):
        print(f"\nAttributes ({len(data.__dict__)} total):")
        for key, value in data.__dict__.items():
            val_type = type(value).__name__
            if isinstance(value, dict):
                print(f"  {key}: dict with {len(value)} keys")
                if len(value) <= 10:
                    for k, v in list(value.items())[:5]:
                        print(f"    - {k}: {type(v).__name__}")
            elif isinstance(value, list):
                print(f"  {key}: list with {len(value)} items")
            elif isinstance(value, str):
                print(f"  {key}: str ({len(value)} chars) = {value[:100]}...")
            elif hasattr(value, 'number_of_nodes'):
                print(f"  {key}: Graph with {value.number_of_nodes()} nodes, {value.number_of_edges()} edges")
            else:
                print(f"  {key}: {val_type} = {str(value)[:100]}")
    elif isinstance(data, dict):
        print(f"\nDict keys ({len(data)} total):")
        for key, value in data.items():
            val_type = type(value).__name__
            if isinstance(value, dict):
                print(f"  {key}: dict with {len(value)} keys")
            elif isinstance(value, list):
                print(f"  {key}: list with {len(value)} items")
            elif hasattr(value, 'number_of_nodes'):
                print(f"  {key}: Graph with {value.number_of_nodes()} nodes, {value.number_of_edges()} edges")
            else:
                print(f"  {key}: {val_type}")

    return data


def explore_graphs(data, prefix=""):
    """Recursively explore graph structures."""
    if hasattr(data, 'number_of_nodes'):
        print(f"{prefix}Graph: {data.number_of_nodes()} nodes, {data.number_of_edges()} edges")
        # Sample some nodes
        nodes = list(data.nodes(data=True))[:3]
        if nodes:
            print(f"{prefix}  Sample nodes:")
            for nid, attrs in nodes:
                print(f"{prefix}    {nid}: {dict(list(attrs.items())[:5])}")
        # Sample some edges
        edges = list(data.edges(data=True))[:3]
        if edges:
            print(f"{prefix}  Sample edges:")
            for src, dst, attrs in edges:
                print(f"{prefix}    {src} -> {dst}: {dict(list(attrs.items())[:5])}")
        return

    if isinstance(data, dict):
        for key, value in data.items():
            if hasattr(value, 'number_of_nodes') or isinstance(value, dict):
                print(f"{prefix}{key}:")
                explore_graphs(value, prefix + "  ")


def main():
    # Inspect the cookiecutter pickle
    cc_path = r"C:\Users\Lenovo\Downloads\cookiecutter_bugcookiecutter-4_unified.pkl"
    cc_data = inspect_any_pickle(cc_path)

    print("\n" + "="*70)
    print("GRAPH STRUCTURE EXPLORATION")
    print("="*70)

    # Explore graphs in the cookiecutter pickle
    if hasattr(cc_data, 'graphs'):
        print("\nGraphs in cookiecutter pickle:")
        explore_graphs(cc_data.graphs)
    elif isinstance(cc_data, dict) and 'graphs' in cc_data:
        print("\nGraphs in cookiecutter pickle:")
        explore_graphs(cc_data['graphs'])
    else:
        print("\nExploring top-level structure:")
        explore_graphs(cc_data)

    # Compare with our Express-1 pickle
    print("\n" + "="*70)
    print("COMPARISON WITH EXPRESS-1")
    print("="*70)

    express_path = Path(__file__).parent / "bugsjs_test" / "output" / "Express-1.pickle"
    if express_path.exists():
        # Use custom unpickler for our format
        from dataclasses import dataclass, field

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

        class CustomUnpickler(pickle.Unpickler):
            def find_class(self, module, name):
                if module in ("__mp_main__", "__main__"):
                    if name == "JSTSInstance":
                        return JSTSInstance
                    if name == "TestResults":
                        return TestResults
                    if name == "ExtractionQuality":
                        return ExtractionQuality
                return super().find_class(module, name)

        with open(express_path, "rb") as f:
            express_data = CustomUnpickler(f).load()

        print("\nGraphs in Express-1 pickle:")
        explore_graphs(express_data.graphs)


if __name__ == "__main__":
    main()
