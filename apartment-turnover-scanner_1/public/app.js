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
      tessedit_pageseg_mode: '6', // assume a uniform block of text
    });
    workerReady = true;
    return tesseractWorker;
  }

  function parseModelSerial(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    let model = '';
    let serial = '';
    const modelLabel = /\b(model|mod\.?|mod#|mdl)\b\s*[:#\.]?\s*([A-Za-z0-9\-\/]{3,})/i;
    const serialLabel = /\b(serial|ser\.?|s\/?n)\b\s*[:#\.]?\s*([A-Za-z0-9\-\/]{3,})/i;
    for (const line of lines) {
      if (!model) {
        const m = line.match(modelLabel);
        if (m) model = m[2];
      }
      if (!serial) {
        const s = line.match(serialLabel);
        if (s) serial = s[2];
      }
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
          <div class="scan-status" id="scanStatus">Line up the label in the box, then tap Capture</div>
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
        const stillCanvas = captureGuideStill(video);
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

  // Crops the region under the on-screen dashed guide box from a single
  // full-resolution still frame (captured on tap, not continuously), and
  // returns a canvas ready for Tesseract.
  function captureGuideStill(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cropX = vw * 0.08;
    const cropY = vh * 0.38;
    const cropW = vw * 0.84;
    const cropH = vh * 0.22;

    // Keep full resolution from the crop region — this is a one-shot capture,
    // not a repeated loop, so we can afford the extra detail for accuracy.
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cropW);
    canvas.height = Math.round(cropH);
    const ctx = canvas.getContext('2d');
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
