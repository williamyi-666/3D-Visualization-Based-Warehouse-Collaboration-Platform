"""用平台布局生成仓库外观。Blender Z-up -> GLB Y-up；格位与库存仍由平台管理。

blender --background --python tools/blender/build_warehouse.py -- --layout layout.json --out output/warehouse
"""
import argparse
import json
import math
from pathlib import Path
import sys
import bpy
from mathutils import Vector

parser = argparse.ArgumentParser()
parser.add_argument('--layout', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--render', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
layout = json.loads(Path(args.layout).read_text(encoding='utf8'))
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1


def material(name, color, metal=0, rough=.55):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Metallic'].default_value = metal
    p.inputs['Roughness'].default_value = rough
    return m


steel = material('Galvanized steel', (.43, .52, .59), .65, .38)
blue = material('Blue powder coated uprights', (.025, .13, .26), .4, .38)
orange = material('Orange beams', (.95, .28, .045), .25, .4)
concrete = material('Concrete floor', (.37, .41, .43), 0, .88)
wall = material('Light industrial wall', (.75, .79, .79), .05, .75)
dark = material('Dark trim', (.075, .11, .15), .35, .5)
yellow = material('Safety yellow', (1, .67, .045), .05, .5)
white = material('White markings', (.92, .95, .94), 0, .65)
glass = material('Window blue', (.29, .53, .62), .25, .24)
green = material('Exit sign', (.03, .43, .27), 0, .55)


def box(name, pos, dimensions, mat, parent=None, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    o = bpy.context.object
    o.name = name
    o.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    if bevel:
        mod = o.modifiers.new('Edge detail', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
        bpy.ops.object.modifier_apply(modifier=mod.name)
    if parent:
        o.parent = parent
    return o


def text(body, pos, size=.12, mat=white, parent=None, upright=False):
    bpy.ops.object.text_add(location=pos, rotation=(math.pi / 2, 0, 0) if upright else (0, 0, 0))
    o = bpy.context.object
    o.name = 'Label ' + body
    o.data.body = body
    o.data.size = size
    o.data.align_x = 'CENTER'
    o.data.extrude = .0004
    o.data.materials.append(mat)
    bpy.ops.object.convert(target='MESH')
    if parent:
        o.parent = parent
    return o


w, d, h = (layout['room'][key] for key in ('width', 'depth', 'height'))
box('Warehouse concrete slab', (0, 0, -.08), (w, d, .16), concrete, bevel=.025)
# 前墙、右墙和屋顶作剖切展示，便于浏览与点击内部格位。
door_x, door_w, door_h = w / 2 - 2.7, 2.1, min(2.7, h - .4)
for x0, x1 in [(-w / 2, door_x - door_w / 2), (door_x + door_w / 2, w / 2)]:
    box('Back wall', ((x0 + x1) / 2, d / 2, h / 2), (x1 - x0, .12, h), wall)
box('Door lintel', (door_x, d / 2, (door_h + h) / 2), (door_w, .12, h - door_h), wall)
box('Left wall sill', (-w / 2, 0, .55), (.12, d, 1.1), wall)
box('Left wall upper', (-w / 2, 0, (h + 2.5) / 2), (.12, d, h - 2.5), wall)
for y in (-d / 2 + .14, -2.6, .7, 3.9, d / 2 - .14):
    box('Left wall pilaster', (-w / 2, y, h / 2), (.19, .18, h), dark)
for y in (-4.1, -.9, 2.3, 4.9):
    box('High window pane', (-w / 2 + .015, y, 1.8), (.035, 2.5, 1.25), glass)
    for z in (1.17, 2.43):
        box('Window sill', (-w / 2 + .06, y, z), (.12, 2.6, .045), steel)
    box('Window mullion', (-w / 2 + .06, y, 1.8), (.1, .045, 1.3), steel)
box('Loading shutter', (door_x, d / 2 - .07, door_h / 2), (door_w - .1, .06, door_h - .04), steel)
for i in range(19):
    box('Shutter slat', (door_x, d / 2 - .12, .08 + i * (door_h - .16) / 18), (door_w - .13, .018, .025), dark)
box('Door header sign', (door_x, d / 2 - .1, door_h + .24), (1.55, .035, .23), blue)
text('LOADING / EXIT', (door_x, d / 2 - .125, door_h + .17), .13, white, upright=True)
box('Exit green sign', (-3.7, d / 2 - .1, 2.8), (1.25, .035, .28), green)
text('WAREHOUSE', (-3.7, d / 2 - .125, 2.73), .13, white, upright=True)
for x in (-w / 2 + .25, w / 2 - .25):
    box('Floor perimeter line', (x, 0, .003), (.045, d - .5, .006), yellow)
for y in (-d / 2 + .25, d / 2 - .25):
    box('Floor perimeter line', (0, y, .003), (w - .5, .045, .006), yellow)
for y in (-.6, .6):
    box('Main aisle edge', (0, y, .004), (5.15, .045, .008), yellow)
for x in (-2.2, -1.35, -.5, .35, 1.2, 2.05):
    box('Main aisle dash', (x, 0, .005), (.4, .035, .01), white)
text('1.2 m CLEAR AISLE', (0, -.42, .012), .12)
text('16 m x 12 m  /  DEMONSTRATION', (0, -d / 2 + .65, .012), .24)

anchors = []
for f in layout['furniture']:
    root = bpy.data.objects.new('RACK_' + f['code'], None)
    bpy.context.collection.objects.link(root)
    root.location = (f['x'], -f['z'], 0)
    root.rotation_euler.z = f.get('rot', 0)
    root['loc_code'] = f['code']
    rw, rd, rh, rows, cols = (f[k] for k in ('w', 'd', 'h', 'rows', 'cols'))
    if f['type'] == 'floor':
        for y in (-rd / 2, rd / 2):
            box('Floor storage boundary', (0, y, .008), (rw, .045, .016), yellow, root)
        for x in (-rw / 2, rw / 2):
            box('Floor storage boundary', (x, 0, .008), (.045, rd, .016), yellow, root)
        for r in range(1, rows):
            box('Floor storage division', (0, -rd / 2 + rd * r / rows, .007), (rw, .025, .014), white, root)
        for c in range(1, cols):
            box('Floor storage division', (-rw / 2 + rw * c / cols, 0, .007), (.025, rd, .014), white, root)
        for r in range(rows):
            for c in range(cols):
                code = f"{f['code']}-L{r+1:02d}-B{c+1:02d}"
                anchor = bpy.data.objects.new('LOC_' + code, None)
                bpy.context.collection.objects.link(anchor)
                anchor.parent = root
                anchor.location = (-rw / 2 + rw * (c + .5) / cols,
                                   rd / 2 - rd * (r + .5) / rows, .04)
                anchor['loc_code'] = code
                anchors.append(code)
        text('FLOOR STORAGE', (0, -rd / 2 - .3, .012), .14, white, root)
        continue
    post = .036
    for x in (-rw / 2 + post / 2, rw / 2 - post / 2):
        for y in (-rd / 2 + post / 2, rd / 2 - post / 2):
            box('Rack upright', (x, y, rh / 2), (post, post, rh), blue, root, .003)
            box('Base plate', (x, y, .012), (.085, .085, .024), steel, root)
            box('Column guard', (x, y, .12), (.052, .052, .18), yellow, root)
    layer = rh / rows
    for r in range(rows):
        z = r * layer
        box('Shelf deck', (0, 0, z + .01), (rw - .025, rd - .025, .018), steel, root)
        for y in (-rd / 2 + .01, rd / 2 - .01):
            box('Shelf load beam', (0, y, z + .005), (rw, .025, .04), orange, root)
        for c in range(cols):
            suffix = f'L{r+1:02d}-B{c+1:02d}'
            x = -rw / 2 + rw * (c + .5) / cols
            box('Shelf location label', (x, -rd / 2 - .006, z + .008), (min(.27, rw / cols * .8), .009, .045), white, root)
            text(suffix, (x, -rd / 2 - .012, z - .004), min(.034, rw / cols * .1), dark, root, True)
            code = f['code'] + '-' + suffix
            anchor = bpy.data.objects.new('LOC_' + code, None)
            bpy.context.collection.objects.link(anchor)
            anchor.parent = root
            anchor.location = (x, 0, z + layer / 2)
            anchor['loc_code'] = code
            anchors.append(code)
    box('Rack ID plate', (0, -rd / 2, rh + .055), (min(.6, rw * .7), .025, .12), blue, root, .004)
    text('RACK ' + f['code'].split('-')[-1], (0, -rd / 2 - .016, rh + .02), .075, white, root, True)

scene.world.color = (.65, .68, .72)
for location, energy, size in [((0, -3, 9), 2400, 10), ((-5, 3, 8), 1700, 8)]:
    bpy.ops.object.light_add(type='AREA', location=location)
    light = bpy.context.object
    light.data.energy = energy
    light.data.shape = 'DISK'
    light.data.size = size
bpy.ops.object.camera_add(location=(14, -18, 14))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, 1)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 22
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.threads_mode = 'FIXED'
scene.render.threads = 4
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = str(out / 'warehouse-preview.png')
scene.view_settings.view_transform = 'AgX'
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'warehouse.blend'))
bpy.ops.export_scene.gltf(filepath=str(out / 'warehouse.glb'), export_format='GLB', export_cameras=False, export_lights=False, export_extras=True)
(out / 'model-manifest.json').write_text(json.dumps({'copyright':'2026 零九贰幺', 'license':'MIT', 'room':layout['room'], 'furniture_count':len(layout['furniture']), 'cell_anchors':anchors, 'inventory_baked':False, 'axis':'Blender (x,-z,y) -> GLB (x,y,z)', 'view':'剖切外观，前墙、右墙及屋顶开放', 'decorative_openings':'门窗为外观展示，未配置为业务布局的门窗对象'}, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print('WAREHOUSE_GLB_BYTES', (out / 'warehouse.glb').stat().st_size, flush=True)
if args.render:
    bpy.ops.render.render(write_still=True)
