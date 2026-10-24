"""为现有1号库区生成货架外观；坐标、层板高度与平台格位一致，不含假库存。"""
import os
import sys
import bpy

sys.path.insert(0, os.path.dirname(__file__))
from rack_template import clear_scene, add_box, export, COLORS

OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../output/blender-current-room'))
COLORS['Upright'] = ((0.035, 0.16, 0.31, 1), 0.55, 0.38)
COLORS['Beam'] = ((0.95, 0.25, 0.035, 1), 0.35, 0.4)
COLORS['Shelf'] = ((0.43, 0.52, 0.57, 1), 0.65, 0.45)

for name, w, h, d, rows in [('rack-5x6', 1.2, 2, .5, 5), ('rack-1x2', 1.2, 1.8, .4, 1)]:
    clear_scene()
    layer = h / rows
    board = min(.05, layer * .14)
    post = min(.05, min(w, d) * .09)
    # 开放顶层：立柱只到最上层板，与 spaceGenerator 相同。
    post_h = h - layer
    if post_h > 0:
        for x in (-w / 2 + post / 2, w / 2 - post / 2):
            for y in (-d / 2 + post / 2, d / 2 - post / 2):
                add_box('Upright', 'Upright', x, y, post_h / 2, post, post, post_h)
    for r in range(rows):
        z = layer * r
        add_box('Deck', 'Shelf', 0, 0, z, w, d, board)
        for y in (-d / 2 + .015, d / 2 - .015):
            add_box('Beam', 'Beam', 0, y, z, w, .03, board)
    bpy.context.scene.unit_settings.system = 'METRIC'
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, name + '.blend'))
    export(os.path.join(OUT, name + '.glb'))
