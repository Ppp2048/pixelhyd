"""HITEC City isometric map pipeline."""

from __future__ import annotations

import argparse
from pathlib import Path

DATA_ROOT = Path(__file__).resolve().parents[3] / "data"


def main() -> None:
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
