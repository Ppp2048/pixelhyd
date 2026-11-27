"""Generate many grid tiles at once, in parallel worker processes.

A batch runs in stages; each stage fans out over a process pool:

1. data      download each 5 km block once (serially, to respect Overpass limits),
             then cut and normalise every tile in parallel
2. render    re-render every chunk the batch touches, grouped 4 × 4 chunks per job;
             each job reads exactly the tiles whose data can reach its chunks
3. overlay   per tile: building silhouettes, road centrelines, POIs, plus checks
             (heights have a source, edge chunks render without seams)
4. pyramid   lower zoom levels rebuilt level by level from the changed tiles
5. archives  art.pmtiles and overlay.pmtiles rewritten with only the changed
             tiles replaced (vector tiles re-encoded only where the batch reaches)

Tile statuses are updated only after the archives are written, so an interrupted
batch leaves its tiles retryable and the published map unchanged. Finished render
jobs are recorded in the stage, so re-running an interrupted batch resumes from the
last finished job instead of starting over.

A large request (a whole ring) is split into strips of neighbouring tiles that are
generated and published one after another, so the map grows while the ring runs.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from itertools import repeat

from . import tiles as T

DEFAULT_WORKERS = max(1, min(6, (os.cpu_count() or 2) - 2))
DEFAULT_STEP = 16  # tiles per published strip; ~10–20 min each on a laptop
PLAN = T.STAGE / "batch.json"  # the running batch: its tiles and options
JOBS = T.STAGE / "jobs"  # one marker per finished render job, with the output tiles it changed


def _log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _slices(items: list, parts: int) -> list[list]:
    n = max(1, math.ceil(len(items) / parts))
    return [items[i:i + n] for i in range(0, len(items), n)]


def strips(tids: list[str], step: int = DEFAULT_STEP) -> list[list[str]]:
    """Split tiles into strips of neighbours: sorted by angle around the grid centre (so a ring is
    walked along its perimeter), then cut into near-equal parts of at most `step` tiles."""
    if step <= 0 or len(tids) <= step:
        return [list(tids)]
    centre = (T.GRID - 1) / 2
    order = sorted(tids, key=lambda t: (math.atan2(T.rc(t)[0] - centre, T.rc(t)[1] - centre), t))
    parts = math.ceil(len(order) / step)
    cuts = [round(i * len(order) / parts) for i in range(parts + 1)]
    return [order[a:b] for a, b in zip(cuts, cuts[1:])]


def interrupted() -> list[str]:
    """Tiles of a batch that stopped before finishing (empty if none)."""
    try:
        return json.loads(PLAN.read_text())["tids"]
    except (OSError, ValueError, KeyError):
        return []


def _job_marker(group: list[tuple[int, int]]):
    cx, cy = group[0]
    return JOBS / f"{cy // T.GROUP}_{cx // T.GROUP}.json"


def _begin(plan: dict) -> bool:
    """Prepare the stage for a batch; keep it (and resume) if it belongs to this same batch."""
    try:
        same = json.loads(PLAN.read_text()) == plan
    except (OSError, ValueError):
        same = False
    if not same:
        shutil.rmtree(T.STAGE, ignore_errors=True)
        JOBS.mkdir(parents=True)
        PLAN.write_text(json.dumps(plan))
    return same


def run_batch(tids: list[str], workers: int = DEFAULT_WORKERS, force: bool = False, rerender: bool = False,
              reprepare: bool = False) -> bool:
    """`reprepare`: cut and normalise the tiles again from their blocks' existing downloads (never
    re-downloading, unlike `force`), then render; for new inputs such as the aeroway supplement."""
    idx = T.load_index()
    for t in tids:
        T.ensure_tile(idx, t)
    if not (force or rerender or reprepare):
        skipped = [t for t in tids if idx["tiles"][t]["status"] == "validated"]
        if skipped:
            _log(f"already validated, skipped: {' '.join(skipped)} (use --force or --rerender)")
        tids = [t for t in tids if t not in skipped]
    if rerender and (missing := [t for t in tids if not T._features(t).exists()]):
        raise SystemExit(f"--rerender needs prepared data; missing for {' '.join(missing)}")
    if not tids:
        return True
    T.save_index(idx)
    proj = T.global_projection()
    T.migrate_archives()
    resumed = _begin({"tids": sorted(tids), "force": force, "rerender": rerender, "reprepare": reprepare})
    timing: dict[str, float] = {}
    started = time.perf_counter()
    failed: dict[str, str] = {}
    _log(f"{'resuming ' if resumed else ''}batch of {len(tids)} tiles on {workers} workers: {' '.join(tids)}")

    with ProcessPoolExecutor(max_workers=workers) as pool:
        # 1. data
        t0 = time.perf_counter()
        need = [] if rerender else [t for t in tids if force or reprepare or not T._features(t).exists()]
        own_raw = {t for t in need if not force and T.has_raw(T._raw(T.tile_square(t).name))}
        for b in sorted({T.block_of(t) for t in need if t not in own_raw}):
            bt = time.perf_counter()
            try:
                T.fetch_block(b, force=force)
                _log(f"block {b}: data ready ({time.perf_counter() - bt:.0f} s)")
            except Exception as exc:  # recorded per tile so they can be retried
                for t in need:
                    if T.block_of(t) == b:
                        failed[t] = f"fetch: {exc}"
        futures = {pool.submit(T.prepare_tile, t, force or reprepare): t for t in need if t not in failed}
        for f in as_completed(futures):
            t = futures[f]
            try:
                r = f.result()
                status = idx["tiles"][t]["status"]
                T._set(idx, t, "fetched" if status in ("pending", "failed") else status, save=False,
                       data=r["data"], fetch_s=r["fetch_s"])
            except Exception as exc:
                failed[t] = f"prepare: {exc}"
        for t, err in failed.items():
            T._set(idx, t, "failed", save=False, error=err, step=err.split(":")[0])
        T.save_index(idx)
        timing["data_s"] = time.perf_counter() - t0
        ok = [t for t in tids if t not in failed]
        _log(f"data: {len(ok)} tiles ready, {len(failed)} failed ({timing['data_s']:.0f} s)")
        if not ok:
            shutil.rmtree(T.STAGE, ignore_errors=True)  # nothing to resume: every tile is marked failed
            return False

        drawn = frozenset(T.done_tiles(idx) | set(ok))
        try:
            # 2. render
            t0 = time.perf_counter()
            chunks = sorted({c for t in ok for c in T.affected_chunks(proj, t)})
            groups = T.group_chunks(chunks)
            changed: set[tuple[int, int]] = set()
            peak = 0.0
            todo = []
            for g in groups:  # jobs finished before an interruption are not rendered again
                try:
                    changed.update(map(tuple, json.loads(_job_marker(g).read_text())))
                except (OSError, ValueError):
                    todo.append(g)
            _log(f"rendering {len(chunks)} chunks in {len(groups)} jobs"
                 + (f" ({len(groups) - len(todo)} already done)" if len(todo) < len(groups) else ""))
            futures = {pool.submit(T.render_job, g, drawn): g for g in todo}
            for f in as_completed(futures):
                r = f.result()
                changed.update(r["changed"])
                peak = max(peak, r["peak_memory_mb"])
                marker = _job_marker(futures[f])
                marker.with_suffix(".tmp").write_text(json.dumps(r["changed"]))
                marker.with_suffix(".tmp").replace(marker)
            timing["render_s"] = time.perf_counter() - t0
            _log(f"render: {len(changed)} output tiles ({timing['render_s']:.0f} s)")

            # 3. overlays and checks
            t0 = time.perf_counter()
            results = {r["tid"]: r for r in pool.map(T.tile_job, ok, repeat(drawn))}
            owned = {t: set(r["owned"]) for t, r in results.items()}
            for t in ok:  # a building may only be drawn by one tile; only neighbours share data
                for o in T.neighbours(t, 1):
                    if o == t or o not in drawn:
                        continue
                    dup = owned[t] & (owned[o] if o in owned else T.overlay_ids(o))
                    if dup:
                        results[t]["problems"].append(f"{len(dup)} buildings also owned by {o}")
            timing["overlay_s"] = time.perf_counter() - t0
            _log(f"overlays and checks ({timing['overlay_s']:.0f} s)")

            # 4. pyramid
            t0 = time.perf_counter()
            zmin, zmax = T.zoom_range(proj)
            extra = {}
            hdr = T.archive_header(T.current(T.ART))
            if hdr and hdr["min_zoom"] > zmin:  # the map grew: build the new lower zooms from the old lowest one
                extra[hdr["min_zoom"]] = T.base_tiles_at(hdr["min_zoom"])
            level = set(changed)
            for z in range(zmax - 1, zmin - 1, -1):
                level |= extra.get(z + 1, set())
                parents = sorted({(x // 2, y // 2) for x, y in level})
                list(pool.map(T.ancestors_job, repeat(z), _slices(parents, workers * 4)))
                level = set(parents)
            timing["pyramid_s"] = time.perf_counter() - t0
            _log(f"pyramid z{zmin}–{zmax - 1} ({timing['pyramid_s']:.0f} s)")

            # 5. archives
            t0 = time.perf_counter()
            art = T.pack_art(proj)
            timing["art_merge_s"] = time.perf_counter() - t0
            t1 = time.perf_counter()
            jobs = T.vt_jobs(proj, ok, set(drawn))
            staged: dict[int, bytes | None] = {}
            for r in pool.map(T.vt_job, [j[0] for j in jobs], [j[1] for j in jobs]):
                staged.update(r)
            timing["vector_encode_s"] = time.perf_counter() - t1
            t1 = time.perf_counter()
            vec = T.pack_vector(proj, staged)
            timing["vector_merge_s"] = time.perf_counter() - t1
            timing["archives_s"] = time.perf_counter() - t0
            _log(f"archives: art {art['tiles']} tiles / {art['bytes'] / 1e6:.1f} MB ({timing['art_merge_s']:.0f} s), "
                 f"overlay {vec['vector_tiles']} tiles / {vec['bytes'] / 1e6:.1f} MB "
                 f"(encode {timing['vector_encode_s']:.0f} s, merge {timing['vector_merge_s']:.0f} s)")
        except Exception as exc:
            for t in ok:
                T._set(idx, t, "failed", save=False, error=f"render: {exc}", step="render", trace=traceback.format_exc()[-2000:])
            T.save_index(idx)
            raise

    shutil.rmtree(T.STAGE, ignore_errors=True)
    shutil.rmtree(T.OUT / "tiles", ignore_errors=True)  # old per-file pyramid, superseded by the archive
    total = time.perf_counter() - started
    bad = {t: r["problems"] for t, r in results.items() if r["problems"]}
    for t in ok:
        metrics = {**results[t]["metrics"], "batch_size": len(ok), "batch_s": round(total, 1)}
        T._set(idx, t, "rendered", save=False, render=metrics, rendered_at=T._now())
        if t in bad:
            T._set(idx, t, "failed", save=False, error="; ".join(bad[t]), step="validate")
        else:
            T._set(idx, t, "validated", save=False, validated_at=T._now())
    idx.setdefault("batches", []).append({
        "at": T._now(), "tiles": ok, "failed": sorted(failed), "workers": workers, "chunks": len(chunks),
        **{k: round(v, 1) for k, v in timing.items()}, "total_s": round(total, 1), "peak_worker_memory_mb": round(peak, 1)})
    T.save_index(idx)
    published = T.publish(idx, proj)
    conf: dict[str, int] = {}
    for t in ok:
        for k, v in results[t]["metrics"]["height_confidence"].items():
            conf[k] = conf.get(k, 0) + v
    print(json.dumps({
        "tiles": len(ok), "failed": failed, "invalid": bad, "seconds": round(total, 1),
        "seconds_per_tile": round(total / len(ok), 1), "stages_s": {k: round(v, 1) for k, v in timing.items()},
        "buildings": sum(len(results[t]["owned"]) for t in ok), "height_confidence": conf,
        "peak_worker_memory_mb": round(peak, 1), "map": published}, indent=1))
    return not bad and not failed
