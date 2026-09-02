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
    // Prefer the "best" (slower, markedly more accurate) LSTM model — worth
    // it on worn and dot-matrix nameplates. It's a larger one-time download
    // that the browser then caches, so fall back to the default model if it
    // can't be fetched (bad signal on site) rather than failing the scan.
    try {
      tesseractWorker = await Tesseract.createWorker('eng', 1, {
        langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
      });
    } catch (e) {
      tesseractWorker = await Tesseract.createWorker('eng');
    }
    await tesseractWorker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/.: ',
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
      // Strict mode is used only by the unlabelled fallback, where there is no
      // label to vouch for the value. Real plates print these codes in upper
      // case, so anything with lower-case letters there is far more likely to
      // be OCR noise ("o21-1NG") than a genuine code.
      if (opts && opts.strict) {
        if (!/^[A-Z0-9][A-Z0-9\-\/]{5,}$/.test(tok)) return false;
        if ((tok.match(/[0-9]/g) || []).length < 2) return false;
        if (!/[A-Z]/.test(tok)) return false;
        return !STOPWORDS.test(tok);
      }
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
    // Label detection is fuzzy on purpose. OCR routinely mangles the label
    // words themselves on glossy or dot-matrix plates ("Serial" comes back as
    // "Senal", "Model" as "Modei"), and a strict word list would then miss a
    // value that is otherwise perfectly readable. We accept any word within a
    // small edit distance of a known label word, so the parser keeps working
    // on plates it has never seen.
    function editDistance(a, b) {
      const m = a.length, n = b.length;
      let prev = new Array(n + 1);
      for (let j = 0; j <= n; j++) prev[j] = j;
      for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
      }
      return prev[n];
    }

    const MODEL_WORDS = ['model', 'modelo', 'modele', 'modell', 'modelnr', 'mdl'];
    const SERIAL_WORDS = ['serial', 'serie', 'series', 'serien', 'seriennr'];

    function fuzzyMatches(word, targets) {
      const w = word.toLowerCase().replace(/[^a-z]/g, '');
      if (!w) return false;
      for (const t of targets) {
        if (w === t) return true;
        // Allow one substitution on short words, two on longer ones — enough
        // for typical OCR letter confusion without matching unrelated words.
        const budget = t.length >= 6 ? 2 : 1;
        if (Math.abs(w.length - t.length) <= budget && editDistance(w, t) <= budget) return true;
      }
      return false;
    }

    // Character offset of the first word in `line` that reads as a model /
    // serial label, or -1. Also catches the abbreviations that are too short
    // for fuzzy matching to handle safely.
    function labelIndex(line, targets, abbrevRe) {
      if (abbrevRe) {
        const m = line.match(abbrevRe);
        if (m) return m.index;
      }
      const re = /[A-Za-z][A-Za-z.]*/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (fuzzyMatches(m[0], targets)) return m.index;
      }
      return -1;
    }

    const modelIndex = (line) => labelIndex(line, MODEL_WORDS, /\bmdl\b|\bmod\.?\s*no\b/i);
    const serialIndex = (line) => labelIndex(line, SERIAL_WORDS, /\bs\/?n\b|\bser\.?\s*no\b/i);

    let model = '';
    let serial = '';

    // Pass 1: for each line that names a field, take the first code-shaped
    // token that appears after the keyword on that line. This handles
    // "Model No. ABC123", "Model No./No de Modele: ABC123", "Modelo: ABC123"
    // and "MODEL ABC123 SERIAL XYZ789" alike, without caring what
    // punctuation or second-language text sits between label and value.
    for (const line of lines) {
      const mIdx = modelIndex(line);
      const sIdx = serialIndex(line);
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
      const hasModel = modelIndex(line) !== -1;
      const hasSerial = serialIndex(line) !== -1;
      if (!hasModel && !hasSerial) continue;
      // Only treat it as a stacked label if this line carries no value of
      // its own (otherwise pass 1 already handled it).
      if (tokensOf(line).some((t) => isCode(t, { requireLetter: false }))) continue;

      const nextCodes = tokensOf(next).filter((t) => isCode(t, { requireLetter: false }));
      if (!nextCodes.length) continue;

      if (hasModel && hasSerial) {
        const modelFirst = modelIndex(line) < serialIndex(line);
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
          if (isCode(tok, { strict: true }) && !used.has(tok)) {
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
        <div class="scan-photo-wrap" id="photoWrap">
          <img id="scanPhoto" hidden alt="Captured nameplate" />
          <div class="scan-placeholder" id="scanPlaceholder">
            <div class="scan-placeholder-mark">&#128247;</div>
            <p>Take a photo of the nameplate</p>
            <p class="scan-placeholder-hint">Get close enough that the model and serial fill most of the frame. Use your camera's flash if the label is in the dark.</p>
          </div>
          <div class="scan-flash" id="scanFlash"></div>
          <div class="scan-banner">
            <div class="item-target">${escapeHtml(item.name)}</div>
            <div class="progress">Item ${itemIndex + 1} of ${items.length} &middot; Unit ${escapeHtml(unitNumber)}</div>
          </div>
          <div class="scan-status" id="scanStatus">Tap Take photo to read the label</div>
        </div>
        <div class="scan-controls">
          <input type="file" accept="image/*" capture="environment" id="photoInput" hidden />
          <div class="buttons">
            <button class="primary" id="captureBtn">Take photo</button>
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

    const photoEl = document.getElementById('scanPhoto');
    const photoInput = document.getElementById('photoInput');
    const placeholderEl = document.getElementById('scanPlaceholder');
    const statusEl = document.getElementById('scanStatus');
    const modelField = document.getElementById('modelField');
    const serialField = document.getElementById('serialField');
    const captureBtn = document.getElementById('captureBtn');
    modelField.value = item.model || '';
    serialField.value = item.serial || '';

    let destroyed = false;
    // Full-resolution photo kept around so a tap can re-read one region of it
    // at native detail rather than at the downscaled size used for OCR.
    let fullPhoto = null;

    document.getElementById('exitScan').addEventListener('click', (e) => {
      e.preventDefault();
      cleanup();
      navigate(`/project/${projectId}/unit/${unitId}`);
    });

    // The phone's own camera app, not a getUserMedia video frame. This is the
    // single biggest accuracy win available to us: the native camera gives a
    // full-resolution still that is autofocused, properly exposed, optionally
    // flash-lit and stabilised, where a live video frame is a low-resolution,
    // frequently out-of-focus grab. OCR quality is dominated by input quality,
    // and no amount of processing recovers detail the frame never captured.
    captureBtn.addEventListener('click', () => photoInput.click());

    photoInput.addEventListener('change', async () => {
      const file = photoInput.files && photoInput.files[0];
      if (!file) return;
      captureBtn.disabled = true;
      statusEl.textContent = 'Reading label...';
      try {
        fullPhoto = await loadPhotoCanvas(file);
        photoEl.src = fullPhoto.toDataURL('image/jpeg', 0.7);
        photoEl.hidden = false;
        placeholderEl.hidden = true;
        captureBtn.textContent = 'Retake photo';

        await ensureWorker();
        const guess = await readLabelFromCanvas(fullPhoto, (msg) => { statusEl.textContent = msg; });
        applyGuess(guess);
      } catch (e) {
        statusEl.textContent = `Couldn't read that photo (${e.message}). Type it in below.`;
      }
      photoInput.value = '';
      captureBtn.disabled = false;
    });

    // Tapping the photo re-reads just that area at full sensor resolution.
    // When a plate is small in frame, or one field read and the other didn't,
    // pointing at the line is far quicker than retaking the shot.
    photoEl.addEventListener('click', async (e) => {
      if (!fullPhoto || captureBtn.disabled) return;
      const rect = photoEl.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / rect.width;
      const relY = (e.clientY - rect.top) / rect.height;
      captureBtn.disabled = true;
      statusEl.textContent = 'Reading that area...';
      try {
        const region = cropRegion(fullPhoto, relX, relY);
        const guess = await readLabelFromCanvas(region, () => {});
        applyGuess(guess, 'Nothing readable there — try tapping directly on the model or serial line.');
      } catch (err) {
        statusEl.textContent = `Couldn't read that area (${err.message}).`;
      }
      captureBtn.disabled = false;
    });

    function applyGuess(guess, emptyMessage) {
      if (guess.model) modelField.value = guess.model;
      if (guess.serial) serialField.value = guess.serial;
      if (!guess.model && !guess.serial) {
        statusEl.textContent = emptyMessage || "Couldn't read it clearly — tap directly on the label in the photo, or type it in below.";
      } else if (guess.model && guess.serial) {
        statusEl.textContent = 'Check both fields, then Confirm.';
      } else {
        statusEl.textContent = `Read the ${guess.model ? 'model' : 'serial'} only — tap the other line in the photo, or type it in.`;
      }
    }

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

    // Warm the OCR engine up while the user is framing their shot.
    ensureWorker().catch(() => {});
  }

  // Decodes a photo from the camera into a full-resolution canvas.
  function loadPhotoCanvas(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not decode image')); };
      img.src = url;
    });
  }

  // Crops a region around a point the user tapped, taken from the photo at
  // native resolution so the crop gains real detail rather than just zooming
  // pixels that were already thrown away.
  function cropRegion(photo, relX, relY) {
    const rw = Math.round(photo.width * 0.55);
    const rh = Math.round(photo.height * 0.22);
    const x = Math.max(0, Math.min(photo.width - rw, Math.round(photo.width * relX - rw / 2)));
    const y = Math.max(0, Math.min(photo.height - rh, Math.round(photo.height * relY - rh / 2)));

    const canvas = document.createElement('canvas');
    canvas.width = rw;
    canvas.height = rh;
    canvas.getContext('2d').drawImage(photo, x, y, rw, rh, 0, 0, rw, rh);
    return canvas;
  }

  // Turns a canvas into the grayscale buffer the OCR renditions are built
  // from, scaled so characters have enough height for Tesseract to work with
  // but not so large that a phone chokes on it.
  function frameFromCanvas(source, targetLongEdge) {
    const longEdge = Math.max(source.width, source.height);
    const target = targetLongEdge || 2400;
    // Scale toward the target in both directions: a full-resolution phone
    // photo is scaled down (OCR cost is pixels), a small crop is scaled up
    // (Tesseract needs character height).
    const scale = target / longEdge;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const w = canvas.width, h = canvas.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    return { gray, w, h };
  }

  // Whether the server has a cloud OCR key configured. Checked once per
  // session; on-device OCR is used whenever this is false or the call fails.
  let cloudOcrAvailable = null;
  async function hasCloudOcr() {
    if (cloudOcrAvailable !== null) return cloudOcrAvailable;
    try {
      const status = await api('/api/ocr/status');
      cloudOcrAvailable = !!status.available;
    } catch (e) {
      cloudOcrAvailable = false;
    }
    return cloudOcrAvailable;
  }

  // Sends the photo to the server's cloud OCR. The image is scaled down and
  // JPEG-compressed first: on site the upload runs over patchy cellular from
  // inside a concrete building, so payload size drives the round trip far
  // more than anything on the server.
  function toUploadBlob(source) {
    const longEdge = Math.max(source.width, source.height);
    const scale = Math.min(1, 1600 / longEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
  }

  async function readLabelViaCloud(source) {
    const blob = await toUploadBlob(source);
    const form = new FormData();
    form.append('image', blob, 'label.jpg');
    const resp = await fetch('/api/ocr', { method: 'POST', body: form });
    if (!resp.ok) throw new Error(`cloud OCR failed (${resp.status})`);
    const data = await resp.json();
    return parseModelSerial(data.text || '');
  }

  // Runs OCR over one image, fastest-and-most-likely configuration first.
  //
  // Speed comes from doing less, not from doing it worse: a sharp photo from
  // the phone's camera usually reads on the first pass, and OCR time scales
  // with pixel count, so pass 1 works at a deliberately modest size. Only a
  // plate that fails pays for the bigger, slower passes.
  const OCR_TIERS = [
    { longEdge: 1500, rendition: 'adaptive', psm: '6' },
    { longEdge: 2400, rendition: 'adaptive', psm: '3' },
    { longEdge: 2400, rendition: 'plain', psm: '3' },
    { longEdge: 2400, rendition: 'centre', psm: '3' },
  ];

  async function readLabelFromCanvas(source, onProgress) {
    const guess = { model: '', serial: '' };

    // Cloud first when it's configured: it reads plates that defeat
    // in-browser OCR, and returns in a fraction of the time. Any failure —
    // no signal, quota exhausted, server down — falls through to the
    // on-device passes below, so scanning never hard-stops on site.
    if (await hasCloudOcr()) {
      try {
        const cloud = await readLabelViaCloud(source);
        if (cloud.model) guess.model = cloud.model;
        if (cloud.serial) guess.serial = cloud.serial;
        if (guess.model && guess.serial) return guess;
        onProgress('Checking again on-device...');
      } catch (e) {
        onProgress('No signal for the fast reader — reading on-device...');
      }
    }

    const frames = new Map();

    for (let i = 0; i < OCR_TIERS.length; i++) {
      const tier = OCR_TIERS[i];
      if (i > 0) onProgress(`Still reading... (pass ${i + 1} of ${OCR_TIERS.length})`);

      if (!frames.has(tier.longEdge)) frames.set(tier.longEdge, frameFromCanvas(source, tier.longEdge));
      const canvas = renderFor(frames.get(tier.longEdge), tier.rendition);

      await tesseractWorker.setParameters({ tessedit_pageseg_mode: tier.psm });
      const { data } = await tesseractWorker.recognize(canvas);
      const pass = parseModelSerial(data.text || '');
      const words = data.words || [];
      // A value is only accepted if Tesseract was actually confident about the
      // characters it read. Without this gate a garbled pass can hand back
      // something that merely looks code-shaped, and a wrong serial recorded
      // against a unit is worse than a blank one — nobody re-checks a field
      // that already looks filled in.
      if (!guess.model && pass.model && isConfident(pass.model, words)) guess.model = pass.model;
      if (!guess.serial && pass.serial && isConfident(pass.serial, words)) guess.serial = pass.serial;
      if (guess.model && guess.serial) break;
    }
    return guess;
  }

  // True when the recognised value is backed by words Tesseract read with
  // reasonable confidence. Values that came through a labelled anchor are
  // trusted a little more readily than ones found by shape alone.
  function isConfident(value, words, minConfidence) {
    if (!words.length) return true; // no word data available; don't block the read
    const threshold = minConfidence || 55;
    const target = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    for (const word of words) {
      const text = (word.text || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (!text) continue;
      if (text === target || text.includes(target) || target.includes(text)) {
        if ((word.confidence || 0) >= threshold) return true;
      }
    }
    return false;
  }

  function grayToCanvas(gray, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(w, h);
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
      out.data[i] = out.data[i + 1] = out.data[i + 2] = gray[p];
      out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
  }

  // Adaptive (local mean) threshold via a summed-area table, so the cost is
  // one pass regardless of window size.
  function adaptiveThreshold(gray, w, h) {
    const iw = w + 1;
    const ii = new Uint32Array(iw * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        ii[(y + 1) * iw + (x + 1)] = ii[y * iw + (x + 1)] + rowSum;
      }
    }
    const radius = Math.max(7, Math.round(Math.min(w, h) * 0.03));
    const bias = 8;
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
        const area = (y1 - y0) * (x1 - x0);
        const sum = ii[y1 * iw + x1] - ii[y0 * iw + x1] - ii[y1 * iw + x0] + ii[y0 * iw + x0];
        out[y * w + x] = gray[y * w + x] > sum / area - bias ? 255 : 0;
      }
    }
    return out;
  }

  // Builds one rendition of a frame on demand. Each fails differently, which
  // is what lets a later pass rescue a plate the first pass couldn't read.
  function renderFor(frame, rendition) {
    const { gray, w, h } = frame;
    if (rendition === 'plain') return grayToCanvas(gray, w, h);
    if (rendition === 'adaptive') return grayToCanvas(adaptiveThreshold(gray, w, h), w, h);

    // 'centre': the middle of the shot, re-thresholded on its own so the
    // surrounding scene can't influence it.
    const cx0 = Math.round(w * 0.05), cx1 = Math.round(w * 0.95);
    const cy0 = Math.round(h * 0.20), cy1 = Math.round(h * 0.90);
    const cw = cx1 - cx0, ch = cy1 - cy0;
    const centreGray = new Uint8ClampedArray(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) centreGray[y * cw + x] = gray[(y + cy0) * w + (x + cx0)];
    }
    return grayToCanvas(adaptiveThreshold(centreGray, cw, ch), cw, ch);
  }

  function grayToCanvas(gray, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(w, h);
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
      out.data[i] = out.data[i + 1] = out.data[i + 2] = gray[p];
      out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
  }

  // Adaptive (local mean) threshold via a summed-area table, so the cost is
  // one pass regardless of window size. Integer sums stay well inside Uint32
  // range for any canvas we produce here.
  function adaptiveThreshold(gray, w, h) {
    const iw = w + 1;
    const ii = new Uint32Array(iw * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        ii[(y + 1) * iw + (x + 1)] = ii[y * iw + (x + 1)] + rowSum;
      }
    }

    // Window ~6% of the short edge: comfortably larger than a character, small
    // enough to track uneven lighting across the plate.
    const radius = Math.max(7, Math.round(Math.min(w, h) * 0.03));
    const bias = 8; // keeps faint paper texture from turning into speckle
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
        const area = (y1 - y0) * (x1 - x0);
        const sum = ii[y1 * iw + x1] - ii[y0 * iw + x1] - ii[y1 * iw + x0] + ii[y0 * iw + x0];
        out[y * w + x] = gray[y * w + x] > sum / area - bias ? 255 : 0;
      }
    }
    return out;
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
