#!/usr/bin/env python3
"""Checks that every DLL the Windows runtime imports can load on a clean PC.

Walks the .exe/.dll/.pyd files under the given directories, reads their PE
import tables, and resolves each imported DLL the way Windows does for the
bundled Python: next to the module, next to python.exe, in delvewheel's
``*.libs`` folders, or in System32. The Visual C++ runtime (msvcp140,
vcruntime140, vcomp140 ...) must be bundled: a clean Windows installation
does not have it, and this machine's copy in System32 does not count.

    python runtime/check-windows-dlls.py runtime/build/windows-x64/resources/python engine/target/release/docflow-engine.exe

Exit code 1 lists the modules whose imports would fail to load.
"""

from __future__ import annotations

import os
import struct
import sys
from pathlib import Path

VC_RUNTIME = (
    "vcruntime140", "vcruntime140_1", "vcruntime140_threads", "msvcp140", "msvcp140_1", "msvcp140_2",
    "msvcp140_atomic_wait", "msvcp140_codecvt_ids", "concrt140", "vcomp140", "vccorlib140",
)
SYSTEM32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"


def pe_imports(path: Path) -> tuple[list[str], list[str]]:
    """(imports, delay-loaded imports) of a PE file."""
    data = path.read_bytes()
    if data[:2] != b"MZ":
        return [], []
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        return [], []
    sections, optional_size = struct.unpack_from("<H12xH", data, pe + 6)
    optional = pe + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    directories = optional + (112 if magic == 0x20B else 96)
    table = optional + optional_size

    def offset(rva: int) -> int | None:
        for index in range(sections):
            base = table + index * 40
            virtual_size, virtual_address, raw_size, raw_pointer = struct.unpack_from("<IIII", data, base + 8)
            if virtual_address <= rva < virtual_address + max(virtual_size, raw_size):
                return rva - virtual_address + raw_pointer
        return None

    def name_at(rva: int) -> str:
        start = offset(rva)
        if start is None:
            return ""
        end = data.index(b"\0", start)
        return data[start:end].decode("ascii", "replace")

    def walk(directory: int, entry_size: int, name_field: int) -> list[str]:
        rva, size = struct.unpack_from("<II", data, directories + directory * 8)
        start = offset(rva) if rva else None
        names = []
        while start is not None and size:
            name_rva = struct.unpack_from("<I", data, start + name_field)[0]
            if name_rva == 0:
                break
            names.append(name_at(name_rva))
            start += entry_size
        return names

    return walk(1, 20, 12), walk(13, 32, 4)


def main() -> int:
    targets = [Path(argument).resolve() for argument in sys.argv[1:]]
    if not targets:
        print(__doc__)
        return 2
    modules = []
    for target in targets:
        if target.is_file():
            modules.append(target)
        else:
            modules += [path for path in target.rglob("*") if path.suffix.lower() in {".dll", ".pyd", ".exe"} and path.is_file()]
    python_roots = {path.parent for path in modules if path.name.lower() == "python.exe"}
    bundled_vc = {path.name.lower() for root in python_roots for path in root.glob("*.dll") if path.stem.lower() in VC_RUNTIME}

    def package_libs(module: Path, root: Path) -> list[Path]:
        """delvewheel's <package>.libs and scikit-learn style <package>/.libs:
        loaded by that package itself, so they only count for its modules."""
        site = root / "Lib" / "site-packages"
        if site not in module.parents:
            return []
        top = module.relative_to(site).parts[0]
        return [site / f"{top}.libs", site / top / ".libs"]

    failures = {}
    for module in modules:
        imports, _delayed = pe_imports(module)
        # Extension modules also see python.exe's folder; everything else
        # only its own folder and System32.
        roots = [root for root in python_roots if root in module.parents or root == module.parent]
        places = [module.parent, *roots, *(libs for root in roots for libs in package_libs(module, root))]
        missing = []
        for name in imports:
            lower = name.lower()
            if lower.startswith(("api-ms-", "ext-ms-")):
                continue
            if any((place / name).exists() for place in places):
                continue
            if Path(lower).stem in VC_RUNTIME:
                missing.append(f"{name} (Visual C++ runtime, not bundled)")
            elif not (SYSTEM32 / name).exists():
                missing.append(name)
        if missing:
            failures[module] = missing

    print(f"checked {len(modules)} modules; bundled VC++ runtime: {', '.join(sorted(bundled_vc)) or 'none'}")
    for module, missing in sorted(failures.items()):
        print(f"  {module}: {', '.join(missing)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
