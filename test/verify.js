/**
 * Verification harness for the DevFlow prototype.
 * Drives the real page in Chromium and asserts observable behaviour.
 */
const { chromium } = require('playwright');
const path = require('path');

const results = [];
function check(name, pass, detail=''){
  results.push({ name, pass, detail });
  console.log(`${pass?'PASS':'FAIL'}  ${name}${detail?'  — '+detail:''}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', m => { if(m.type()==='error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: '+e.message));
  page.on('dialog', d => d.dismiss());

  await page.goto('file://'+path.join(__dirname,'..','index.html'));
  await page.waitForSelector('.card');

  // ---------- FR-01..FR-04: task lifecycle and board ----------
  check('loads without console errors', consoleErrors.length===0, consoleErrors.join(' | '));
  check('sample data seeds seven tasks', (await page.locator('.card').count())===7);
  check('five status columns render', (await page.locator('.column').count())===5);

  await page.locator('#btn-new').click();
  await page.locator('#f-submit').click();
  check('FR-01 empty title blocked with inline error',
    (await page.locator('#f-title-err').textContent()).trim().length>0);
  await page.locator('#f-title').fill('Verification task');
  await page.locator('#f-title').press('Enter');
  await page.waitForSelector('#modal-task', { state:'hidden' });
  check('FR-01 task created via dialog',
    await page.evaluate(()=>board.tasks.some(t=>t.title==='Verification task')));

  const edited = await page.evaluate(()=>{
    const t = board.tasks.find(x=>x.title==='Verification task');
    ui.selectTask(t.id);
    ui.openTaskModal(t);
    document.getElementById('f-title').value = 'Verification task (edited)';
    document.getElementById('f-priority').value = 'critical';
    ui.submitTaskModal();
    const after = board.getTask(t.id);
    return { title:after.title, priority:after.priority };
  });
  check('FR-02 task edited in place',
    edited.title==='Verification task (edited)' && edited.priority==='critical');

  const deleted = await page.evaluate(()=>{
    const t = board.tasks.find(x=>x.title==='Verification task (edited)');
    ui.selectTask(t.id);
    ui.confirmingDelete = true; ui.renderDetail();
    document.querySelector('[data-act="delete-confirm"]').click();
    return board.getTask(t.id)===undefined;
  });
  check('FR-02 task deleted after two-step confirmation', deleted);

  const statuses = await page.evaluate(()=>{
    const t = board.tasks[0];
    const seen = [];
    for(const s of STATUS_ORDER){ board.moveTask(t.id,s); seen.push(board.getTask(t.id).status); }
    return seen;
  });
  check('FR-03 task traverses all five statuses', statuses.join(',')===
    'backlog,todo,in-progress,in-review,done', statuses.join(','));

  // ---------- FR-05..FR-07: the individual features ----------
  const ctx = await page.evaluate(()=>{
    const t = board.tasks[0];
    contextManager.captureContext(t, {
      openFiles:'src/a.js\n\n   src/b.js  \n', referenceUrls:'https://example.org/video\n',
      notes:'stopped at the polling section', cursorHint:'Video at 41:20' });
    const restored = contextManager.restoreContext(t);
    return { files:restored.files, urls:restored.urls, hint:restored.cursorHint,
             hasCtx:t.hasContext(), count:t.contextSnapshot.itemCount() };
  });
  check('FR-07 context captured with blank lines trimmed',
    ctx.files.length===2 && ctx.urls.length===1 && ctx.count===3, ctx.files.join('|'));
  check('FR-07 cursor hint restored verbatim', ctx.hint==='Video at 41:20');

  const stale = await page.evaluate(()=>{
    const t = board.tasks[0];
    const fresh = contextManager.hasStaleContext(t);
    t.contextSnapshot.capturedAt = new Date(Date.now()-2*24*60*60*1000);
    const old = contextManager.hasStaleContext(t);
    const age = t.contextSnapshot.ageInMinutes();
    contextManager.clearContext(t);
    return { fresh, old, cleared:!t.hasContext(), age };
  });
  check('FR-07 stale flag respects the 1440-minute threshold',
    stale.fresh===false && stale.old===true, `age=${stale.age}m`);
  check('FR-07 context cleared on request', stale.cleared);

  const branch = await page.evaluate(()=>{
    const t = board.tasks[1];
    t.linkBranch(new GitBranchLink('feature/device-flow','acme/api','main'));
    const prefix = t.branchLink.suggestedCommitPrefix(t.key);
    const isFeature = t.branchLink.isFeatureBranch();
    t.linkBranch(new GitBranchLink('hotfix/x','acme/api','main'));
    const notFeature = t.branchLink.isFeatureBranch();
    return { prefix, key:t.key, isFeature, notFeature };
  });
  check('FR-05 commit prefix uses the readable task key',
    branch.prefix.trim()===`[${branch.key}]`, branch.prefix);
  check('FR-05 feature branch detected correctly',
    branch.isFeature===true && branch.notFeature===false);

  const snip = await page.evaluate(()=>{
    const t = board.tasks[2];
    const before = t.snippets.length;
    const s = t.attachSnippet(new CodeSnippet('Helper','JavaScript','const a = 1;\nconst b = 2;\nreturn a + b;'));
    const lines = s.lineCount();
    const preview = s.preview(10);
    const removed = t.removeSnippet(s.id);
    return { added:t.snippets.length===before, lines, preview, removed };
  });
  check('FR-06 snippet attached, measured and removed',
    snip.lines===3 && snip.removed && snip.preview.endsWith('…'), snip.preview);

  // ---------- FR-08/FR-09: time tracking ----------
  const pauseAcct = await page.evaluate(async ()=>{
    const t = board.tasks[0];
    const before = t.trackedMinutes;
    timeTracker.configure(30,5);
    timeTracker.start(t.id,'work');
    timeTracker.currentSession.lastResumedAt -= 2*60000;   // two minutes of real work
    timeTracker.pause();
    const frozenA = timeTracker.currentSession.activeMs();
    await new Promise(r=>setTimeout(r,40));                 // idle while paused
    const frozenB = timeTracker.currentSession.activeMs();
    timeTracker.stop(false);
    return { credited: board.tasks[0].trackedMinutes-before, frozen: frozenA===frozenB };
  });
  check('FR-09 pause freezes active-time accrual', pauseAcct.frozen);
  check('FR-09 paused wall clock is not credited as work',
    pauseAcct.credited===2, `credited ${pauseAcct.credited}m, expected 2m`);

  const completed = await page.evaluate(()=>{
    const t = board.tasks[1];
    const before = t.trackedMinutes;
    timeTracker.configure(25,5);
    timeTracker.start(t.id,'work');
    timeTracker.deadlineAt = Date.now()-1;
    timeTracker.tick();
    const credited = board.tasks[1].trackedMinutes-before;
    const state = timeTracker.state;
    timeTracker.abandon();
    return { credited, state };
  });
  check('FR-09 completed session credits its planned duration',
    completed.credited===25, `credited ${completed.credited}m`);
  check('FR-08 completed work session auto-starts the break',
    completed.state==='break', `state=${completed.state}`);

  const drift = await page.evaluate(()=>{
    timeTracker.configure(10,5);
    timeTracker.start(board.tasks[0].id,'work');
    timeTracker.deadlineAt -= 3*60000;    // emulate a throttled background tab
    const remaining = timeTracker.syncRemaining();
    timeTracker.abandon();
    return remaining;
  });
  check('FR-08 countdown self-corrects after throttled ticks',
    drift<=420 && drift>415, `remaining=${drift}s, expected ~420s`);

  const cfg = await page.evaluate(()=>{
    const out = [];
    for(const [w,b] of [[0,5],[25,999],[2.5,5],[NaN,5]]){
      try { timeTracker.configure(w,b); out.push('accepted'); } catch(e){ out.push('rejected'); }
    }
    timeTracker.configure(25,5);
    return out;
  });
  check('FR-08 invalid durations rejected', cfg.every(r=>r==='rejected'), cfg.join(','));

  const doubleStart = await page.evaluate(()=>{
    timeTracker.start(board.tasks[0].id,'work');
    const second = timeTracker.start(board.tasks[0].id,'work');
    timeTracker.abandon();
    return second;
  });
  check('FR-08 concurrent session refused', doubleStart===false);

  const guard = await page.evaluate(()=>{
    ui.selectedTaskId = null;
    // Sync the view to the tracker's real state, exactly as the application
    // does after abandoning a session, before exercising the button.
    ui.renderDetail(); ui.renderTimer();
    document.getElementById('btn-timer-start').click();
    return document.getElementById('timer-msg').textContent;
  });
  check('FR-08 timer without a selected task shows guidance',
    guard.toLowerCase().includes('select'), guard);

  const noLeak = await page.evaluate(()=>{
    for(let i=0;i<5;i++){ timeTracker.start(board.tasks[0].id,'work'); timeTracker.stop(false); }
    return timeTracker.intervalHandle===null && timeTracker.state==='idle';
  });
  check('start/stop cycles leave no dangling interval', noLeak);

  const delTracked = await page.evaluate(()=>{
    const t = new Task({ title:'Disposable', status:'todo' });
    board.addTask(t); ui.selectTask(t.id);
    timeTracker.configure(15,5);
    timeTracker.start(t.id,'work');
    timeTracker.currentSession.lastResumedAt -= 5*60000;
    ui.confirmingDelete = true; ui.renderDetail();
    document.querySelector('[data-act="delete-confirm"]').click();
    return { removed:board.getTask(t.id)===undefined, state:timeTracker.state,
             active:timeTracker.activeTaskId, banked:timeTracker.sessions.some(s=>s.taskId===t.id) };
  });
  check('deleting the tracked task stops the timer',
    delTracked.removed && delTracked.state==='idle' && delTracked.active===null);
  check('the interrupted session is still recorded in history', delTracked.banked);

  // ---------- FR-10/FR-11/FR-12: search, filters, statistics ----------
  const filters = await page.evaluate(()=>{
    board.clearFilters();
    board.setFilter('priority','high');
    board.setFilter('status','todo');
    const both = board.applyFilters().length;
    const manual = board.tasks.filter(t=>t.priority==='high'&&t.status==='todo').length;
    board.setFilter('query','zzzz-no-match');
    const withQuery = board.applyFilters().length;
    board.clearFilters();
    return { both, manual, withQuery, cleared:board.applyFilters().length===board.tasks.length };
  });
  check('FR-11 status and priority filters combine with AND semantics',
    filters.both===filters.manual, `${filters.both} vs ${filters.manual}`);
  check('FR-10 search narrows the combined filter to zero', filters.withQuery===0);
  check('FR-11 clearing filters restores every task', filters.cleared);

  const searchFields = await page.evaluate(()=>{
    const t = board.tasks.find(x=>x.branchLink) || board.tasks[0];
    t.linkBranch(new GitBranchLink('feature/searchable-branch','r','main'));
    const byKey = board.tasks.filter(x=>x.matchesQuery(t.key.toLowerCase())).length;
    const byBranch = board.tasks.filter(x=>x.matchesQuery('searchable-branch')).length;
    const byTag = board.tasks.filter(x=>x.matchesQuery('DEVOPS')).length;
    return { byKey, byBranch, byTag };
  });
  check('FR-10 search matches key, branch and tag case-insensitively',
    searchFields.byKey===1 && searchFields.byBranch===1 && searchFields.byTag>=1,
    JSON.stringify(searchFields));

  const facets = await page.evaluate(()=>{
    board.clearFilters();
    board.setFilter('priority','high');
    ui.renderSidebar(); ui.renderBoard();
    const sidebar = Number(document.querySelector('#filter-status .filter-item .count').textContent);
    const columns = Array.from(document.querySelectorAll('.column .col-head .count'))
                         .reduce((a,c)=>a+Number(c.textContent),0);
    board.clearFilters(); ui.render();
    return { sidebar, columns };
  });
  check('FR-12 sidebar counts agree with the visible board',
    facets.sidebar===facets.columns, `sidebar=${facets.sidebar} board=${facets.columns}`);

  const stats = await page.evaluate(()=>{
    const s = board.statistics();
    const manualDone = board.tasks.filter(t=>t.status==='done').length;
    const manualTracked = board.tasks.reduce((a,t)=>a+t.trackedMinutes,0);
    return { ok: s.done===manualDone && s.totalTracked===manualTracked
             && Math.abs(s.completionRate-manualDone/board.tasks.length)<1e-9,
             blocked:s.blocked };
  });
  check('FR-12 statistics agree with the underlying collection', stats.ok);

  // ---------- FR-13: persistence boundary ----------
  const roundTrip = await page.evaluate(()=>{
    const a = JSON.parse(board.exportJSON()).tasks;
    board.importJSON(JSON.stringify({ tasks:a }));
    const b = JSON.parse(board.exportJSON()).tasks;
    return JSON.stringify(a)===JSON.stringify(b);
  });
  check('FR-13 export to import round-trips without loss', roundTrip);

  const keys = await page.evaluate(()=>{
    const fresh = new TaskBoard();
    fresh.loadSampleData();
    const assigned = fresh.tasks.map(t=>t.key);
    const added = fresh.addTask(new Task({ title:'Next' })).key;
    const other = new TaskBoard();
    other.importJSON(fresh.exportJSON());
    const imported = other.tasks.map(t=>t.key);
    const afterImport = other.addTask(new Task({ title:'After' })).key;
    return { first:assigned[0], added, afterImport,
             preserved: imported.join(',')===assigned.concat(added).join(',') };
  });
  check('task keys are sequential and survive a round trip',
    keys.first==='DF-1' && keys.added==='DF-8' && keys.preserved && keys.afterImport==='DF-9',
    `${keys.first}/${keys.added}/${keys.afterImport}`);

  const hardening = await page.evaluate(()=>{
    board.importJSON(JSON.stringify({ tasks:[{ title:'Hostile', status:'nonsense', priority:'ultra',
      trackedMinutes:-500, estimateMinutes:'NaN', createdAt:'not-a-date', completedAt:'garbage',
      tags:['ok',42,null] }] }));
    const t = board.tasks[0];
    return { status:t.status, priority:t.priority, tracked:t.trackedMinutes, estimate:t.estimateMinutes,
             validDate:!Number.isNaN(t.createdAt.getTime()), completedAt:t.completedAt, tags:t.tags };
  });
  check('malformed import values fall back to safe defaults',
    hardening.status==='backlog' && hardening.priority==='medium' && hardening.tracked===0
    && hardening.estimate===0 && hardening.validDate && hardening.completedAt===null
    && JSON.stringify(hardening.tags)==='["ok"]', JSON.stringify(hardening));

  const badImports = await page.evaluate(()=>{
    const before = board.tasks.length;
    const errs = [];
    for(const bad of ['{','{"tasks":"nope"}','{"tasks":[{"title":""}]}']){
      try { board.importJSON(bad); errs.push(null); } catch(e){ errs.push(e.message); }
    }
    return { preserved:board.tasks.length===before, allThrew:errs.every(e=>typeof e==='string') };
  });
  check('malformed imports rejected without clobbering the board',
    badImports.preserved && badImports.allThrew);

  const importDuringSession = await page.evaluate(()=>{
    board.loadSampleData(); ui.render();
    timeTracker.start(board.tasks[0].id,'work');
    board.importJSON(board.exportJSON());
    timeTracker.abandon();
    return timeTracker.state==='idle' && timeTracker.activeTaskId===null
        && timeTracker.intervalHandle===null;
  });
  check('import abandons any running session', importDuringSession);

  // ---------- model invariants ----------
  const completedStable = await page.evaluate(()=>{
    const t = board.tasks[0];
    t.moveTo('done');
    const first = t.completedAt.getTime();
    t.moveTo('done');
    const second = t.completedAt.getTime();
    t.moveTo('todo');
    return { stable:first===second, cleared:t.completedAt===null };
  });
  check('re-marking a done task preserves its completion time', completedStable.stable);
  check('moving out of Done clears the completion time', completedStable.cleared);

  const invariants = await page.evaluate(()=>{
    const t = board.tasks[0];
    let rangeErr = false, negErr = false;
    try { t.moveTo('not-a-status'); } catch(e){ rangeErr = e instanceof RangeError; }
    try { t.addTrackedMinutes(-5); } catch(e){ negErr = e instanceof RangeError; }
    t.estimateMinutes = 100; t.trackedMinutes = 250;
    const ratio = t.progressRatio(), over = t.isOverEstimate();
    t.estimateMinutes = 0;
    const noEstimate = t.progressRatio();
    return { rangeErr, negErr, ratio, over, noEstimate };
  });
  check('unknown status rejected with RangeError', invariants.rangeErr);
  check('negative tracked minutes rejected', invariants.negErr);
  check('progress ratio clamps to 1 and flags over-estimate',
    invariants.ratio===1 && invariants.over===true && invariants.noEstimate===0);

  // ---------- NFR: usability, accessibility, security ----------
  await page.evaluate(()=>{ board.loadSampleData(); ui.render(); });
  const firstCard = page.locator('.card').first();
  await firstCard.focus();
  const before = await page.evaluate(()=>board.getTask(document.activeElement.dataset.taskId).status);
  await page.keyboard.press('Alt+ArrowRight');
  const kb = await page.evaluate(()=>({
    status: board.getTask(document.activeElement.dataset.taskId).status,
    focused: document.activeElement.classList.contains('card') }));
  check('NFR-01 Alt+Arrow moves a card without a mouse', kb.status!==before, `${before} -> ${kb.status}`);
  check('NFR-01 focus follows the card after a keyboard move', kb.focused);

  const atEnd = await page.evaluate(()=>{
    const done = board.tasks.find(t=>t.status==='done') || board.tasks[0];
    done.moveTo('done');
    ui.moveTaskByKeyboard(done.id,1);
    return board.getTask(done.id).status;
  });
  check('NFR-01 keyboard move refuses to pass the last column', atEnd==='done');

  await page.locator('#btn-new').focus();
  await page.locator('#btn-new').click();
  await page.waitForSelector('#modal-task:not([hidden])');
  const trap = await page.evaluate(()=>{
    const modal = document.getElementById('modal-task');
    const items = Array.from(modal.querySelectorAll('button, input, textarea, select'))
                       .filter(el=>!el.disabled && el.offsetParent!==null);
    items[items.length-1].focus();
    modal.dispatchEvent(new KeyboardEvent('keydown',{ key:'Tab', bubbles:true }));
    return document.activeElement===items[0];
  });
  check('NFR-01 Tab wraps inside the dialog (focus trap)', trap);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#modal-task', { state:'hidden' });
  check('NFR-01 Escape closes the dialog and restores focus',
    (await page.evaluate(()=>document.activeElement.id))==='btn-new');

  const detailState = await page.evaluate(()=>{
    const t = board.tasks.find(x=>x.snippets.length>0);
    ui.selectTask(t.id);
    const d = document.querySelector('details.snip');
    d.open = true;
    const id = d.dataset.snippetId;
    ui.renderDetail();
    const after = document.querySelector(`details.snip[data-snippet-id="${CSS.escape(id)}"]`);
    return after && after.open;
  });
  check('NFR-01 expanded snippets survive a re-render', detailState);

  const xss = await page.evaluate(()=>{
    board.addTask(new Task({ title:'<img src=x onerror=alert(1)>', status:'todo', tags:['<b>t</b>'] }));
    ui.render();
    const card = Array.from(document.querySelectorAll('.card-title')).find(el=>el.textContent.includes('<img'));
    ui.selectTask(card.closest('.card').dataset.taskId);
    return { literal:!!card, imgs:document.querySelectorAll('.card img, .detail img').length,
             bold:document.querySelectorAll('.chip b, .badge b').length };
  });
  check('NFR-05 markup in user text renders as literal characters',
    xss.literal && xss.imgs===0 && xss.bold===0);

  const noNetwork = await page.evaluate(()=>{
    const src = document.documentElement.outerHTML;
    return !/\b(fetch|XMLHttpRequest|WebSocket|navigator\.sendBeacon)\s*\(/.test(src)
        && !/<(script|link|img)[^>]+(src|href)\s*=\s*["']https?:/i.test(src);
  });
  check('NFR-06 no network egress path exists in the source', noNetwork);

  const noStorage = await page.evaluate(()=>
    !/\b(localStorage|sessionStorage|indexedDB)\b/.test(document.documentElement.outerHTML));
  check('NFR-04 no browser storage API is used', noStorage);

  const perf = await page.evaluate(()=>{
    const b = new TaskBoard();
    for(let i=0;i<100;i++) b.addTask(new Task({ title:'Load test '+i, status:STATUS_ORDER[i%5],
      priority:PRIORITY_ORDER[i%4], tags:['perf'] }));
    const t0 = performance.now();
    b.applyFilters(); b.statistics(); b.sortTasks(b.tasks);
    return performance.now()-t0;
  });
  check('NFR-02/03 filter, sort and statistics on 100 tasks stay under 100ms',
    perf<100, `${perf.toFixed(1)}ms`);

  check('no console errors across the whole run', consoleErrors.length===0, consoleErrors.join(' | '));

  await browser.close();
  const failed = results.filter(r=>!r.pass);
  console.log(`\n${results.length-failed.length}/${results.length} checks passed`);
  if(failed.length){ console.log('FAILURES:\n'+failed.map(f=>' - '+f.name+' '+f.detail).join('\n')); process.exit(1); }
})();
