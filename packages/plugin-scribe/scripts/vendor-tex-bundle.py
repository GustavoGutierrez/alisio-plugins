"""Release maintainer tool: snapshot installed TeX Live data, never run on a user's machine.

Tectonic bundles are flat: every file is addressed by its basename. Two different source files
with the same basename cannot both be shipped, so the script fails instead of silently keeping
the first one. Byte-identical duplicates are harmless and kept once.

Tectonic reads the first 64 characters of the SHA256SUM entry as the bundle digest and keys its
format cache on it, so it must be a single hex digest. It is the SHA-256 of a manifest listing
`<sha256>  <name>` for every other entry, sorted by name: any content change yields a new digest.
"""

import hashlib
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

SOURCES = ["/usr/share/texlive/texmf-dist", "/usr/share/texmf"]


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    chosen: dict[str, tuple[Path, str]] = {}
    conflicts: dict[str, set[Path]] = {}
    for base in SOURCES:
        for p in sorted(Path(base).rglob("*")):
            if not p.is_file():
                continue
            h = digest(p)
            previous = chosen.get(p.name)
            if previous is None:
                chosen[p.name] = (p, h)
            elif previous[1] != h:
                conflicts.setdefault(p.name, {previous[0]}).add(p)
    if conflicts:
        for name, paths in sorted(conflicts.items()):
            print(f"duplicate basename with different content: {name}", file=sys.stderr)
            for p in sorted(paths):
                print(f"  {p}", file=sys.stderr)
        print(f"{len(conflicts)} conflicting basenames; bundle not written.", file=sys.stderr)
        return 1

    generated = {"tectonic-format-latex.tex": b"\\input latex.ltx\n"}
    licenses = {
        "LICENSES/" + p.parent.name + "-copyright.txt": p
        for p in sorted(Path("/usr/share/doc").glob("texlive*/copyright"))
    }
    for name in [*generated, *licenses, "SHA256SUM"]:
        if name in chosen:
            print(f"generated entry collides with a TeX file: {name}", file=sys.stderr)
            return 1

    sums: list[str] = []
    target = root / "compiler/bundle.zip"
    with ZipFile(target, "w", ZIP_DEFLATED) as z:
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
    print(target.stat().st_size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
