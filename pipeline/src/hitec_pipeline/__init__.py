"""HITEC City isometric map pipeline."""

from __future__ import annotations

import argparse
from pathlib import Path

DATA_ROOT = Path(__file__).resolve().parents[3] / "data"


def main() -> None:
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "tiles":  # tile-grid commands: index | status | next | run | mark-stale
        from .tiles import cli

        cli(sys.argv[2:])
        return
    if len(sys.argv) > 1 and sys.argv[1] == "corporate":  # company-to-building links for the web app
        from .corporate import cli as corporate_cli

        corporate_cli(sys.argv[2:])
        return
    if len(sys.argv) > 1 and sys.argv[1] == "residential":  # societies for the home finder
        from .residential import cli as residential_cli

        residential_cli(sys.argv[2:])
        return
    if len(sys.argv) > 1 and sys.argv[1] == "places":  # the citywide search index for the web app
        from .places import cli as places_cli

        places_cli(sys.argv[2:])
        return
    if len(sys.argv) > 1 and sys.argv[1] == "deploy":  # cut the tile archives into files a static host can serve
        from .deploy import cli as deploy_cli

        deploy_cli(sys.argv[2:])
        return

    from .area import AREAS

    parser = argparse.ArgumentParser(prog="hitec-pipeline")
    parser.add_argument("step", choices=["fetch", "normalise", "render", "all"])
    parser.add_argument("--area", default="prototype", choices=sorted(AREAS))
    parser.add_argument("--k", type=float, default=4.0, help="art pixels per metre (screen x axis)")
    parser.add_argument("--chunk", type=int, default=0, help="render chunk size in px (0 = whole canvas)")
    args = parser.parse_args()
    area = AREAS[args.area]

    if args.step in ("fetch", "all"):
        from .fetch import fetch_all

        print("raw data in", fetch_all(area, DATA_ROOT))
    if args.step in ("normalise", "all"):
        from .normalise import normalise

        print("features in", normalise(area, DATA_ROOT))
    if args.step in ("render", "all"):
        from .build import build

        print("outputs in", build(area, DATA_ROOT, k=args.k, chunk=args.chunk))
