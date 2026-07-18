#!/usr/bin/env python3
"""Assemble recorder.mjs's frame_*.jpg + manifest.json into an mp4.

Preserves each frame's real on-screen duration (variable frame rate) via
ffmpeg's concat demuxer, instead of flattening to a fixed fps.

Usage: assemble.py <frameDir> <outputMp4> [--hold SECONDS]
  frameDir must contain manifest.json (as written by recorder.mjs).
  --hold: extra seconds to hold on the final frame (default 1.5).
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("frame_dir", type=Path)
parser.add_argument("output_mp4", type=Path)
parser.add_argument("--hold", type=float, default=1.5)
args = parser.parse_args()

manifest = json.loads((args.frame_dir / "manifest.json").read_text())
frames = manifest["frames"]
if not frames:
    sys.exit("no frames captured — nothing to assemble")

concat_path = args.frame_dir / "concat.txt"
lines = []
for i, f in enumerate(frames):
    dur = (frames[i + 1]["t"] - f["t"]) if i + 1 < len(frames) else args.hold
    dur = max(dur, 1 / 30)  # ffmpeg drops zero/negative-duration entries
    lines.append(f"file '{f['file']}'")
    lines.append(f"duration {dur:.4f}")
lines.append(f"file '{frames[-1]['file']}'")  # concat demuxer ignores last duration
concat_path.write_text("\n".join(lines) + "\n")

subprocess.run(
    [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0", "-i", str(concat_path),
        "-vsync", "vfr",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        "-movflags", "+faststart",
        str(args.output_mp4),
    ],
    check=True,
)
print(f"wrote {args.output_mp4} ({len(frames)} frames, {frames[-1]['t'] + args.hold:.1f}s)")
