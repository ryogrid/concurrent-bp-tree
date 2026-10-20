const {chromium}=require('playwright');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1050},reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base=pathToFileURL(path.resolve(__dirname,'..')+path.sep).href;
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:1050});
  for(const name of ['index.html','overview.html',...['get','insert','node-insert','split','delete','merge','structure'].map(s=>'topics/'+s+'.html')]) {
   await page.goto(base+name);
   const result=await page.evaluate(()=>{
    const failures=[];let total=0;
    const fail=s=>failures.push(s);
    if(document.documentElement.scrollWidth>innerWidth+1) fail('page overflow '+document.documentElement.scrollWidth);
    for(const el of document.querySelectorAll('.stage')) {
     const m=el._mount;
     for(let i=0;i<m.count;i++) {
      m.show(i);total++;
      const step=m.steps[i], svg=m.viz.svg;
      const r=svg.getBoundingClientRect(),c=m.viz.canvas.getBoundingClientRect();
      if(r.width<c.width-1||r.height<c.height-1) fail('svg clipped '+i);
      for(const [id,entry] of m.viz.nodes) {
       const badge=entry.el.querySelector('.latch-badge');
       const expected=step.marks[id];
       if(Boolean(badge)!==Boolean(expected)) fail('badge '+i+' '+id);
       if(badge&&!badge.classList.contains(expected)) fail('badge mode '+i+' '+id);
       if(!step.state.nodes[id]||step.statuses[id]==='freed') continue;
       const nr=entry.el.getBoundingClientRect();
       if(nr.left<c.left-1||nr.right>c.right+1) fail('node outside '+i+' '+id);
       if(entry.el.scrollWidth>entry.el.clientWidth+2) fail('cells outside '+i+' '+id);
      }
      let expectedEdges=0;
      for(const [id,n] of Object.entries(step.state.nodes)) {
       if(step.statuses[id]==='freed') continue;
       expectedEdges+=n.leaf?Number(!!n.next):n.children.length;
      }
      if(svg.querySelectorAll('line').length!==expectedEdges) fail('edges '+i);
      for(const line of svg.querySelectorAll('line')) {
       for(const attr of ['x1','x2']) {const n=Number(line.getAttribute(attr));if(!Number.isFinite(n)||n<0||n>c.width) fail('edge x '+i);}
       for(const attr of ['y1','y2']) {const n=Number(line.getAttribute(attr));if(!Number.isFinite(n)||n<0||n>c.height) fail('edge y '+i);}
      }
      if(!el.querySelector('.ln.hl')) fail('source highlight '+i);
      for(const source of step.source) for(const line of source.lines) {
       if(GoSource[source.file][line.no-1]!==line.text) fail('source mismatch '+i);
      }
     }
     for(let i=m.count-1;i>=0;i--) m.show(i);
     m.show(0);
     const beforeY = scrollY;
     el.querySelector('.b-next').click();
     if(el.querySelector('.stepno').textContent !== `2 / ${m.count}`) fail('next button');
     if(scrollY !== beforeY) fail('code panel scrolled the page');
     el.querySelector('.b-prev').click();
     if(!el.querySelector('.b-prev').disabled) fail('previous button boundary');
     el.querySelector('.b-reset').click();
    }
    return {total,failures};
   });
   console.log(width,name,JSON.stringify(result));
   if(result.failures.length) process.exitCode=1;
  }
 }
 // Resize the already-mounted page, including expansion from a narrow view.
 await page.goto(base+'topics/get.html');
 for (const width of [390,1440]) {
  await page.setViewportSize({width,height:1050});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const aligned=await page.evaluate(()=>[...document.querySelectorAll('.stage')].every(el=>{
   const {svg,canvas}=el._mount.viz;
   return Math.abs(svg.viewBox.baseVal.width-canvas.clientWidth)<1;
  }));
  if(!aligned) { console.error('resize: SVG coordinates drifted');process.exitCode=1; }
 }
 const first=page.locator('.stage').first();
 await first.locator('.b-auto').click();
 await page.waitForFunction(()=>document.querySelector('.stage .stepno').textContent.startsWith('2 /'));
 await first.locator('.b-auto').click();
 if(await first.locator('.b-auto').getAttribute('aria-pressed')!=='false') process.exitCode=1;
 await first.locator('.b-reset').click();
 console.log('resize and autoplay checked');
 console.log('page errors',errors);
 if(errors.length)process.exitCode=1;
 await browser.close();
})();
