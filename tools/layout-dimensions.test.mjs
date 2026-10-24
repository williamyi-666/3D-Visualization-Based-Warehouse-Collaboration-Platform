import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('复制货架的尺寸标注随移动、旋转和缩放更新，原货架不受影响', () => {
  const source = readFileSync('apps/web/prototype/app.js', 'utf8');
  const element = () => ({
    attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
  });
  const svg = element();
  const context = vm.createContext({
    document: {createElementNS: element, getElementById: () => svg},
    SVGNS: '', layoutState: {room: {width: 12, depth: 8}}, cadShowDims: true,
    scale: 40,
    w2s: (x, z, w, d, s) => [(x + w / 2) * s + 34, (z + d / 2) * s + 34],
  });
  vm.runInContext('function layoutScale() { return scale; }', context);
  for (const [start, end] of [
    ['function drawFurnDims(', '// ---- 门/窗命中'],
    ['function updateFurnEl(', 'function renderLayout('],
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), context);
  const rack = {x: 0, z: 0, rot: 0, w: 1.2, d: .5, _el: {g: element(), tip: element()}};
  const copy = {...rack, _el: {g: element(), tip: element()}};
  context.updateFurnEl(rack);
  context.updateFurnEl(copy);
  const original = JSON.stringify(rack._el.dims);
  const line = () => copy._el.dims.children[0].attrs;
  const before = {...line()};
  copy.x = 2; copy.z = -1;
  context.updateFurnEl(copy);
  assert.equal(+line().x1 - +before.x1, 80);
  assert.equal(+line().y1 - +before.y1, -40);
  copy.rot = Math.PI / 2;
  context.updateFurnEl(copy);
  assert.ok(Math.abs(+line().x1 - +line().x2) < 1e-9);
  assert.ok(Math.abs(Math.abs(+line().y1 - +line().y2) - 48) < 1e-9);
  context.scale = 80;
  context.updateFurnEl(copy);
  assert.ok(Math.abs(Math.abs(+line().y1 - +line().y2) - 96) < 1e-9);
  assert.equal(copy._el.dims.children.length, 4);
  assert.equal(svg.children.length, 2);
  assert.equal(JSON.stringify(rack._el.dims), original);
});
