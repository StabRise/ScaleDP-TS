"""Record real Python ScaleDP Box outputs so the TS port is diffed against
actual behaviour rather than against itself. Regenerate with:
  test/fixtures/generate-box-goldens.sh
"""
import json, math, sys
sys.path.insert(0, "/Users/mykola/PycharmProjects/ScaleDP")
from scaledp.schemas.Box import Box

def rotated_corners(cx, cy, w, h, deg):
    r = math.radians(deg)
    cos, sin = math.cos(r), math.sin(r)
    pts = [(-w/2, -h/2), (w/2, -h/2), (w/2, h/2), (-w/2, h/2)]
    return [[x*cos - y*sin + cx, x*sin + y*cos + cy] for x, y in pts]

def as_dict(b):
    return {"text": b.text, "score": b.score, "x": b.x, "y": b.y,
            "width": b.width, "height": b.height, "angle": b.angle}

cases = []

# from_polygon over a sweep of angles and aspect ratios
for deg in [0, 5, 10, 30, 45, 60, 89, 90, 91, 135, 180, 200, 269, 270, 300, 350, -30, -45]:
    for (w, h) in [(100, 20), (20, 100), (60, 60), (137, 41)]:
        pts = rotated_corners(200, 300, w, h, deg)
        cases.append({"fn": "from_polygon", "args": {"points": pts, "padding": 0},
                      "expected": as_dict(Box.from_polygon(pts))})

# padding
for pad in [0, 3, 10]:
    pts = rotated_corners(150, 150, 80, 30, 25)
    cases.append({"fn": "from_polygon", "args": {"points": pts, "padding": pad},
                  "expected": as_dict(Box.from_polygon(pts, padding=pad))})

# a diamond (min-area rect differs sharply from the axis-aligned envelope)
pts = [[10, 0], [20, 10], [10, 20], [0, 10]]
cases.append({"fn": "from_polygon", "args": {"points": pts, "padding": 0},
              "expected": as_dict(Box.from_polygon(pts))})

# degenerate
pts = [[5, 5], [5, 5], [5, 5], [5, 5]]
cases.append({"fn": "from_polygon", "args": {"points": pts, "padding": 0},
              "expected": as_dict(Box.from_polygon(pts))})

def mk(x, y, w, h, angle=0.0, text="", score=1.0):
    return Box(text=text, score=score, x=x, y=y, width=w, height=h, angle=angle)

def box_args(b):
    return {"text": b.text, "score": b.score, "x": b.x, "y": b.y,
            "width": b.width, "height": b.height, "angle": b.angle}

# iou
for (a, b) in [(mk(0,0,10,10), mk(0,0,10,10)), (mk(0,0,10,10), mk(5,0,10,10)),
               (mk(0,0,10,10), mk(100,100,10,10)), (mk(0,0,10,10), mk(0,0,10,10,45)),
               (mk(10,20,100,40), mk(30,25,100,40))]:
    cases.append({"fn": "iou", "args": {"a": box_args(a), "b": box_args(b)},
                  "expected": Box.iou(a, b)})

# scale
for (factor, pad) in [(1.0, 0), (2.0, 5), (0.5, 3)]:
    b = mk(10, 20, 100, 40, 15.0)
    cases.append({"fn": "scale", "args": {"box": box_args(b), "factor": factor, "padding": pad},
                  "expected": as_dict(b.scale(factor, padding=pad))})

# is_on_same_line
# The last two pairs are the discriminating ones: a box a few degrees off is
# still "horizontal" to Python (it branches on angle_thresh, not on a rotation
# epsilon), so it is compared by raw vertical distance. Branch on a smaller
# epsilon instead and the projection path cancels the vertical gap against the
# horizontal one, and separate lines start reading as the same line.
for (a, b) in [(mk(0,0,20,10), mk(25,2,20,10)), (mk(0,0,20,10), mk(25,40,20,10)),
               (mk(0,0,20,10,0), mk(0,0,20,10,45)), (mk(0,0,20,10,30), mk(30,17,20,10,30)),
               (mk(0,0,20,10,5), mk(100,10,20,10,5)), (mk(0,0,20,10,8), mk(60,9,20,10,8)),
               (mk(0,0,20,10,5), mk(25,2,20,10,5))]:
    cases.append({"fn": "is_on_same_line", "args": {"a": box_args(a), "b": box_args(b)},
                  "expected": Box.is_on_same_line(a, b)})

# merge_overlapping_boxes
groups = [
    [mk(0,0,20,10,text="a"), mk(10,0,20,10,text="b"), mk(20,0,20,10,text="c")],
    [mk(0,0,10,10), mk(100,0,10,10)],
    [mk(0,0,30,12,text="x"), mk(5,1,30,12,text="y"), mk(200,80,25,12,text="z")],
    # The discriminating group. Box "b" does not overlap "a", so Python emits it
    # untouched; "c" overlaps both, but by the time it merges into "a" the pass
    # is already past "b" and never goes back. A fixed-point loop keeps going
    # and collapses all three into one.
    [mk(0,0,10,10,text="a"), mk(100,0,10,10,text="b"), mk(5,0,100,10,text="c")],
    # A row of adjacent words, each overlapping only its neighbour: the shape a
    # detector actually produces, and where transitive merging turns words into
    # a line.
    [mk(0,0,30,12,text="one"), mk(28,0,30,12,text="two"), mk(56,0,30,12,text="three"),
     mk(84,0,30,12,text="four")],
]
for g in groups:
    for thr in [0.02, 0.3]:
        out = Box.merge_overlapping_boxes([Box(**box_args(b)) for b in g], iou_threshold=thr)
        cases.append({"fn": "merge_overlapping_boxes",
                      "args": {"boxes": [box_args(b) for b in g], "iou_threshold": thr},
                      "expected": [as_dict(b) for b in out]})

print(json.dumps(cases, indent=1))
