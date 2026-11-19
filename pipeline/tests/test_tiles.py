from hitec_pipeline import tiles as T
from hitec_pipeline.area import HITEC_CITY, PROTOTYPE


def test_grid_covers_area_exactly():
    ids = T.tile_ids()
    assert len(ids) == T.GRID**2 == 25
    e0, n0, e1, n1 = HITEC_CITY.core
    assert T.tile_bounds("r0c0")[:2] == (e0, n0)
    assert T.tile_bounds(f"r{T.GRID - 1}c{T.GRID - 1}")[2:] == (e1, n1)


def test_every_point_has_exactly_one_owner():
    b = T.tile_bounds("r2c2")
    assert T.owner_of(b[0], b[1]) == "r2c2"  # SW corner belongs to the tile
    assert T.owner_of(b[2], b[1]) == "r2c3"  # E edge belongs to the eastern neighbour
    assert T.owner_of(b[0], b[3]) == "r3c2"  # N edge belongs to the northern neighbour
    assert T.owner_of(HITEC_CITY.core[0] - 1, HITEC_CITY.core[1]) == "r0c-1"  # the grid continues beyond 5 km
    e0, n0 = T.tile_bounds(T.tid_of(T.CITY_ROWS.start, T.CITY_COLS.start))[:2]
    assert T.owner_of(e0 - 1, n0) is None  # but not beyond the city box


def test_prototype_lies_in_r2c2():
    e0, n0, e1, n1 = PROTOTYPE.core
    assert T.owner_of(e0, n0) == T.owner_of(e1 - 1e-6, n1 - 1e-6) == "r2c2"


def test_next_tile_grows_from_prototype_to_neighbours():
    idx = {"tiles": {t: {"status": "pending", "contains_prototype": t == "r2c2"} for t in T.tile_ids()}}
    assert T.next_tile(idx) == "r2c2"
    idx["tiles"]["r2c2"]["status"] = "validated"
    nxt = T.next_tile(idx)
    assert nxt in {"r1c2", "r3c2", "r2c1", "r2c3"}


def test_affected_chunks_cover_the_tile_and_stay_on_canvas():
    proj = T.global_projection()
    chunks = T.affected_chunks(proj, "r2c2")
    e0, n0, e1, n1 = T.tile_bounds("r2c2")
    for e, n in ((e0, n0), (e1, n0), (e1, n1), (e0, n1)):
        x, y = proj.to_px(e, n, 0)
        assert (int(x // T.CHUNK), int(y // T.CHUNK)) in chunks
    x0, y0, x1, y1 = T.canvas(proj)
    assert all(x0 <= cx * T.CHUNK < x1 and y0 <= cy * T.CHUNK < y1 for cx, cy in chunks)


def test_chunks_align_with_output_tiles():
    proj = T.global_projection()
    assert T.CHUNK % 256 == 0 and proj.origin_world % T.CHUNK == 0
    assert all(v % T.CHUNK == 0 for v in T.canvas(proj))


def test_vector_overlay_round_trip(tmp_path, monkeypatch):
    """A building silhouette written to overlay.pmtiles decodes back in the right tile with its properties."""
    import gzip

    import mapbox_vector_tile
    from pmtiles.reader import MmapSource, Reader

    monkeypatch.setattr(T, "OUT", tmp_path)
    proj = T.global_projection()
    x0, y0 = 20000.0, 9000.0  # art px
    ring = [(x0, y0), (x0 + 40, y0), (x0 + 40, y0 + 30), (x0, y0 + 30), (x0, y0)]
    lon, lat = proj.px_to_lonlat([p[0] for p in ring], [p[1] for p in ring])
    feat = {"type": "Feature", "properties": {"layer": "building", "id": "b1", "height_m": 12.5, "name": None},
            "geometry": {"type": "Polygon", "coordinates": [[[float(a), float(b)] for a, b in zip(lon, lat)]]}}
    info = T.write_vector_overlay(proj, [feat])
    assert info["features"] == 1 and info["vector_tiles"] >= T.VT_MAX_ZOOM - T.VT_MIN_ZOOM + 1

    z = T.VT_MAX_ZOOM
    span = 256 * 2 ** (proj.zmax - z)
    tx, ty = int((proj.origin_world + x0 + 20) // span), int((proj.origin_world + y0 + 15) // span)
    with open(T.current("overlay"), "rb") as f:
        data = Reader(MmapSource(f)).get(z, tx, ty)
    layers = mapbox_vector_tile.decode(gzip.decompress(data), default_options={"y_coord_down": True})
    props = layers["building"]["features"][0]["properties"]
    assert props["id"] == "b1" and props["height_m"] == 12.5 and "name" not in props  # nulls dropped


def test_grid_grows_ring_by_ring_and_keeps_the_5km_tiles():
    proj = T.global_projection()
    x0, y0, x1, y1 = T.canvas(proj)
    assert x0 < 0 and y0 < 0 and x1 > proj.width and y1 > proj.height  # the old canvas sits inside
    assert T.ring_of("r2c2") == 0 and T.ring_of("r-1c3") == 1 and T.ring_of("r6c-2") == 2
    idx = {"tiles": {t: {"status": "validated"} for t in T.tile_ids()}}
    nxt = T.frontier(idx, 24)
    assert len(nxt) == 24 and all(T.ring_of(t) == 1 for t in nxt)


def test_chunk_region_covers_what_can_paint_into_a_chunk():
    from shapely.geometry import Point

    proj = T.global_projection()
    cx, cy = 20, 8
    region = T.chunk_region(proj, [(cx, cy)])
    for x, y in ((cx * T.CHUNK, cy * T.CHUNK), ((cx + 1) * T.CHUNK, (cy + 1) * T.CHUNK)):
        e, n = proj.ground_from_px(x, y)
        assert region.contains(Point(float(e), float(n)))
    # a 150 m building whose top reaches the chunk's bottom edge stands below it on screen
    e, n = proj.ground_from_px((cx + 0.5) * T.CHUNK, (cy + 1) * T.CHUNK + proj.v * 150)
    assert region.contains(Point(float(e), float(n)))


def test_block_split_keeps_only_features_near_the_tile(tmp_path, monkeypatch):
    import json

    import geopandas as gpd
    from shapely.geometry import box

    monkeypatch.setattr(T, "DATA_ROOT", tmp_path)
    tid = "r-1c-1"
    src = tmp_path / "raw" / T.block_square(T.block_of(tid)).name
    src.mkdir(parents=True)
    w, s, e, n = T.tile_square(tid).wgs_bbox()
    near = {"type": "way", "id": 1, "bounds": {"minlat": s + 0.001, "minlon": w + 0.001, "maxlat": s + 0.002, "maxlon": w + 0.002}}
    far = {"type": "way", "id": 2, "bounds": {"minlat": n + 0.01, "minlon": e + 0.01, "maxlat": n + 0.02, "maxlon": e + 0.02}}
    node = {"type": "node", "id": 3, "lat": (s + n) / 2, "lon": (w + e) / 2}
    (src / "osm.json").write_text(json.dumps({"osm3s": {}, "elements": [near, far, node]}), encoding="utf-8")
    gpd.GeoDataFrame({"id": ["in", "out"]}, geometry=[box(w + 0.001, s + 0.001, w + 0.002, s + 0.002),
                                                      box(e + 0.01, n + 0.01, e + 0.02, n + 0.02)], crs=4326).to_parquet(src / "overture_buildings.parquet")
    (src / "manifest.json").write_text(json.dumps({"downloads": [{"file": "osm.json"}]}), encoding="utf-8")
    out = T.split_block(tid)
    assert [el["id"] for el in json.loads((out / "osm.json").read_text(encoding="utf-8"))["elements"]] == [1, 3]
    assert gpd.read_parquet(out / "overture_buildings.parquet")["id"].tolist() == ["in"]


def test_tile_without_buildings_normalises(tmp_path):
    """Open land: no Overture buildings must still give a features file with an empty buildings layer."""
    import json

    import geopandas as gpd
    from shapely.geometry import box

    from hitec_pipeline.normalise import normalise
    from hitec_pipeline.scene import read_layers

    sq = T.tile_square("r-7c-7")
    raw = tmp_path / "raw" / sq.name
    raw.mkdir(parents=True)
    (raw / "osm.json").write_text(json.dumps({"osm3s": {}, "elements": []}), encoding="utf-8")
    gpd.GeoDataFrame({"id": [], "class": [], "subtype": [], "names": [], "height": [], "num_floors": [], "sources": []},
                     geometry=gpd.GeoSeries([], crs=4326), crs=4326).to_parquet(raw / "overture_buildings.parquet")
    out = normalise(sq, tmp_path)
    layers = read_layers(out / "features.gpkg")
    assert "buildings" not in layers or layers["buildings"].empty
    assert box(*sq.core).area > 0


def test_a_ring_is_published_in_strips_of_neighbours():
    from hitec_pipeline import batch

    ring = [t for t in T.city_tile_ids() if T.ring_of(t) == 12] + ["r15c10", "r15c11", "r15c12", "r15c13", "r15c14"]
    parts = batch.strips(ring, 16)
    assert sorted(t for p in parts for t in p) == sorted(ring)  # every tile exactly once
    assert max(map(len, parts)) <= 16 and max(map(len, parts)) - min(map(len, parts)) <= 1
    for part in parts:  # each strip is one connected piece, so few chunks are rendered twice
        seen, todo = {part[0]}, [part[0]]
        while todo:
            r, c = T.rc(todo.pop())
            for n in part:
                if n not in seen and max(abs(T.rc(n)[0] - r), abs(T.rc(n)[1] - c)) == 1:
                    seen.add(n)
                    todo.append(n)
        assert seen == set(part)
    assert batch.strips(ring, 0) == [ring]


def test_an_interrupted_batch_keeps_its_finished_jobs(tmp_path, monkeypatch):
    from hitec_pipeline import batch

    monkeypatch.setattr(T, "STAGE", tmp_path / "stage")
    monkeypatch.setattr(batch, "PLAN", tmp_path / "stage" / "batch.json")
    monkeypatch.setattr(batch, "JOBS", tmp_path / "stage" / "jobs")
    plan = {"tids": ["r0c0", "r0c1"], "force": False, "rerender": False}
    assert batch._begin(plan) is False
    batch._job_marker([(4, 8)]).write_text("[[1, 2]]")
    assert batch.interrupted() == ["r0c0", "r0c1"]
    assert batch._begin(plan) is True and batch._job_marker([(5, 9)]).exists()  # same group of 4 × 4 chunks
    assert batch._begin({**plan, "tids": ["r0c0"]}) is False  # another batch starts clean
    assert not batch._job_marker([(4, 8)]).exists()
