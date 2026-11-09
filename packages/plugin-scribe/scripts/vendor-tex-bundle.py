"""Release maintainer tool: snapshot installed TeX Live data, never run on a user's machine.

Usage:
  python3 scripts/vendor-tex-bundle.py [--var DIR]... [--out-dir DIR] [TEXMF_ROOT]...

Every positional TEXMF_ROOT is snapshotted entirely (for a portable TeX Live: `<tl>/texmf-dist`).
Without roots the old system paths are used (/usr/share/texlive/texmf-dist and /usr/share/texmf).
Each `--var DIR` is a TEXMFVAR/TEXMFSYSVAR tree from which only generated font data is taken:
font maps (`fonts/map/**/*.map`, e.g. pdftex.map, kanjix.map) and font files under `fonts/`
(.enc, .pfb, .tfm, .otf, ...). A `texmf-var` next to a root is added automatically.
Output goes to the package's compiler/ directory unless `--out-dir` is given.

Tectonic bundles are flat: every file is addressed by its basename. Two different source files
with the same basename cannot both be shipped, so the script fails instead of silently keeping
the first one. Byte-identical duplicates are harmless and kept once. Paths that Tectonic never
reads (the LaTeX pre-release, Lua code, dvipdfm maps, documentation, per-faculty locale copies)
are excluded by the glob patterns in scripts/tex-bundle-excludes.txt, matched against each file's
path relative to its TEXMF root; `--exclude-file` points at another list.

Tectonic reads the first 64 characters of the SHA256SUM entry as the bundle digest and keys its
format cache on it, so it must be a single hex digest. It is the SHA-256 of a manifest listing
`<sha256>  <name>` for every other entry, sorted by name: any content change yields a new digest.

It also writes compiler/bundle-manifest.json, the sorted basenames of the LaTeX resources Scribe's
preflight checks (classes, packages, babel locales and loaders, bibliography styles), plus the
TeX Live release year when it can be detected.
"""

import argparse
import fnmatch
import hashlib
import json
import re
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

DEFAULT_SOURCES = ["/usr/share/texlive/texmf-dist", "/usr/share/texmf"]
# Hyphenation config generated for the installed languages; it replaces the root's template copies
# (which list every TeX Live language and make the format build fail on missing patterns).
VAR_CONFIG = ("tex/generic/config/language.dat", "tex/generic/config/language.def")
FONT_SUFFIXES = {".map", ".enc", ".pfb", ".pfm", ".afm", ".tfm", ".vf", ".otf", ".ttf", ".ttc"}
MANIFEST_SUFFIXES = {".sty", ".cls", ".ldf", ".bst", ".cbx", ".bbx"}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest_names(names) -> list[str]:
    """Basenames preflight checks: .sty .cls .ldf .bst .cbx .bbx, babel-*.ini and babel-*.tex."""
    keep = set()
    for name in names:
        if "/" in name:
            continue
        suffix = Path(name).suffix
        if suffix in MANIFEST_SUFFIXES or (
            name.startswith("babel-") and suffix in {".ini", ".tex"}
        ):
            keep.add(name)
    return sorted(keep)


def detect_year(roots: list[Path]) -> str:
    for root in roots:
        release = root.parent / "release-texlive.txt"
        if release.is_file():
            text = release.read_text(errors="replace")
            match = re.search(r"TeX Live (\d{4})", text) or re.search(r"version (\d{4})", text)
            if match:
                return match.group(1)
    for root in roots:
        for part in root.resolve().parts:
            if re.fullmatch(r"20\d\d", part):
                return part
    return ""


def var_files(base: Path):
    for rel in VAR_CONFIG:
        if (base / rel).is_file():
            yield base / rel
    fonts = base / "fonts"
    if not fonts.is_dir():
        return
    for p in sorted(fonts.rglob("*")):
        if not p.is_file() or p.suffix not in FONT_SUFFIXES:
            continue
        # Maps only from fonts/map; other font data from anywhere under fonts/.
        if p.suffix == ".map" and "map" not in p.relative_to(fonts).parts[:1]:
            continue
        yield p


def license_files(roots: list[Path], system: bool) -> dict[str, Path]:
    licenses: dict[str, Path] = {}
    if system:
        for p in sorted(Path("/usr/share/doc").glob("texlive*/copyright")):
            licenses["LICENSES/" + p.parent.name + "-copyright.txt"] = p
    for root in roots:
        for name in ("LICENSE.TL", "LICENSE.CTAN"):
            p = root.parent / name
            if p.is_file():
                licenses[f"LICENSES/texlive-{name}.txt"] = p
    return licenses


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Snapshot TeX Live into compiler/bundle.zip.")
    parser.add_argument("roots", nargs="*", help="TEXMF trees to snapshot entirely")
    parser.add_argument(
        "--var",
        action="append",
        default=[],
        help="TEXMFVAR/TEXMFSYSVAR tree; only generated font maps and font files are taken",
    )
    parser.add_argument("--out-dir", help="output directory (default: the package compiler/)")
    parser.add_argument(
        "--exclude-file",
        default=str(Path(__file__).resolve().parent / "tex-bundle-excludes.txt"),
        help="glob patterns (one per line, # comments) of root-relative paths to leave out",
    )
    args = parser.parse_args(argv)
    excludes = [
        line.strip()
        for line in Path(args.exclude_file).read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]

    def excluded(rel: str) -> bool:
        return any(fnmatch.fnmatchcase(rel, pattern) for pattern in excludes)

    system = not args.roots
    roots = [Path(r) for r in (args.roots or DEFAULT_SOURCES)]
    for r in roots:
        if not r.is_dir():
            print(f"not a directory: {r}", file=sys.stderr)
            return 1
    var_roots = [Path(v) for v in args.var]
    for r in roots:
        sibling = r.parent / "texmf-var"
        if sibling.is_dir() and sibling not in var_roots and sibling not in roots:
            var_roots.append(sibling)
    for v in var_roots:
        if not v.is_dir():
            print(f"not a directory: {v}", file=sys.stderr)
            return 1

    out = Path(args.out_dir) if args.out_dir else Path(__file__).resolve().parents[1] / "compiler"
    chosen: dict[str, tuple[Path, str]] = {}
    conflicts: dict[str, set[Path]] = {}

    def add(p: Path) -> None:
        h = digest(p)
        previous = chosen.get(p.name)
        if previous is None:
            chosen[p.name] = (p, h)
        elif previous[1] != h:
            conflicts.setdefault(p.name, {previous[0]}).add(p)

    # Generated config first: the roots' template copies of the same names are skipped below.
    generated_config = {Path(rel).name for base in var_roots for rel in VAR_CONFIG if (base / rel).is_file()}
    for base in var_roots:
        for p in var_files(base):
            rel = p.relative_to(base).as_posix()
            if rel in VAR_CONFIG or not excluded(rel):
                add(p)
    for base in roots:
        for p in sorted(base.rglob("*")):
            if not p.is_file() or excluded(p.relative_to(base).as_posix()):
                continue
            if p.name in generated_config and p.relative_to(base).as_posix() in VAR_CONFIG:
                continue
            add(p)

    if conflicts:
        for name, paths in sorted(conflicts.items()):
            print(f"duplicate basename with different content: {name}", file=sys.stderr)
            for p in sorted(paths):
                print(f"  {p}", file=sys.stderr)
        print(f"{len(conflicts)} conflicting basenames; bundle not written.", file=sys.stderr)
        return 1

    generated = {"tectonic-format-latex.tex": b"\\input latex.ltx\n"}
    licenses = license_files(roots, system)
    for name in [*generated, *licenses, "SHA256SUM"]:
        if name in chosen:
            print(f"generated entry collides with a TeX file: {name}", file=sys.stderr)
            return 1

    sums: list[str] = []
    target = out / "bundle.zip"
    with ZipFile(target, "w", ZIP_DEFLATED, compresslevel=9) as z:
        for name, (p, h) in sorted(chosen.items()):
            z.write(p, name)
            sums.append(f"{h}  {name}")
        for name, data in generated.items():
            z.writestr(name, data)
            sums.append(f"{hashlib.sha256(data).hexdigest()}  {name}")
        for name, p in licenses.items():
            z.write(p, name)
            sums.append(f"{digest(p)}  {name}")
        manifest = "\n".join(sorted(sums, key=lambda line: line[66:])) + "\n"
        z.writestr("SHA256SUM", hashlib.sha256(manifest.encode()).hexdigest() + "\n")

    index = {"texlive": detect_year(roots), "files": manifest_names(chosen)}
    manifest_path = out / "bundle-manifest.json"
    tmp = manifest_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, indent=1, ensure_ascii=True) + "\n", encoding="utf-8")
    tmp.replace(manifest_path)
    print(f"{target.stat().st_size} bytes, {len(index['files'])} manifest entries")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
