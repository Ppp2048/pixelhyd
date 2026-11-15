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
    assert T.owner_of(HITEC_CITY.core[0] - 1, HITEC_CITY.core[1]) is None


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
    assert all(0 <= cx * T.CHUNK < proj.width and 0 <= cy * T.CHUNK < proj.height for cx, cy in chunks)


def test_chunks_align_with_output_tiles():
    proj = T.global_projection()
    assert T.CHUNK % 256 == 0 and proj.origin_world % T.CHUNK == 0


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
    with open(tmp_path / "overlay.pmtiles", "rb") as f:
        data = Reader(MmapSource(f)).get(z, tx, ty)
    layers = mapbox_vector_tile.decode(gzip.decompress(data), default_options={"y_coord_down": True})
    props = layers["building"]["features"][0]["properties"]
    assert props["id"] == "b1" and props["height_m"] == 12.5 and "name" not in props  # nulls dropped
