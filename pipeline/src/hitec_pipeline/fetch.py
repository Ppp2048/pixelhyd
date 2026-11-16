"""Download raw data for an area (bbox only) and record provenance.

Sources:
- Overture Maps buildings (GeoParquet, via the official `overturemaps` CLI).
- OpenStreetMap via the Overpass API (all tagged features with geometry).

Each download is recorded in data/raw/<area>/manifest.json with the query,
time, source version and file hash, so a run can be reproduced or audited.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from .area import Area

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "hitec-city-pipeline/0.1 (research prototype)"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _record(manifest: Path, entry: dict) -> None:
    data = json.loads(manifest.read_text(encoding="utf-8")) if manifest.exists() else {"downloads": []}
    data["downloads"] = [d for d in data["downloads"] if d["file"] != entry["file"]]
    data["downloads"].append(entry)
    manifest.write_text(json.dumps(data, indent=2), encoding="utf-8")


def fetch_overture_buildings(area: Area, out_dir: Path, release: str | None = None) -> Path:
    west, south, east, north = area.wgs_bbox()
    out = out_dir / "overture_buildings.parquet"
    bbox = f"{west:.6f},{south:.6f},{east:.6f},{north:.6f}"
    exe = shutil.which("overturemaps", path=str(Path(sys.executable).parent))
    cmd = [exe or "overturemaps", "download", f"--bbox={bbox}", "-f", "geoparquet", "--type=building", "-o", str(out)]
    if release:  # pin a release so every tile uses the same building IDs
        cmd += ["--release", release]
    subprocess.run(cmd, check=True)
    _record(
        out_dir / "manifest.json",
        {
            "file": out.name,
            "source": f"Overture Maps Foundation — buildings theme (release {release or 'latest'})",
            "licence": "ODbL 1.0 (per-feature sources listed in `sources`)",
            "query": " ".join(cmd[1:]),
            "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "sha256": _sha256(out),
            "bytes": out.stat().st_size,
        },
    )
    return out


def _overpass(query: str, attempts: int = 6, timeout: int = 300) -> bytes:
    body = urllib.parse.urlencode({"data": query}).encode()
    for i in range(attempts):
        req = urllib.request.Request(OVERPASS_URL, data=body, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
            if data.lstrip().startswith(b"{"):
                return data
        except Exception as exc:  # network errors and 429/504 are retried
            print(f"overpass attempt {i + 1} failed: {exc}", file=sys.stderr)
        time.sleep(15 * (i + 1))
    raise RuntimeError("Overpass API unavailable after retries")


def fetch_osm(area: Area, out_dir: Path, timeout: int = 180) -> Path:
    west, south, east, north = area.wgs_bbox()
    bb = f"({south:.6f},{west:.6f},{north:.6f},{east:.6f})"
    # Everything tagged that we may draw or inspect; geometry included.
    query = f"""[out:json][timeout:{timeout}];
(
  way[building]{bb}; relation[building]{bb};
  way[highway]{bb};
  way[railway]{bb};
  way[landuse]{bb}; relation[landuse]{bb};
  way[leisure]{bb}; relation[leisure]{bb};
  way[natural]{bb}; relation[natural]{bb}; node[natural=tree]{bb};
  way[amenity]{bb}; node[amenity]{bb};
  way[waterway]{bb};
  node[shop]{bb}; node[office]{bb}; way[office]{bb};
  way["man_made"]{bb};
);
out geom qt;"""
    data = _overpass(query, timeout=timeout + 120)
    out = out_dir / "osm.json"
    out.write_bytes(data)
    base = json.loads(data).get("osm3s", {}).get("timestamp_osm_base")
    _record(
        out_dir / "manifest.json",
        {
            "file": out.name,
            "source": "OpenStreetMap contributors via Overpass API",
            "licence": "ODbL 1.0",
            "query": query,
            "osm_base": base,
            "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "sha256": _sha256(out),
            "bytes": out.stat().st_size,
        },
    )
    return out


def fetch_all(area: Area, data_root: Path, release: str | None = None, osm_timeout: int = 180) -> Path:
    out_dir = data_root / "raw" / area.name
    out_dir.mkdir(parents=True, exist_ok=True)
    fetch_overture_buildings(area, out_dir, release)
    fetch_osm(area, out_dir, osm_timeout)
    return out_dir
