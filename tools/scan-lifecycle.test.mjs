import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('扫码取消及重开：晚到授权释放、旧播放失败不影响新会话、离开页面停流', async () => {
  const pending = [], frames = new Map(), events = {};
  let nextFrame = 0;
  const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
  const stream = () => { const track = { stopped: false, stop() { this.stopped=true; } }; return { track, getTracks: () => [track] }; };
  const video = { srcObject: null, pause() {}, play: async () => {}, readyState: 0, HAVE_ENOUGH_DATA: 4 };
  const elements = new Map([['scanVideo',video]]);
  const document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id,{ style: {}, classList: { add() {}, remove() {} }, focus() {}, addEventListener() {} });
    return elements.get(id);
  } };
  const context = vm.createContext({ document, window: { addEventListener: (name,fn) => events[name]=fn },
    navigator: { mediaDevices: { getUserMedia: () => { const d=deferred();pending.push(d);return d.promise; } } },
    requestAnimationFrame: fn => { const id=nextFrame++;frames.set(id,fn);return id; },
    cancelAnimationFrame: id => frames.delete(id)
  });
  const source = readFileSync('apps/web/prototype/app.js','utf8');
  vm.runInContext(source.slice(source.indexOf('// ================= 扫码定位'),source.indexOf('// ---- 3D 视图直接拖拽货架模式')),context);
  const first = context.startScan();
  elements.get('scan_cancel').onclick();
  const late = stream();pending.shift().resolve(late);await first;
  assert.equal(late.track.stopped,true);assert.equal(video.srcObject,null);assert.equal(frames.size,0);

  const playing = deferred(), entered = deferred(); video.play = () => { entered.resolve(); return playing.promise; };
  const oldStart=context.startScan(), oldStream=stream();pending.shift().resolve(oldStream);
  await entered.promise;
  video.play=async()=>{};
  const newStart=context.startScan(), newStream=stream();pending.shift().resolve(newStream);await newStart;
  playing.reject(new Error('旧播放已取消'));await oldStart;
  assert.equal(oldStream.track.stopped,true);assert.equal(newStream.track.stopped,false);
  assert.equal(video.srcObject,newStream);assert.equal(frames.size,1);
  events.pagehide();
  assert.equal(newStream.track.stopped,true);assert.equal(video.srcObject,null);assert.equal(frames.size,0);

  video.play=async()=>{throw new Error('播放失败');};
  const failedStart=context.startScan(), failedStream=stream();pending.shift().resolve(failedStream);await failedStart;
  assert.equal(failedStream.track.stopped,true);assert.equal(video.srcObject,null);
  assert.match(elements.get('scanMsg').textContent,/播放失败/);
});
