import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftHistory} from '../apps/web/prototype/draft-history.mjs';
test('布局历史保留版本与删除标志，去掉运行时对象，撤销后新修改丢弃重做分支',()=>{
 const history=createDraftHistory(2),base={state:{revision:'old',furniture:[{code:'A',x:0}]},replace:false};
 history.reset(base);const moved=structuredClone(base);moved.state.furniture[0].x=2;
 const el={};el.self=el;moved.state.furniture[0]._el=el;
 history.push(moved);history.push(moved);assert.equal(history.canUndo,true);
 assert.deepEqual(history.undo(),base);assert.equal(history.dirty,false);assert.equal(history.canUndo,false);
 assert.equal(history.redo().state.furniture[0].x,2);
 const deleted={state:{revision:'old',furniture:[]},replace:true};history.push(deleted);
 assert.equal(history.undo().replace,false);assert.deepEqual(history.redo(),deleted);
 history.undo();history.push({...base,replace:true});assert.equal(history.canRedo,false);
 history.push({...base,state:{...base.state,revision:'new'}});assert.equal(history.dirty,true);
 history.reset(base);assert.equal(history.dirty,false);assert.equal(history.canRedo,false);
});
