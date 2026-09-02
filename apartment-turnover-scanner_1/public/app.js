(() => {
  const root = document.getElementById('view-root');

  function scannedBy() {
    return 'Crew';
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  // Custom in-page confirm modal (native window.confirm() blocks the whole
  // tab in a way that can hang automated/embedded contexts, so we avoid it).
  function showConfirm(message, confirmLabel) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = `
        <div class="confirm-box">
          <p>${escapeHtml(message)}</p>
          <div class="row" style="justify-content:flex-end; gap:8px;">
            <button class="secondary" data-action="cancel">Cancel</button>
            <button class="danger" data-action="ok">${escapeHtml(confirmLabel || 'Confirm')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      function done(result) {
        overlay.remove();
        resolve(result);
      }
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => done(false));
      overlay.querySelector('[data-action="ok"]').addEventListener('click', () => done(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    });
  }

  // Custom in-page text prompt (avoids native window.prompt() for the same
  // reason as showConfirm above). Resolves to the trimmed string, or null
  // if cancelled / left blank.
  function showPrompt(message, initialValue, confirmLabel) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = `
        <div class="confirm-box">
          <p>${escapeHtml(message)}</p>
          <input type="text" id="promptInput" style="margin-bottom:16px;" />
          <div class="row" style="justify-content:flex-end; gap:8px;">
            <button class="secondary" data-action="cancel">Cancel</button>
            <button class="primary" data-action="ok">${escapeHtml(confirmLabel || 'Save')}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#promptInput');
      input.value = initialValue || '';
      input.focus();
      input.select();
      function done(result) {
        overlay.remove();
        resolve(result);
      }
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => done(null));
      overlay.querySelector('[data-action="ok"]').addEventListener('click', () => done(input.value.trim() || null));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(input.value.trim() || null);
        if (e.key === 'Escape') done(null);
      });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    });
  }

  async function api(path, opts) {
    const resp = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!resp.ok) {
      let msg = `Request failed (${resp.status})`;
      try { const j = await resp.json(); if (j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }
    const ct = resp.headers.get('content-type') || '';
    return ct.includes('application/json') ? resp.json() : resp;
  }

  // ---------------- Router ----------------
  let pollTimer = null;

  function startPolling(fn) {
    stopPolling();
    pollTimer = setInterval(async () => {
      try { await fn(); } catch (e) { /* ignore transient poll errors */ }
    }, 5000);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function navigate(hash) {
    window.location.hash = hash;
  }

  window.addEventListener('hashchange', route);

  async function route() {
    stopPolling();
    const hash = window.location.hash.slice(1);

    if (!hash || hash === '/') {
      renderProjects();
      return;
    }

    if (hash === '/trash') {
      renderTrash();
      return;
    }

    const projectMatch = hash.match(/^\/project\/(\d+)$/);
    if (projectMatch) {
      renderDashboard(parseInt(projectMatch[1], 10));
      return;
    }

    const unitMatch = hash.match(/^\/project\/(\d+)\/unit\/(\d+)$/);
    if (unitMatch) {
      renderUnit(parseInt(unitMatch[1], 10), parseInt(unitMatch[2], 10));
      return;
    }

    const scanMatch = hash.match(/^\/project\/(\d+)\/unit\/(\d+)\/scan\/(\d+)$/);
    if (scanMatch) {
      renderScan(parseInt(scanMatch[1], 10), parseInt(scanMatch[2], 10), parseInt(scanMatch[3], 10));
      return;
    }

    navigate('');
  }

  // ---------------- Projects (cover page) ----------------
  async function renderProjects() {
    root.innerHTML = `<div class="card"><p class="help">Loading projects...</p></div>`;
    let data;
    try {
      data = await api('/api/projects');
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="help">Could not reach the server: ${e.message}</p></div>`;
      return;
    }

    const projects = data.projects;

    root.innerHTML = `
      <div class="row between">
        <h1>Projects</h1>
        <div class="row" style="gap:8px;">
          <button class="secondary" id="trashLink">Trash</button>
          <div class="new-project-menu">
            <button class="primary new-project-btn" id="newProjectToggle" aria-label="New project">+</button>
            <div class="new-project-panel" id="newProjectPanel" hidden>
              <h2>Start a new project</h2>
              <p class="help">Give this job a name, then upload its unit list (.xlsx or .csv). Column A should have the unit number and the columns after it list the appliances — either the same fixed checklist for every unit (header row names the appliance types) or a custom list per unit.</p>
              <div class="row" style="margin-top:8px;">
                <input type="text" id="newProjectName" placeholder="Project name (e.g. Maple Ridge Apartments)" />
              </div>
              <div class="row" style="margin-top:10px;">
                <input type="file" id="importFile" accept=".xlsx,.xls,.csv" />
              </div>
              <div class="row" style="margin-top:12px;">
                <button class="primary" id="createProjectBtn">Create project</button>
              </div>
              <div id="importMsg" style="margin-top:10px;"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="unit-grid" id="projectGrid"></div>
        ${projects.length === 0 ? '<p class="help">No projects yet — click the + button above to create your first one.</p>' : ''}
      </div>
    `;

    document.getElementById('trashLink').addEventListener('click', () => navigate('/trash'));

    const panel = document.getElementById('newProjectPanel');
    const toggleBtn = document.getElementById('newProjectToggle');
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== toggleBtn) {
        panel.hidden = true;
      }
    }, { once: true });

    const grid = document.getElementById('projectGrid');
    grid.innerHTML = projects.map((p) => `
      <div class="unit-tile project-tile ${p.totalUnits > 0 && p.completeUnits === p.totalUnits ? 'complete' : (p.doneItems > 0 ? 'inprogress' : '')}" data-id="${p.id}">
        <button class="project-delete" data-id="${p.id}" aria-label="Move project to trash">&#128465;</button>
        <button class="project-edit" data-id="${p.id}" aria-label="Rename project">&#9998;</button>
        ${p.totalUnits > 0 && p.completeUnits === p.totalUnits ? '<div class="check">&#10003;</div>' : ''}
        <div class="unit-num">${escapeHtml(p.name)}</div>
        <div class="unit-progress">${p.completeUnits}/${p.totalUnits} units</div>
      </div>
    `).join('');
    grid.querySelectorAll('.project-tile').forEach((el) => {
      el.addEventListener('click', () => navigate(`/project/${el.dataset.id}`));
    });
    grid.querySelectorAll('.project-delete').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const proj = projects.find((p) => String(p.id) === String(id));
        const ok = await showConfirm(`Move "${proj ? proj.name : 'this project'}" to the trash? You can restore it later from Trash.`, 'Move to trash');
        if (!ok) return;
        try {
          await api(`/api/projects/${id}`, { method: 'DELETE' });
          toast('Moved to trash');
          renderProjects();
        } catch (err) {
          toast(`Could not move to trash: ${err.message}`);
        }
      });
    });
    grid.querySelectorAll('.project-edit').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const proj = projects.find((p) => String(p.id) === String(id));
        const newName = await showPrompt('Rename project', proj ? proj.name : '', 'Save');
        if (!newName) return;
        try {
          await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
          toast('Project renamed');
          renderProjects();
        } catch (err) {
          toast(`Could not rename: ${err.message}`);
        }
      });
    });

    document.getElementById('createProjectBtn').addEventListener('click', async () => {
      const nameInput = document.getElementById('newProjectName');
      const fileInput = document.getElementById('importFile');
      const msg = document.getElementById('importMsg');
      const name = nameInput.value.trim();
      if (!name) { msg.textContent = 'Give the project a name.'; return; }
      if (!fileInput.files.length) { msg.textContent = 'Choose a unit-list file first.'; return; }
      msg.textContent = 'Importing...';
      const formData = new FormData();
      formData.append('file', fileInput.files[0]);
      formData.append('projectName', name);
      try {
        const resp = await fetch('/api/import', { method: 'POST', body: formData });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Import failed');
        toast(`Created "${name}" with ${data.unitsImported} units`);
        navigate(`/project/${data.projectId}`);
      } catch (e) {
        msg.textContent = e.message;
      }
    });
  }

  // ---------------- Trash ----------------
  async function renderTrash() {
    root.innerHTML = `<div class="card"><p class="help">Loading trash...</p></div>`;
    let data;
    try {
      data = await api('/api/projects/trash');
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="help">Could not reach the server: ${e.message}</p></div>`;
      return;
    }

    const projects = data.projects;

    root.innerHTML = `
      <div class="row between">
        <h1>Trash</h1>
        <button class="secondary" id="backToProjectsBtn">&larr; All projects</button>
      </div>
      <div class="card">
        <div class="unit-grid" id="trashGrid"></div>
        ${projects.length === 0 ? '<p class="help">Trash is empty.</p>' : ''}
      </div>
    `;

    document.getElementById('backToProjectsBtn').addEventListener('click', () => navigate(''));

    const grid = document.getElementById('trashGrid');
    grid.innerHTML = projects.map((p) => `
      <div class="unit-tile project-tile" data-id="${p.id}">
        <button class="project-restore" data-id="${p.id}" aria-label="Restore project">&#8635;</button>
        <div class="unit-num">${escapeHtml(p.name)}</div>
        <div class="unit-progress">${p.totalUnits} units</div>
      </div>
    `).join('');
    grid.querySelectorAll('.project-restore').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        try {
          await api(`/api/projects/${id}/restore`, { method: 'POST' });
          toast('Project restored');
          renderTrash();
        } catch (err) {
          toast(`Could not restore: ${err.message}`);
        }
      });
    });
  }

  // ---------------- Dashboard (one project) ----------------
  async function renderDashboard(projectId) {
    root.innerHTML = `<div class="card"><p class="help">Loading...</p></div>`;
    let project, units;
    try {
      [project, units] = await Promise.all([
        api(`/api/projects/${projectId}`).then((d) => d.project),
        api(`/api/units?projectId=${projectId}`).then((d) => d.units),
      ]);
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="help">Could not load this project: ${e.message}</p></div>`;
      return;
    }

    if (units.length === 0) {
      renderImportIntoProject(project);
      return;
    }

    drawDashboard(project, units);
    startPolling(async () => {
      const fresh = await api(`/api/units?projectId=${projectId}`).then((d) => d.units);
      const searchBox = document.getElementById('searchBox');
      const currentFilter = searchBox ? searchBox.value : '';
      updateDashboardStats(fresh);
      renderUnitGrid(fresh, currentFilter);
    });
  }

  function renderImportIntoProject(project) {
    root.innerHTML = `
      <div class="row between">
        <h1>${escapeHtml(project.name)}</h1>
        <button class="secondary" id="allProjectsBtn">&larr; All projects</button>
      </div>
      <div class="card">
        <h2>Load the unit list</h2>
        <p class="help">
          Upload an Excel (.xlsx) or CSV file. Column A should have the unit number
          and the columns after it list the appliances &mdash; either a fixed checklist
          (header row names the appliance types, applied to every unit) or a custom
          list per unit.
        </p>
        <input type="file" id="importFile" accept=".xlsx,.xls,.csv" />
        <div class="row" style="margin-top:12px;">
          <button class="primary" id="importBtn">Import</button>
        </div>
        <div id="importMsg" style="margin-top:10px;"></div>
      </div>
    `;
    document.getElementById('allProjectsBtn').addEventListener('click', () => navigate(''));
    document.getElementById('importBtn').addEventListener('click', async () => {
      const fileInput = document.getElementById('importFile');
      const msg = document.getElementById('importMsg');
      if (!fileInput.files.length) { msg.textContent = 'Choose a file first.'; return; }
      msg.textContent = 'Importing...';
      const formData = new FormData();
      formData.append('file', fileInput.files[0]);
      formData.append('projectId', project.id);
      try {
        const resp = await fetch('/api/import', { method: 'POST', body: formData });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Import failed');
        toast(`Imported ${data.unitsImported} units`);
        route();
      } catch (e) {
        msg.textContent = e.message;
      }
    });
  }

  function updateDashboardStats(units) {
    const totalUnits = units.length;
    const completeUnits = units.filter((u) => u.complete).length;
    const totalItems = units.reduce((s, u) => s + u.totalItems, 0);
    const doneItems = units.reduce((s, u) => s + u.doneItems, 0);
    const statsEls = document.querySelectorAll('.stat .num');
    if (statsEls[0]) statsEls[0].textContent = `${completeUnits}/${totalUnits}`;
    if (statsEls[1]) statsEls[1].textContent = `${doneItems}/${totalItems}`;
  }

  function renderUnitGrid(units, filter) {
    const grid = document.getElementById('unitGrid');
    if (!grid) return;
    const f = (filter || '').trim().toLowerCase();
    const filtered = units.filter((u) => !f || u.unitNumber.toLowerCase().includes(f));
    grid.innerHTML = filtered.map((u) => `
      <button class="unit-tile ${u.complete ? 'complete' : (u.inProgress ? 'inprogress' : '')}" data-id="${u.id}">
        ${u.complete ? '<div class="check">&#10003;</div>' : ''}
        <div class="unit-num">${escapeHtml(u.unitNumber)}</div>
        <div class="unit-progress">${u.doneItems}/${u.totalItems}</div>
      </button>
    `).join('') || '<p class="help">No units match.</p>';

    grid.querySelectorAll('.unit-tile').forEach((el) => {
      const projectId = grid.dataset.projectId;
      el.addEventListener('click', () => navigate(`/project/${projectId}/unit/${el.dataset.id}`));
    });
  }

  function drawDashboard(project, units) {
    const totalUnits = units.length;
    const completeUnits = units.filter((u) => u.complete).length;
    const totalItems = units.reduce((s, u) => s + u.totalItems, 0);
    const doneItems = units.reduce((s, u) => s + u.doneItems, 0);

    root.innerHTML = `
      <div class="row between">
        <div class="row" style="gap:8px;">
          <h1 style="margin:0;">${escapeHtml(project.name)}</h1>
          <button class="secondary" id="renameProjectBtn" aria-label="Rename project" style="padding:4px 8px;">&#9998;</button>
        </div>
        <div class="row">
          <button class="secondary" id="allProjectsBtn">&larr; All projects</button>
          <button class="secondary" id="reimportBtn">Re-import list</button>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="num">${completeUnits}/${totalUnits}</div><div class="label">Units complete</div></div>
        <div class="stat"><div class="num">${doneItems}/${totalItems}</div><div class="label">Items scanned</div></div>
      </div>
      <div class="card">
        <div class="row">
          <input type="text" id="searchBox" placeholder="Search unit number..." />
        </div>
        <div class="unit-grid" id="unitGrid" data-project-id="${project.id}"></div>
      </div>
      <div class="card">
        <h2>Export</h2>
        <div class="row">
          <a href="/api/export.xlsx?projectId=${project.id}"><button class="primary">Download Excel</button></a>
          <a href="/api/export.csv?projectId=${project.id}"><button class="secondary">Download CSV</button></a>
        </div>
      </div>
    `;

    renderUnitGrid(units, '');
    document.getElementById('searchBox').addEventListener('input', (e) => renderUnitGrid(units, e.target.value));
    document.getElementById('allProjectsBtn').addEventListener('click', () => navigate(''));
    document.getElementById('renameProjectBtn').addEventListener('click', async () => {
      const newName = await showPrompt('Rename project', project.name, 'Save');
      if (!newName) return;
      try {
        await api(`/api/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
        toast('Project renamed');
        renderDashboard(project.id);
      } catch (err) {
        toast(`Could not rename: ${err.message}`);
      }
    });
    document.getElementById('reimportBtn').addEventListener('click', async () => {
      const ok = await showConfirm('This replaces the current unit list and all progress for this project. Continue?', 'Replace list');
      if (ok) {
        renderImportIntoProject(project);
      }
    });
  }

  // ---------------- Unit detail ----------------
  async function renderUnit(projectId, unitId) {
    root.innerHTML = `<div class="card"><p class="help">Loading...</p></div>`;
    let unit;
    try {
      const data = await api(`/api/units/${unitId}`);
      unit = { id: data.unit.id, unitNumber: data.unit.unit_number, items: data.items };
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="help">Could not load this unit: ${e.message}</p></div>`;
      return;
    }
    const doneItems = unit.items.filter((i) => i.status === 'done').length;
    const complete = unit.items.length > 0 && doneItems === unit.items.length;

    root.innerHTML = `
      <div class="row between">
        <h1>Unit ${escapeHtml(unit.unitNumber)}</h1>
        <button class="secondary" id="backBtn">&larr; All units</button>
      </div>
      <div class="card">
        <div class="row between" style="margin-bottom:10px;">
          <div>${doneItems}/${unit.items.length} scanned</div>
          <button class="primary" id="startScanBtn" ${unit.items.length === 0 ? 'disabled' : ''}>
            ${complete ? 'Re-scan / review' : 'Start scanning'}
          </button>
        </div>
        <div id="itemList"></div>
      </div>
      ${complete ? `<div class="card big-check"><div class="mark">&#10003;</div><div>Unit ${escapeHtml(unit.unitNumber)} complete</div></div>` : ''}
    `;

    document.getElementById('backBtn').addEventListener('click', () => navigate(`/project/${projectId}`));

    const list = document.getElementById('itemList');
    list.innerHTML = unit.items.map((item, idx) => `
      <div class="item-row ${item.status === 'done' ? 'done' : ''}" data-idx="${idx}">
        <div class="dot"></div>
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-meta">
          ${item.status === 'done' ? `${escapeHtml(item.model || '')} / ${escapeHtml(item.serial || '')}` : 'Not scanned'}
        </div>
      </div>
    `).join('') || '<p class="help">No items listed for this unit.</p>';

    list.querySelectorAll('.item-row').forEach((el) => {
      el.addEventListener('click', () => navigate(`/project/${projectId}/unit/${unitId}/scan/${el.dataset.idx}`));
    });

    document.getElementById('startScanBtn').addEventListener('click', () => {
      const firstPending = unit.items.findIndex((i) => i.status !== 'done');
      navigate(`/project/${projectId}/unit/${unitId}/scan/${firstPending === -1 ? 0 : firstPending}`);
    });
  }

  // ---------------- Scan view ----------------
  let tesseractWorker = null;
  let workerReady = false;

  async function ensureWorker() {
    if (workerReady) return tesseractWorker;
    if (typeof Tesseract === 'undefined') throw new Error('OCR engine failed to load');
    tesseractWorker = await Tesseract.createWorker('eng');
    await tesseractWorker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/.: ',
      // Automatic page segmentation: we now hand Tesseract the whole visible
      // frame rather than a tight crop, so let it find the text blocks
      // itself instead of assuming one uniform block.
      tessedit_pageseg_mode: '3',
    });
    workerReady = true;
    return tesseractWorker;
  }

  // Appliance nameplates vary a lot in layout: some put "Model: XYZ123" on
  // one line, some put "MODEL NO." as its own header line with the actual
  // code on the line below, and some print "MODEL NO." and "SERIAL NO." as
  // a header row with both codes side-by-side on the next line. We try each
  // pattern in order of confidence, then fall back to grabbing plausible
  // alphanumeric codes if no label was recognized at all — the scan flow
  // always requires the user to review before confirming, so an imperfect
  // guess is safe and still faster than typing from scratch.
  function parseModelSerial(text) {
    const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

    // Words that appear ON nameplates but are never the code itself, so we
    // never mistake a label word for a value.
    const STOPWORDS = /^(model|modele|modell|mod|mdl|serial|serie|series|ser|no|num|numero|type|volts?|amps?|hertz|hz|vac|watts?|made|in|de|du|la|le|and|inc|ltd|usa|canada|mexico|china|korea)$/i;

    // A token that looks like an appliance code: alphanumeric (dashes and
    // slashes allowed inside), at least 5 characters, containing at least
    // one digit. When the token was found on a line that is explicitly
    // labelled Model/Serial we accept all-digit codes too; when we are
    // guessing from unlabelled text we additionally require a letter, so
    // that ZIP codes, phone numbers, wattages and dates can't win.
    function isCode(tok, opts) {
      const requireLetter = !opts || opts.requireLetter !== false;
      if (!/^[A-Za-z0-9][A-Za-z0-9\-\/]{4,}$/.test(tok)) return false;
      if (!/[0-9]/.test(tok)) return false;
      if (requireLetter && !/[A-Za-z]/.test(tok)) return false;
      if (STOPWORDS.test(tok)) return false;
      // Dates like 07/26 or 12/2025, and pure decimal readings.
      if (/^\d{1,4}\/\d{1,4}$/.test(tok)) return false;
      return true;
    }

    const tokensOf = (line) => line.split(/[\s,;]+/).map((t) => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9\-\/]+$/g, '')).filter(Boolean);

    // Keyword positions. Matched loosely so English and French/Spanish
    // variants both hit: "Model No.", "No de Modele", "Modelo", "Serial No.",
    // "No de Serie", "S/N".
    const MODEL_KW = /\b(model|modelo|modele|modell|mdl|mod)\b|\bmodele\b/i;
    const SERIAL_KW = /\b(serial|serie|series|s\/n|sn)\b/i;

    let model = '';
    let serial = '';

    // Pass 1: for each line that names a field, take the first code-shaped
    // token that appears after the keyword on that line. This handles
    // "Model No. ABC123", "Model No./No de Modele: ABC123", "Modelo: ABC123"
    // and "MODEL ABC123 SERIAL XYZ789" alike, without caring what
    // punctuation or second-language text sits between label and value.
    for (const line of lines) {
      const mIdx = line.search(MODEL_KW);
      const sIdx = line.search(SERIAL_KW);
      if (mIdx === -1 && sIdx === -1) continue;

      // If both labels are on one line, each label owns the codes that
      // follow it up to the next label.
      if (mIdx !== -1 && sIdx !== -1) {
        const first = Math.min(mIdx, sIdx);
        const firstIsModel = mIdx < sIdx;
        const segA = line.slice(first, Math.max(mIdx, sIdx));
        const segB = line.slice(Math.max(mIdx, sIdx));
        const codesA = tokensOf(segA).filter((t) => isCode(t, { requireLetter: false }));
        const codesB = tokensOf(segB).filter((t) => isCode(t, { requireLetter: false }));
        if (firstIsModel) {
          if (!model && codesA.length) model = codesA[0];
          if (!serial && codesB.length) serial = codesB[0];
        } else {
          if (!serial && codesA.length) serial = codesA[0];
          if (!model && codesB.length) model = codesB[0];
        }
        continue;
      }

      const codes = tokensOf(line.slice(mIdx !== -1 ? mIdx : sIdx)).filter((t) => isCode(t, { requireLetter: false }));
      if (mIdx !== -1 && !model && codes.length) model = codes[0];
      if (sIdx !== -1 && !serial && codes.length) serial = codes[0];
    }

    // Pass 2: stacked layouts, where the label is on its own line and the
    // value sits on the line below — including the two-column header row
    // ("MODEL NO.   SERIAL NO." above "ABC123   XYZ789").
    for (let i = 0; i < lines.length && (!model || !serial); i++) {
      const line = lines[i];
      const next = lines[i + 1];
      if (!next) break;
      const hasModel = MODEL_KW.test(line);
      const hasSerial = SERIAL_KW.test(line);
      if (!hasModel && !hasSerial) continue;
      // Only treat it as a stacked label if this line carries no value of
      // its own (otherwise pass 1 already handled it).
      if (tokensOf(line).some((t) => isCode(t, { requireLetter: false }))) continue;

      const nextCodes = tokensOf(next).filter((t) => isCode(t, { requireLetter: false }));
      if (!nextCodes.length) continue;

      if (hasModel && hasSerial) {
        const modelFirst = line.search(MODEL_KW) < line.search(SERIAL_KW);
        if (nextCodes.length >= 2) {
          if (!model) model = modelFirst ? nextCodes[0] : nextCodes[1];
          if (!serial) serial = modelFirst ? nextCodes[1] : nextCodes[0];
        } else if (modelFirst && !model) {
          model = nextCodes[0];
        } else if (!modelFirst && !serial) {
          serial = nextCodes[0];
        }
      } else if (hasModel && !model) {
        model = nextCodes[0];
      } else if (hasSerial && !serial) {
        serial = nextCodes[0];
      }
    }

    // Pass 3: nothing was labelled (glare washed out the label words, or the
    // plate uses icons). Fall back to the first code-shaped tokens in the
    // text, requiring a letter-and-digit mix so address ZIPs, voltages and
    // dates don't get picked. The user reviews every value before
    // confirming, so a best guess here still beats an empty field.
    if (!model || !serial) {
      const used = new Set([model, serial].filter(Boolean));
      const candidates = [];
      for (const line of lines) {
        for (const tok of tokensOf(line)) {
          if (isCode(tok) && !used.has(tok)) {
            candidates.push(tok);
            used.add(tok);
          }
        }
      }
      if (!model && candidates.length) model = candidates.shift();
      if (!serial && candidates.length) serial = candidates.shift();
    }

    return { model, serial, rawText: lines.join(' | ') };
  }

  async function renderScan(projectId, unitId, itemIndex) {
    root.innerHTML = `<div class="card"><p class="help">Loading...</p></div>`;
    let unitNumber, items;
    try {
      const data = await api(`/api/units/${unitId}`);
      unitNumber = data.unit.unit_number;
      items = data.items;
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="help">Could not load this unit: ${e.message}</p></div>`;
      return;
    }

    if (itemIndex >= items.length) {
      renderUnitCompleteScreen(projectId, unitId, unitNumber);
      return;
    }
    const item = items[itemIndex];

    root.innerHTML = `
      <div class="scan-screen">
        <div class="scan-video-wrap">
          <video id="scanVideo" autoplay muted playsinline></video>
          <div class="scan-guide"></div>
          <div class="scan-flash" id="scanFlash"></div>
          <div class="scan-banner">
            <div class="item-target">${escapeHtml(item.name)}</div>
            <div class="progress">Item ${itemIndex + 1} of ${items.length} &middot; Unit ${escapeHtml(unitNumber)}</div>
          </div>
          <div class="scan-status" id="scanStatus">Point at the label area, then tap Capture</div>
        </div>
        <div class="scan-controls">
          <div class="buttons">
            <button class="primary" id="captureBtn">Capture</button>
          </div>
          <div class="fields">
            <div>
              <label>MODEL</label>
              <input type="text" id="modelField" autocomplete="off" />
            </div>
            <div>
              <label>SERIAL</label>
              <input type="text" id="serialField" autocomplete="off" />
            </div>
          </div>
          <div class="buttons">
            <button class="secondary" id="skipBtn">Skip</button>
            <button class="primary" id="confirmBtn">Confirm &amp; Next</button>
          </div>
          <div class="close-row">
            <a href="#" id="exitScan">&larr; Exit to unit</a>
            <span></span>
          </div>
        </div>
      </div>
    `;

    const video = document.getElementById('scanVideo');
    const statusEl = document.getElementById('scanStatus');
    const modelField = document.getElementById('modelField');
    const serialField = document.getElementById('serialField');
    const captureBtn = document.getElementById('captureBtn');
    modelField.value = item.model || '';
    serialField.value = item.serial || '';

    let stream = null;
    let destroyed = false;

    document.getElementById('exitScan').addEventListener('click', (e) => {
      e.preventDefault();
      cleanup();
      navigate(`/project/${projectId}/unit/${unitId}`);
    });

    captureBtn.addEventListener('click', async () => {
      if (!video.videoWidth) return;
      captureBtn.disabled = true;
      statusEl.textContent = 'Reading label...';
      try {
        await ensureWorker();
        const stillCanvas = captureFrame(video);
        const { data } = await tesseractWorker.recognize(stillCanvas);
        const guess = parseModelSerial(data.text || '');
        if (guess.model) modelField.value = guess.model;
        if (guess.serial) serialField.value = guess.serial;
        if (!guess.model && !guess.serial) {
          statusEl.textContent = "Couldn't read it clearly — check the fields below or retake.";
        } else {
          statusEl.textContent = 'Check the fields below, then Confirm.';
        }
      } catch (e) {
        statusEl.textContent = `OCR error (${e.message}). Type the model/serial in manually.`;
      }
      captureBtn.disabled = false;
    });

    document.getElementById('skipBtn').addEventListener('click', async () => {
      await saveItem(item.id, { status: 'skipped', scannedBy: scannedBy() });
      goToNext();
    });

    document.getElementById('confirmBtn').addEventListener('click', async () => {
      await saveItem(item.id, {
        model: modelField.value.trim(),
        serial: serialField.value.trim(),
        status: 'done',
        scannedBy: scannedBy(),
      });
      flashGreen(() => goToNext());
    });

    function goToNext() {
      cleanup();
      navigate(`/project/${projectId}/unit/${unitId}/scan/${itemIndex + 1}`);
    }

    function flashGreen(after) {
      const flash = document.getElementById('scanFlash');
      flash.classList.add('show');
      setTimeout(() => { after(); }, 350);
    }

    function cleanup() {
      destroyed = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }

    async function saveItem(id, body) {
      try {
        const res = await api(`/api/items/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        Object.assign(item, res.item);
        return res.item;
      } catch (e) {
        toast(`Save failed: ${e.message}`);
      }
    }

    async function startCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (destroyed) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream;
        await video.play();
        // Warm up the OCR engine in the background so the first Capture tap is fast.
        ensureWorker().catch(() => {});
      } catch (e) {
        statusEl.textContent = `Camera unavailable (${e.message}). Type the model/serial in manually below.`;
      }
    }

    startCamera();
  }

  // Captures everything currently visible in the camera view as a single
  // full-resolution still (on tap, not continuously) and returns a canvas
  // ready for Tesseract.
  //
  // We deliberately OCR the whole visible frame rather than a tight crop:
  // the user should be able to point the phone at the general area of the
  // nameplate and let the parser work out which strings are the model and
  // serial, instead of having to line a small label up inside a box.
  //
  // The video is rendered with object-fit: cover, which scales and
  // center-crops the raw camera frame to fill the element, so part of the
  // raw frame is off-screen. We reproduce that same math here and capture
  // exactly the on-screen region — what you see is what gets read.
  function captureFrame(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const rect = video.getBoundingClientRect();
    const cw = rect.width || vw;
    const ch = rect.height || vh;

    // object-fit: cover scales the raw frame up until it fully covers the
    // element, then center-crops the overflow.
    const scale = Math.max(cw / vw, ch / vh);
    const offsetX = (vw * scale - cw) / 2;
    const offsetY = (vh * scale - ch) / 2;

    // The full on-screen area, mapped back into raw source-frame pixels.
    const cropX = offsetX / scale;
    const cropY = offsetY / scale;
    const cropW = cw / scale;
    const cropH = ch / scale;

    // Upscale small frames — Tesseract is markedly more accurate when
    // character height is generous, and this is a one-shot capture so we
    // can afford the pixels. Cap the long edge so OCR stays responsive.
    let outScale = 1;
    const longEdge = Math.max(cropW, cropH);
    if (longEdge < 1600) outScale = 1600 / longEdge;
    if (longEdge * outScale > 2400) outScale = 2400 / longEdge;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cropW * outScale);
    canvas.height = Math.round(cropH * outScale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);

    // Grayscale + contrast boost to help OCR on embossed/dot-matrix nameplates.
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const contrasted = Math.min(255, Math.max(0, (gray - 128) * 1.6 + 128));
      d[i] = d[i + 1] = d[i + 2] = contrasted;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function renderUnitCompleteScreen(projectId, unitId, unitNumber) {
    root.innerHTML = `
      <div class="card big-check">
        <div class="mark">&#10003;</div>
        <div>Unit ${escapeHtml(unitNumber)} complete</div>
        <div class="row" style="justify-content:center;margin-top:14px;">
          <button class="primary" id="doneBtn">Back to unit list</button>
        </div>
      </div>
    `;
    document.getElementById('doneBtn').addEventListener('click', () => navigate(`/project/${projectId}`));
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  route();
})();
