# 写实模板生成器（在 Blender 里运行）
#
# 用法一：Blender 打开 → Scripting 工作区 → 打开本文件 → Run Script
#         （改下面的参数后运行，会在 OUTPUT 目录得到 .glb）
# 用法二：命令行无界面导出
#         blender --background --python tools/blender/rack_template.py -- --mode rack --out "C:/tmp/rack.glb"
#
# 坐标系约定（重要，必须和平台一致）：
#   Blender 里按 Z 向上建模：X=宽(width)，Y=深(depth)，Z=高(height)
#   底面贴地(z=0)、在 X/Y 上居中 → 导出 GLB 时勾选 Y-up，
#   glTF 会把 Blender 的 Z 转成 Y，得到平台的「底座中心为原点、X 宽 / Y 高 / Z 深」。
#
# 导出后在平台：🧊 模型 → 选库位 → 上传 → 顶栏切「🎨 写实」即可看到。

import bpy
import sys
import os
import argparse

# ==================== 可调参数 ====================
MODE = "rack"          # rack（仓库货架） / pallet（地面托盘） / room（房间外壳）
OUTPUT = "C:/Users/Administrator/WorkBuddy/AI空间管理/spatial-inventory/tools/out/blender_export.glb"

WIDTH = 1.2            # 宽（沿 X）
DEPTH = 0.5            # 深（沿 Y）
HEIGHT = 2.5           # 高（沿 Z）
ROWS = 7               # 层数
COLS = 6               # 列数

# 构件尺寸（米）
POST = 0.05            # 立柱截面
BEAM_H = 0.045         # 横梁高
BEAM_D = 0.03          # 横梁厚（沿深度方向）
BOARD = 0.022          # 层板厚
BOTTOM = 0.05          # 最底层离地高度

# 配色（典型仓储货架）
COLORS = {
    "Upright": ((0.95, 0.42, 0.08, 1), 0.25, 0.45),   # 橙：立柱
    "Beam":    ((0.13, 0.36, 0.72, 1), 0.35, 0.40),   # 蓝：横梁
    "Shelf":   ((0.74, 0.71, 0.64, 1), 0.05, 0.80),   # 浅灰：层板
    "Pallet":  ((0.66, 0.47, 0.28, 1), 0.00, 0.90),   # 木色：托盘
    "Room":    ((0.86, 0.86, 0.82, 1), 0.00, 0.95),   # 墙/地面
}
# =================================================


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials):
        for b in list(block):
            if b.users == 0:
                block.remove(b)


def mat(name):
    """取（或建）一个 Principled BSDF 材质，glTF 导出器能识别其金属度/粗糙度。"""
    m = bpy.data.materials.get(name)
    if m:
        return m
    rgba, metallic, rough = COLORS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = rough
    return m


def add_box(name, material, cx, cy, cz, sx, sy, sz):
    """建一个轴对齐盒子：中心 (cx,cy,cz)、尺寸 (sx,sy,sz)。"""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(cx, cy, cz))
    o = bpy.context.active_object
    o.name = name
    o.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(mat(material))
    return o


def build_rack(width=WIDTH, depth=DEPTH, height=HEIGHT, rows=ROWS, cols=COLS):
    """仓库货架：立柱 + 每层前后横梁 + 层板。底面 z=0，X/Y 居中。"""
    post = min(POST, width / 12.0)
    post_z = min(POST, depth / 6.0)          # 沿深度方向的立柱厚度
    beam_d = min(BEAM_D, depth / 8.0)
    board = min(BOARD, height / 80.0)

    # 立柱：cols 列 → cols+1 根，前后两排；外侧立柱外沿与 ±width/2 齐平
    n = max(2, cols + 1)
    inner = max(0.0, width - post)
    for i in range(n):
        cx = -width / 2 + post / 2 + (i * inner) / (n - 1)
        for cy in (-depth / 2 + post_z / 2, depth / 2 - post_z / 2):
            add_box("post", "Upright", cx, cy, height / 2, post, post_z, height)

    # 层：横梁 + 层板
    spacing = max(0.06, (height - BOTTOM - 0.02) / rows)
    for i in range(rows):
        z = BOTTOM + i * spacing
        for cy in (-depth / 2 + beam_d / 2, depth / 2 - beam_d / 2):
            add_box("beam", "Beam", 0, cy, z + BEAM_H / 2, width, beam_d, BEAM_H)
        add_box("board", "Shelf", 0, 0, z + BEAM_H, width - post * 0.5, depth - beam_d * 2, board)

    # 顶部横梁
    for cy in (-depth / 2 + beam_d / 2, depth / 2 - beam_d / 2):
        add_box("beam_top", "Beam", 0, cy, height - BEAM_H / 2, width, beam_d, BEAM_H)


def build_pallet(width=3.0, depth=2.0, height=0.05):
    """地面托盘：上下铺板 + 三根纵梁。"""
    deck = max(0.012, height * 0.25)
    board_w = min(0.16, depth / 7.0)
    n = max(3, int(round(depth / (board_w * 1.55))))
    step = depth / n
    for i in range(n):
        cy = -depth / 2 + step * (i + 0.5)
        add_box("deck_top", "Pallet", 0, cy, height - deck / 2, width, board_w, deck)
        add_box("deck_bot", "Pallet", 0, cy, deck / 2, width, board_w, deck)
    str_w = min(0.14, depth / 5.0)
    for cy in (-depth / 2 + str_w / 2, 0.0, depth / 2 - str_w / 2):
        add_box("stringer", "Pallet", 0, cy, height / 2, width, str_w, max(0.02, height - deck * 2))


def build_room(width=12.0, depth=8.0, height=4.0, wall=0.12):
    """房间外壳：地板 + 四面墙。用于「整间库区」级模型（会替换掉参数化房间）。"""
    add_box("floor", "Room", 0, 0, -0.01, width, depth, 0.02)
    add_box("wall_back",  "Room", 0, -depth / 2, height / 2, width, wall, height)
    add_box("wall_front", "Room", 0, depth / 2, height / 2, width, wall, height)
    add_box("wall_left",  "Room", -width / 2, 0, height / 2, wall, depth, height)
    add_box("wall_right", "Room", width / 2, 0, height / 2, wall, depth, height)


def export(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_yup=True,          # 关键：Blender Z-up → glTF Y-up
        export_apply=True,        # 应用修改器/变换，避免导出后尺寸偏移
        export_materials='EXPORT',
    )
    print("已导出 ->", path, os.path.getsize(path), "字节")


def main(mode=MODE, out=OUTPUT):
    clear_scene()
    if mode == "pallet":
        build_pallet()
    elif mode == "room":
        build_room()
    else:
        build_rack()
    export(out)


if __name__ == "__main__":
    # 命令行模式：blender --background --python 本文件 -- --mode rack --out xxx.glb
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
        ap = argparse.ArgumentParser()
        ap.add_argument("--mode", default=MODE)
        ap.add_argument("--out", default=OUTPUT)
        a = ap.parse_args(argv)
        main(a.mode, a.out)
    else:
        # 在 Blender 的 Scripting 面板里点 Run Script
        main()
