"""Record real Python DBNet post-processing outputs (get_mini_boxes,
box_score_fast, unclip, order_points_clockwise, and the full pipeline)."""
import json, sys
import numpy as np
sys.path.insert(0, "/Users/mykola/PycharmProjects/ScaleDP")
from scaledp.models.detectors.paddle_onnx.db_postprocess import DBPostProcess
from scaledp.models.detectors.paddle_onnx.predict_det import DBNetTextDetector

pp = DBPostProcess(thresh=0.5, box_thresh=0.3, max_candidates=1000,
                   unclip_ratio=2.5, use_dilation=False, score_mode="fast", box_type="quad")

cases = []

def synth_map(w, h, rects, blur=0.0):
    """Probability map with filled rectangles."""
    m = np.zeros((h, w), dtype=np.float32)
    for (x0, y0, x1, y1, v) in rects:
        m[y0:y1, x0:x1] = v
    return m

# --- get_mini_boxes ---
import cv2
polys = [
    [[10,10],[110,10],[110,50],[10,50]],
    [[20,5],[80,25],[70,55],[10,35]],
    [[0,0],[40,0],[40,40],[0,40]],
]
for p in polys:
    arr = np.array(p, dtype=np.float32).reshape(-1,1,2)
    pts, sside = pp.get_mini_boxes(arr)
    cases.append({"fn":"get_mini_boxes","args":{"points":p},
                  "expected":{"points":np.array(pts).tolist(),"sside":float(sside)}})

# --- unclip -> mini box (what the pipeline actually composes) ---
for p in polys:
    arr = np.array(p, dtype=np.float32)
    box = pp.unclip(arr, 2.5).reshape(-1,1,2)
    pts, sside = pp.get_mini_boxes(box)
    cases.append({"fn":"unclip_minibox","args":{"points":p,"unclip_ratio":2.5},
                  "expected":{"points":np.array(pts).tolist(),"sside":float(sside)}})

# --- box_score_fast ---
m = synth_map(120, 80, [(10,10,110,50,0.9), (0,60,20,75,0.4)])
for p in [[[10,10],[110,10],[110,50],[10,50]],
          [[0,60],[20,60],[20,75],[0,75]],
          [[60,0],[119,0],[119,20],[60,20]]]:
    arr = np.array(p, dtype=np.float32)
    cases.append({"fn":"box_score_fast",
                  "args":{"map":m.tolist(),"width":120,"height":80,"points":p},
                  "expected": float(pp.box_score_fast(m, arr))})

# --- order_points_clockwise ---
for p in [[[110,50],[10,10],[110,10],[10,50]],
          [[0,0],[10,10],[10,0],[0,10]]]:
    cases.append({"fn":"order_points_clockwise","args":{"points":p},
                  "expected": DBNetTextDetector.order_points_clockwise(None, np.array(p, dtype=np.float32)).tolist()})

# --- full pipeline: boxes_from_bitmap ---
for rects in ([(10,10,110,50,0.9)],
              [(10,10,60,40,0.9),(70,10,115,40,0.8)],
              [(5,5,15,15,0.9)],
              []):
    m = synth_map(160, 100, rects)
    seg = m > 0.5
    boxes, scores = pp.boxes_from_bitmap(m, seg, 160, 100, 1.0, 1.0)
    cases.append({"fn":"boxes_from_bitmap",
                  "args":{"map":m.tolist(),"width":160,"height":100,
                          "dest_width":160,"dest_height":100,"ratio":1.0},
                  "expected":{"boxes":np.array(boxes).tolist(),
                              "scores":[float(s) for s in scores]}})

print(json.dumps(cases))
