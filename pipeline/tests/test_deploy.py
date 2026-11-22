import json

import pytest

from hitec_pipeline import deploy as D


def write_dataset(folder, archives):
    folder.mkdir(parents=True, exist_ok=True)
    for name, data in archives.items():
        (folder / name).write_bytes(data)
    names = list(archives)
    meta = {"area": "test", "attribution": "© OpenStreetMap contributors", "art": names[0]}
    if len(names) > 1:
        meta["overlay"] = {"type": "vector", "url": names[1]}
    (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")


def joined(folder, count):
    return b"".join((folder / f"{i}.bin").read_bytes() for i in range(count))


def test_chunk_count_and_length_cover_the_archive_exactly():
    assert D.chunk_count(0, 10) == 0
    assert D.chunk_count(10, 10) == 1
    assert D.chunk_count(11, 10) == 2
    assert [D.chunk_length(i, 25, 10) for i in range(D.chunk_count(25, 10))] == [10, 10, 5]


def test_prepare_cuts_archives_into_chunks_that_join_back_byte_for_byte(tmp_path):
    art, overlay = bytes(range(256)) * 41, b"overlay" * 7  # 10,496 and 49 bytes
    write_dataset(tmp_path / "src", {"art.1.pmtiles": art, "overlay.1.pmtiles": overlay})
    chunks = D.prepare(tmp_path / "src", tmp_path / "out", chunk=1000)

    assert chunks["dir"] == "chunks"
    a = chunks["archives"]["art.1.pmtiles"]
    assert (a["size"], a["chunk"], a["count"]) == (len(art), 1000, 11)
    assert joined(tmp_path / "out/chunks/art.1", 11) == art
    assert (tmp_path / "out/chunks/art.1/10.bin").stat().st_size == 496
    assert joined(tmp_path / "out/chunks/overlay.1", 1) == overlay

    meta = json.loads((tmp_path / "out/meta.json").read_text(encoding="utf-8"))
    assert meta["art"] == "art.1.pmtiles" and meta["chunks"] == chunks
    assert meta["attribution"] == "© OpenStreetMap contributors"  # non-ASCII text kept as is


def test_prepare_keeps_good_chunks_and_drops_archives_no_longer_published(tmp_path):
    write_dataset(tmp_path / "src", {"art.1.pmtiles": b"a" * 2500})
    D.prepare(tmp_path / "src", tmp_path / "out", chunk=1000)
    first = (tmp_path / "out/chunks/art.1/0.bin").stat().st_mtime_ns
    D.prepare(tmp_path / "src", tmp_path / "out", chunk=1000)
    assert (tmp_path / "out/chunks/art.1/0.bin").stat().st_mtime_ns == first  # not rewritten

    (tmp_path / "src/art.1.pmtiles").unlink()
    write_dataset(tmp_path / "src", {"art.2.pmtiles": b"b" * 1500})
    D.prepare(tmp_path / "src", tmp_path / "out", chunk=1000)
    assert sorted(p.name for p in (tmp_path / "out/chunks").iterdir()) == ["art.2"]


def test_prepare_recuts_a_damaged_chunk_folder(tmp_path):
    write_dataset(tmp_path / "src", {"art.1.pmtiles": b"abc" * 1000})
    D.prepare(tmp_path / "src", tmp_path / "out", chunk=1000)
    (tmp_path / "out/chunks/art.1/1.bin").write_bytes(b"x" * 1000)
    D.prepare(tmp_path / "src", tmp_path / "out", chunk=1000)
    assert joined(tmp_path / "out/chunks/art.1", 3) == b"abc" * 1000


def test_verify_reports_missing_short_and_altered_chunks(tmp_path):
    write_dataset(tmp_path / "src", {"art.1.pmtiles": b"z" * 2100})
    info = D.prepare(tmp_path / "src", tmp_path / "out", chunk=1000)["archives"]["art.1.pmtiles"]
    folder = tmp_path / "out/chunks/art.1"
    assert D.verify(folder, info) == []

    (folder / "1.bin").write_bytes(b"z" * 999)
    assert any("999 bytes, expected 1000" in p for p in D.verify(folder, info))
    (folder / "1.bin").write_bytes(b"y" * 1000)
    assert any("SHA-256" in p for p in D.verify(folder, info))
    (folder / "2.bin").unlink()
    assert any("missing 1" in p for p in D.verify(folder, info))


def test_prepare_refuses_more_files_than_the_host_allows(tmp_path, monkeypatch):
    monkeypatch.setattr(D, "MAX_FILES", 600)
    write_dataset(tmp_path / "src", {"art.1.pmtiles": b"q" * 101})
    with pytest.raises(SystemExit, match="larger chunks"):
        D.prepare(tmp_path / "src", tmp_path / "out", chunk=1)


def test_prepare_refuses_chunks_over_the_host_file_limit(tmp_path):
    write_dataset(tmp_path / "src", {"art.1.pmtiles": b"q"})
    with pytest.raises(ValueError):
        D.prepare(tmp_path / "src", tmp_path / "out", chunk=D.MAX_FILE_BYTES + 1)
