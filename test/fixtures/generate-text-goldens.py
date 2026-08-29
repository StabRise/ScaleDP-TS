"""Record Python ScaleDP text-reconstruction outputs (cluster / get_size /
box_to_formatted_text). Regenerate with generate-text-goldens.sh."""
import json, sys
sys.path.insert(0, "/Users/mykola/PycharmProjects/ScaleDP")
from scaledp.utils import cluster, get_size
from scaledp.schemas.Box import Box
from scaledp.models.recognizers.BaseOcr import BaseOcr

cases = []

cluster_inputs = [
    ([1, 2, 3, 10, 11, 30], 2),
    ([5], 3),
    ([], 2),
    ([0, 0, 0, 100], 1),
    ([10, 12, 14, 16, 40, 42], 3),
]
for data, gap in cluster_inputs:
    cases.append({"fn": "cluster", "args": {"items": data, "max_gap": gap},
                  "expected": cluster(data, gap, key=lambda x: x)})

size_inputs = [
    [10], [10, 12], [10, 12, 14], [10, 12, 14, 16],
    [10, 10, 10, 12, 12, 40, 5, 10],
    [3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8],
    [20]*10 + [100],
]
for data in size_inputs:
    cases.append({"fn": "get_size", "args": {"items": data},
                  "expected": get_size(data, key=lambda x: x)})

def mk(text, x, y, w, h):
    return Box(text=text, score=1.0, x=x, y=y, width=w, height=h, angle=0.0)

layouts = [
    [mk("Hello", 10, 10, 50, 12), mk("world", 70, 10, 50, 12)],
    [mk("Name:", 10, 10, 48, 12), mk("Raja", 200, 11, 40, 12),
     mk("Total", 10, 60, 48, 12), mk("100", 200, 61, 30, 12)],
    [mk("A", 10, 10, 10, 12), mk("B", 10, 200, 10, 12)],
    [mk("one", 0, 0, 30, 10), mk("two", 35, 1, 30, 10), mk("three", 200, 0, 50, 10)],
]
for boxes in layouts:
    args = [{"text": b.text, "x": b.x, "y": b.y, "width": b.width, "height": b.height} for b in boxes]
    for tol in [0, 5]:
        cases.append({"fn": "box_to_formatted_text",
                      "args": {"boxes": args, "line_tolerance": tol},
                      "expected": BaseOcr.box_to_formatted_text(boxes, line_tolerance=tol)})
    # get_character_width takes grouped lines, so reproduce the grouping here.
    grouped = cluster(list(boxes), get_size(boxes, lambda x: x.height) / 3, key=lambda i: int(i.y))
    grouped = [sorted(xs, key=lambda i: int(i.x)) for xs in grouped]
    cases.append({"fn": "get_character_width", "args": {"boxes": args},
                  "expected": BaseOcr.get_character_width(grouped)})

print(json.dumps(cases, indent=1))
