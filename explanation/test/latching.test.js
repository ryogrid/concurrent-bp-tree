const {test}=require('node:test');
const assert=require('node:assert/strict');
global.BptreeSim=require('../shared/bptree-sim.js').BptreeSim;
require('../shared/latching-viz.js');
test('interleavings preserve ownership, compatibility and guarded handoff',()=>{
 const scenarios=makeLatchScenarios();
 for(const q of Object.values(scenarios)) {
  for(let i=1;i<q.frames.length;i++) {
   const f=q.frames[i], prev=q.frames[i-1], e=f.event;
   for(const hs of Object.values(f.holders)) {
    assert.equal(new Set(hs.map(h=>h[0])).size,hs.length);
    if(hs.some(h=>h[1]==='W')) assert.equal(hs.length,1);
   }
   const held=(id,mode)=> (prev.holders[id]||[]).some(([t,m])=>t===e.t&&(!mode||m===mode));
   if(e.guard) assert.ok(held(e.guard));
   if(e.type==='release') assert.ok(held(e.id));
   if(e.type==='change') for(const id of e.ids) assert.ok(held(id,'W'));
   if(e.type==='try'&&!e.ok) assert.equal(f.waiting[e.t],undefined);
   if(e.type==='take'&&!e.ok) assert.equal(f.waiting[e.t].id,e.id);
  }
  assert.deepEqual(q.frames.at(-1).holders,{});
  assert.deepEqual(q.frames.at(-1).waiting,{});
 }
 const scan=scenarios.scanDelete;
 assert.deepEqual(scan.frames[0].state,scan.frames.at(-1).state);
 assert.equal(scenarios.readWrite.sim.pages.get(2).vals[1],9999);
 assert.ok(scenarios.disjointWrites.sim.pages.get(1).keys.includes(15));
 assert.ok(scenarios.disjointWrites.sim.pages.get(7).keys.includes(125));
 assert.ok(scenarios.unsafeSplit.sim.root.children[1].keys.includes(130));
});
