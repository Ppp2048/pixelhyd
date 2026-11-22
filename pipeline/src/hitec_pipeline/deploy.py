"""Prepare the published tiles for a static host that cannot answer HTTP range requests.

PMTiles readers ask for byte ranges. Cloudflare Pages answers a range request with the whole file
(status 200), and caps each file at 25 MiB and each deployment at 20,000 files. So each .pmtiles
archive is cut into fixed-size chunk files; the web app (src/map/chunkedSource.ts) reads any byte
range by fetching the whole chunks that cover it. The archives themselves are unchanged: the
chunks of an archive, joined in order, are the archive byte for byte.

Input:  web/public/tiles/<dataset>/ (meta.json and the archives it names, from `tiles publish`).
Output: data/deploy/tiles/<dataset>/meta.json, the same meta plus a "chunks" field, and
        data/deploy/tiles/<dataset>/chunks/<archive stem>/<index>.bin.
The web app's deploy build (npm run build:deploy) links that folder into dist/tiles/.

Usage: hitec-pipeline deploy [--dataset hitec-city-k4] [--chunk-kib 256]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

from . import DATA_ROOT
from .build import WEB_PUBLIC

DATASET = "hitec-city-k4"
OUT = DATA_ROOT / "deploy" / "tiles"
CHUNK_DIR = "chunks"
CHUNK_BYTES = 256 * 1024
# Cloudflare Pages (free plan) limits; the app itself needs a few dozen files besides the tiles.
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_FILES = 20_000
APP_FILE_RESERVE = 500
READ_BLOCK = 8 * 1024 * 1024


def chunk_count(size: int, chunk: int) -> int:
    """How many chunk files an archive of `size` bytes needs (the last one may be shorter)."""
    return -(-size // chunk)


def chunk_length(index: int, size: int, chunk: int) -> int:
    """Bytes in chunk `index`: a full chunk, or what is left for the last one."""
    return min(chunk, size - index * chunk)


def split(archive: Path, folder: Path, chunk: int) -> dict:
    """Cut `archive` into `folder`/<i>.bin and return its size, chunk count and SHA-256.

    Writes into a temporary folder first and renames it when complete, so an interrupted run
    never leaves a folder that looks finished.
    """
    partial = folder.with_name(folder.name + ".partial")
    shutil.rmtree(partial, ignore_errors=True)
    partial.mkdir(parents=True)
    digest = hashlib.sha256()
    size = 0
    with archive.open("rb") as f:
        for index in range(chunk_count(archive.stat().st_size, chunk)):
            data = f.read(chunk)
            digest.update(data)
            size += len(data)
            (partial / f"{index}.bin").write_bytes(data)
    shutil.rmtree(folder, ignore_errors=True)
    partial.rename(folder)
    return {"size": size, "chunk": chunk, "count": chunk_count(size, chunk), "sha256": digest.hexdigest()}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(READ_BLOCK):
            digest.update(block)
    return digest.hexdigest()


def verify(folder: Path, info: dict) -> list[str]:
    """Problems with a chunk folder: missing, extra or wrongly sized chunks, or joined bytes that
    do not hash to the archive's SHA-256. An empty list means the folder is good."""
    size, chunk, count = info["size"], info["chunk"], info["count"]
    problems = []
    if count != chunk_count(size, chunk):
        problems.append(f"{folder.name}: {count} chunks recorded, {chunk_count(size, chunk)} expected")
    names = {p.name for p in folder.glob("*.bin")}
    expected = {f"{i}.bin" for i in range(count)}
    if names != expected:
        problems.append(f"{folder.name}: missing {len(expected - names)} chunks, {len(names - expected)} unexpected")
        return problems
    digest = hashlib.sha256()
    for index in range(count):
        data = (folder / f"{index}.bin").read_bytes()
        if len(data) != chunk_length(index, size, chunk):
            problems.append(f"{folder.name}/{index}.bin: {len(data)} bytes, expected {chunk_length(index, size, chunk)}")
        digest.update(data)
    if digest.hexdigest() != info["sha256"]:
        problems.append(f"{folder.name}: joined chunks do not match the archive (SHA-256)")
    return problems


def prepare(source: Path, out: Path, chunk: int = CHUNK_BYTES) -> dict:
    """Cut the archives named in `source`/meta.json into chunks under `out` and write the deploy
    meta.json. Chunk folders that already match their archive are kept; folders of archives no
    longer named in meta.json are removed. Returns the "chunks" field written to meta.json."""
    if not 0 < chunk <= MAX_FILE_BYTES:
        raise ValueError(f"chunk size must be between 1 byte and {MAX_FILE_BYTES} bytes")
    meta = json.loads((source / "meta.json").read_text(encoding="utf-8"))
    names = [n for n in (meta.get("art"), (meta.get("overlay") or {}).get("url")) if n]
    if not names:
        raise SystemExit(f"{source / 'meta.json'} names no archives; run `hitec-pipeline tiles publish` first")
    chunks_root = out / CHUNK_DIR
    chunks_root.mkdir(parents=True, exist_ok=True)
    old = json.loads((out / "meta.json").read_text(encoding="utf-8")).get("chunks", {}) if (out / "meta.json").exists() else {}
    archives = {}
    for name in names:
        archive = source / name
        if not archive.exists():
            raise SystemExit(f"{archive} is missing; run `hitec-pipeline tiles publish` first")
        folder = chunks_root / Path(name).stem
        known = (old.get("archives") or {}).get(name)
        if (known and known["chunk"] == chunk and known["size"] == archive.stat().st_size and folder.is_dir()
                and known["sha256"] == file_sha256(archive) and not verify(folder, known)):
            print(f"{name}: chunks already up to date ({known['count']} files)")
            archives[name] = known
            continue
        print(f"{name}: cutting {archive.stat().st_size:,} bytes into {chunk:,}-byte chunks…")
        archives[name] = split(archive, folder, chunk)
        if problems := verify(folder, archives[name]):
            raise SystemExit("chunk check failed:\n  " + "\n  ".join(problems))
        if archives[name]["sha256"] != file_sha256(archive):
            raise SystemExit(f"{name} changed while it was being cut; run again")
    live = {Path(n).stem for n in names}
    for folder in chunks_root.iterdir():
        if folder.name not in live:
            shutil.rmtree(folder) if folder.is_dir() else folder.unlink()
    files = sum(a["count"] for a in archives.values())
    if files > MAX_FILES - APP_FILE_RESERVE:
        raise SystemExit(f"{files:,} chunk files would leave under {APP_FILE_RESERVE} of the host's {MAX_FILES:,} "
                         "files for the app; use larger chunks (--chunk-kib)")
    meta["chunks"] = {"dir": CHUNK_DIR, "archives": archives}
    (out / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
    return meta["chunks"]


def cli(argv: list[str]) -> None:
    p = argparse.ArgumentParser(prog="hitec-pipeline deploy", description=__doc__.split("\n\n")[0])
    p.add_argument("--dataset", default=DATASET)
    p.add_argument("--chunk-kib", type=int, default=CHUNK_BYTES // 1024, help="chunk size in KiB (default 256)")
    a = p.parse_args(argv)
    chunks = prepare(WEB_PUBLIC / a.dataset, OUT / a.dataset, a.chunk_kib * 1024)
    total = sum(x["size"] for x in chunks["archives"].values())
    files = sum(x["count"] for x in chunks["archives"].values())
    print(f"{files:,} chunk files, {total / 1e9:.2f} GB, in {OUT / a.dataset}")
