(() => {
  const root = document.getElementById('view-root');

  // Set from /api/auth/status before the first render. Administrators run the
  // jobs; field team scan them and can't change or bin anything.
  let currentUser = null;
  let canManage = true;

  function scannedBy() {
    return (currentUser && (currentUser.name || currentUser.email)) || 'Crew';
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  /** What the pencil on a project tile opens. Rename is the everyday action;
   *  moving a job to the trash sits behind it rather than on the tile. */
  function showProjectMenu(projectName) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = `
        <div class="confirm-box">
          <p><strong>${escapeHtml(projectName)}</strong></p>
          <div class="menu-actions">
            <button class="secondary" data-action="rename">Rename project</button>
            <button class="danger-quiet" data-action="trash">Move to trash&hellip;</button>
          </div>
          <div class="row" style="justify-content:flex-end; margin-top:12px;">
            <button class="secondary" data-action="cancel">Cancel</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const done = (result) => { overlay.remove(); resolve(result); };
      overlay.querySelectorAll('[data-action]').forEach((button) => {
        button.addEventListener('click', () => done(button.dataset.action === 'cancel' ? null : button.dataset.action));
      });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    });
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

  // Like showConfirm, but with several named outcomes — used when a scan may
  // belong to a different appliance and "yes/no" can't express the options.
  function showChoice(message, options) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = `
        <div class="confirm-box">
          <p>${escapeHtml(message)}</p>
          <div class="choice-buttons">
            ${options.map((o, i) => `<button class="${i === 0 ? 'primary' : 'secondary'}" data-value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`).join('')}
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const done = (value) => { overlay.remove(); resolve(value); };
      overlay.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => done(b.dataset.value)));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
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
  // Set by the dashboard so its background refresh redraws the level the user
  // is actually looking at. Cleared on navigation so a stale closure can never
  // paint over a different screen.
  let dashboardRefresh = null;

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
    dashboardRefresh = null;
    const hash = window.location.hash.slice(1);

    if (!hash || hash === '/') {
      renderProjects();
      return;
    }

    if (hash === '/trash') {
      if (!canManage) { navigate('/'); return; }
      renderTrash();
      return;
    }

    const projectMatch = hash.match(/^\/project\/(\d+)$/);
    if (projectMatch) {
      renderTools(parseInt(projectMatch[1], 10));
      return;
    }

    const scannerMatch = hash.match(/^\/project\/(\d+)\/scanner$/);
    if (scannerMatch) {
      renderDashboard(parseInt(scannerMatch[1], 10));
      return;
    }

    // Billing is administrators only, on the way in as well as on the server.
    const commitmentsMatch = hash.match(/^\/project\/(\d+)\/commitments$/);
    if (commitmentsMatch) {
      if (!canManage) { navigate(`/project/${commitmentsMatch[1]}`); return; }
      renderCommitments(parseInt(commitmentsMatch[1], 10));
      return;
    }

    const commitmentMatch = hash.match(/^\/project\/(\d+)\/commitment\/(\d+)(?:\/(sov|changes|invoicing))?$/);
    if (commitmentMatch) {
      if (!canManage) { navigate(`/project/${commitmentMatch[1]}`); return; }
      renderCommitment(parseInt(commitmentMatch[1], 10), parseInt(commitmentMatch[2], 10), commitmentMatch[3] || 'sov');
      return;
    }

    const changeOrderMatch = hash.match(/^\/project\/(\d+)\/commitment\/(\d+)\/co\/(\d+)$/);
    if (changeOrderMatch) {
      if (!canManage) { navigate(`/project/${changeOrderMatch[1]}`); return; }
      renderChangeOrder(parseInt(changeOrderMatch[1], 10), parseInt(changeOrderMatch[2], 10), parseInt(changeOrderMatch[3], 10));
      return;
    }

    const payAppMatch = hash.match(/^\/project\/(\d+)\/commitment\/(\d+)\/app\/(\d+)$/);
    if (payAppMatch) {
      if (!canManage) { navigate(`/project/${payAppMatch[1]}`); return; }
      renderPayApp(parseInt(payAppMatch[1], 10), parseInt(payAppMatch[2], 10), parseInt(payAppMatch[3], 10));
      return;
    }

    // Building, then floor. A unit number encodes both: 1202 is building 1,
    // floor 2 — so the drill-down needs no extra data, just the numbers the
    // crew already uses.
    const buildingMatch = hash.match(/^\/project\/(\d+)\/b\/([^/]+)$/);
    if (buildingMatch) {
      renderDashboard(parseInt(buildingMatch[1], 10), decodeURIComponent(buildingMatch[2]));
      return;
    }

    const floorMatch = hash.match(/^\/project\/(\d+)\/b\/([^/]+)\/f\/([^/]+)$/);
    if (floorMatch) {
      renderDashboard(parseInt(floorMatch[1], 10), decodeURIComponent(floorMatch[2]), decodeURIComponent(floorMatch[3]));
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
          ${canManage ? `
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
          </div>` : ''}
        </div>
      </div>
      <div class="card">
        <div class="unit-grid" id="projectGrid"></div>
        ${projects.length === 0 ? (canManage
          ? '<p class="help">No projects yet — click the + button above to create your first one.</p>'
          : '<p class="help">No projects yet. An administrator sets these up.</p>') : ''}
      </div>
    `;

    if (canManage) {
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
    }

    const grid = document.getElementById('projectGrid');
    grid.innerHTML = projects.map((p) => `
      <div class="unit-tile project-tile ${p.totalUnits > 0 && p.completeUnits === p.totalUnits ? 'complete' : (p.doneItems > 0 ? 'inprogress' : '')}" data-id="${p.id}">
        ${canManage ? `<button class="project-edit" data-id="${p.id}" aria-label="Edit project">&#9998;</button>` : ''}
        ${p.totalUnits > 0 && p.completeUnits === p.totalUnits ? '<div class="check">&#10003;</div>' : ''}
        <div class="unit-num">${escapeHtml(p.name)}</div>
        <div class="unit-progress">${p.completeUnits}/${p.totalUnits} units</div>
      </div>
    `).join('');
    grid.querySelectorAll('.project-tile').forEach((el) => {
      el.addEventListener('click', () => navigate(`/project/${el.dataset.id}`));
    });
    grid.querySelectorAll('.project-edit').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const proj = projects.find((p) => String(p.id) === String(id));
        const choice = await showProjectMenu(proj ? proj.name : 'this project');

        if (choice === 'rename') {
          const newName = await showPrompt('Rename project', proj ? proj.name : '', 'Save');
          if (!newName) return;
          try {
            await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
            toast('Project renamed');
            renderProjects();
          } catch (err) {
            toast(`Could not rename: ${err.message}`);
          }
          return;
        }

        if (choice === 'trash') {
          // Binning a job with hundreds of scanned units should take more than
          // a stray tap, so the name has to be typed out.
          const typed = await showPrompt(
            `Move "${proj ? proj.name : 'this project'}" to the trash? Type the project name to confirm.`,
            '', 'Move to trash');
          if (!typed) return;
          if (typed.trim().toLowerCase() !== String(proj ? proj.name : '').trim().toLowerCase()) {
            toast("That name doesn't match — nothing was moved");
            return;
          }
          try {
            await api(`/api/projects/${id}`, { method: 'DELETE' });
            toast('Moved to trash');
            renderProjects();
          } catch (err) {
            toast(`Could not move to trash: ${err.message}`);
          }
        }
      });
    });

    if (canManage) document.getElementById('createProjectBtn').addEventListener('click', async () => {
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
  async function renderDashboard(projectId, building, floor) {
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

    drawDashboard(project, units, building, floor);
    startPolling(async () => {
      const fresh = await api(`/api/units?projectId=${projectId}`).then((d) => d.units);
      if (dashboardRefresh) dashboardRefresh(fresh);
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
    grid.dataset.level = 'units';
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

  // A unit number carries its own location: first digit the building,
  // second the floor. 1202 is building 1, floor 2.
  const buildingOfUnit = (n) => { const m = String(n || '').trim().match(/^(\d)/); return m ? m[1] : 'Other'; };
  const floorOfUnit = (n) => { const m = String(n || '').trim().match(/^\d(\d)/); return m ? m[1] : 'Other'; };

  // The floor a unit sits on, as a route. Finishing 5111 should return you to
  // building 5, floor 1 — the list you were working through — not to the top
  // of the job, which costs three taps to get back down.
  function floorRouteFor(projectId, unitNumber) {
    const building = buildingOfUnit(unitNumber);
    const floor = floorOfUnit(unitNumber);
    if (building === 'Other' || floor === 'Other') return `/project/${projectId}/scanner`;
    return `/project/${projectId}/b/${encodeURIComponent(building)}/f/${encodeURIComponent(floor)}`;
  }

  // Rolls a set of units into groups with their own progress totals, so a
  // building or floor tile shows how much of it is done — the thing a super
  // actually wants to know before walking over there.
  function groupUnits(units, keyOf) {
    const groups = new Map();
    for (const u of units) {
      const key = keyOf(u.unitNumber);
      if (!groups.has(key)) groups.set(key, { key, units: [], doneItems: 0, totalItems: 0, completeUnits: 0 });
      const g = groups.get(key);
      g.units.push(u);
      g.doneItems += u.doneItems;
      g.totalItems += u.totalItems;
      if (u.complete) g.completeUnits++;
    }
    return [...groups.values()].sort((a, b) => {
      if (a.key === 'Other') return 1;
      if (b.key === 'Other') return -1;
      return Number(a.key) - Number(b.key);
    });
  }

  // ---------------- Tools ----------------
  // A project is more than the scanner — this is where the rest will live.
  // One tool today, so the screen stays a plain list rather than a grid of one.
  const TOOLS = [
    {
      id: 'scanner',
      name: 'Appliance Scanner',
      icon: '\u{1F4F7}',
      blurb: 'Scan model and serial numbers unit by unit.',
      route: (projectId) => `/project/${projectId}/scanner`,
    },
    {
      id: 'commitments',
      name: 'Commitments & Billing',
      icon: '\u{1F4C4}',
      blurb: 'Subcontracts, change orders and pay applications.',
      adminOnly: true,
      route: (projectId) => `/project/${projectId}/commitments`,
    },
  ];

  async function renderTools(projectId) {
    root.innerHTML = `<div class="card"><p class="help">Loading...</p></div>`;
    let project;
    let summary = null;
    try {
      project = (await api(`/api/projects/${projectId}`)).project;
      const all = await api('/api/projects');
      summary = (all.projects || []).find((p) => p.id === projectId) || null;
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="help">Could not load this project: ${e.message}</p></div>`;
      return;
    }

    // Progress belongs to the tool it describes — up by the project title it
    // would be anyone's guess which tool the numbers were about.
    const progress = summary
      ? `${summary.completeUnits} of ${summary.totalUnits} units complete`
      : '';

    root.innerHTML = `
      <div class="row between">
        <h1 style="margin:0;">${escapeHtml(project.name)}</h1>
        <button class="secondary" id="backBtn">&larr; All projects</button>
      </div>
      <div class="card">
        <h2 style="margin-top:0;">Tools</h2>
        <div class="tool-list">
          ${TOOLS.filter((tool) => canManage || !tool.adminOnly).map((tool) => `
            <button class="tool-tile" data-tool="${tool.id}">
              <span class="tool-icon">${tool.icon}</span>
              <span class="tool-text">
                <span class="tool-name">${escapeHtml(tool.name)}</span>
                <span class="tool-blurb">${escapeHtml(tool.blurb)}</span>
                ${tool.id === 'scanner' && progress ? `<span class="tool-progress">${progress}</span>` : ''}
              </span>
              <span class="tool-go">&rsaquo;</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;

    document.getElementById('backBtn').addEventListener('click', () => navigate('/'));
    root.querySelectorAll('.tool-tile').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = TOOLS.find((t) => t.id === btn.dataset.tool);
        if (tool) navigate(tool.route(projectId));
      });
    });
  }

  function drawDashboard(project, units, building, floor) {
    const totalUnits = units.length;
    const completeUnits = units.filter((u) => u.complete).length;
    const totalItems = units.reduce((s, u) => s + u.totalItems, 0);
    const doneItems = units.reduce((s, u) => s + u.doneItems, 0);

    // Which slice of the job is on screen: the whole project, one building,
    // or one floor of one building. Kept as a function because the background
    // refresh has to re-apply it — see dashboardRefresh at the end.
    let currentUnits = units;
    const scopeOf = (list) => list.filter((u) =>
      (building === undefined || buildingOfUnit(u.unitNumber) === building) &&
      (floor === undefined || floorOfUnit(u.unitNumber) === floor));
    const inScope = scopeOf(currentUnits);

    const scopeUnits = inScope.length;
    const scopeComplete = inScope.filter((u) => u.complete).length;
    const scopeDone = inScope.reduce((s, u) => s + u.doneItems, 0);
    const scopeTotal = inScope.reduce((s, u) => s + u.totalItems, 0);

    const crumbs = [`<a href="#/project/${project.id}/scanner" class="crumb">All buildings</a>`];
    if (building !== undefined) {
      const label = building === 'Other' ? 'Other units' : `Building ${escapeHtml(building)}`;
      crumbs.push(floor === undefined ? `<span class="crumb current">${label}</span>`
        : `<a href="#/project/${project.id}/b/${encodeURIComponent(building)}" class="crumb">${label}</a>`);
    }
    if (floor !== undefined) {
      crumbs.push(`<span class="crumb current">${floor === 'Other' ? 'Other' : `Floor ${escapeHtml(floor)}`}</span>`);
    }

    const backTarget = floor !== undefined
      ? `/project/${project.id}/b/${encodeURIComponent(building)}`
      : (building !== undefined ? `/project/${project.id}/scanner` : `/project/${project.id}`);

    root.innerHTML = `
      <div class="row between">
        <div class="row" style="gap:8px;">
          <h1 style="margin:0;">${escapeHtml(project.name)}</h1>
          ${canManage ? `<button class="secondary" id="renameProjectBtn" aria-label="Rename project" style="padding:4px 8px;">&#9998;</button>` : ''}
        </div>
        <div class="row">
          <button class="secondary" id="backBtn">&larr; ${building === undefined ? 'Tools' : 'Back'}</button>
          ${canManage ? `<button class="secondary" id="reimportBtn">Re-import list</button>` : ''}
        </div>
      </div>
      <div class="crumbs">${crumbs.join('<span class="crumb-sep">/</span>')}</div>
      <div class="stats">
        <div class="stat"><div class="num">${scopeComplete}/${scopeUnits}</div><div class="label">Units complete</div></div>
        <div class="stat"><div class="num">${scopeDone}/${scopeTotal}</div><div class="label">Items scanned</div></div>
      </div>
      <div class="card">
        <div class="row">
          <input type="text" id="searchBox" placeholder="Search any unit number..." />
        </div>
        <div class="unit-grid" id="unitGrid" data-project-id="${project.id}"></div>
      </div>
      <div class="card">
        <h2>Export</h2>
        <p class="help">One tab per building, laid out like the Appliance List: unit in column A, Model #/Serial # in column B, one column per appliance.</p>
        <div class="row">
          <a href="/api/export.xlsx?projectId=${project.id}"><button class="primary">Download Excel</button></a>
          <a href="/api/export.csv?projectId=${project.id}"><button class="secondary">Download CSV</button></a>
        </div>
      </div>
    `;

    drawLevel();

    // Searching cuts straight to matching units from wherever you are —
    // hunting one unit shouldn't mean walking back down the hierarchy.
    document.getElementById('searchBox').addEventListener('input', (e) => {
      const term = e.target.value.trim();
      if (term) renderUnitGrid(currentUnits.filter((u) => u.unitNumber.toLowerCase().includes(term.toLowerCase())), '');
      else drawLevel();
    });

    // The five-second refresh used to redraw the flat list of every unit in
    // the project, so a moment after opening a building the floor tiles were
    // replaced by all 296 units and the stats reverted to project totals.
    // A refresh now redraws whichever level is actually open.
    dashboardRefresh = (fresh) => {
      currentUnits = fresh;
      updateDashboardStats(scopeOf(fresh));
      const searchBox = document.getElementById('searchBox');
      const term = searchBox ? searchBox.value.trim() : '';
      if (term) renderUnitGrid(fresh.filter((u) => u.unitNumber.toLowerCase().includes(term.toLowerCase())), '');
      else drawLevel();
    };

    function drawLevel() {
      const grid = document.getElementById('unitGrid');
      if (!grid) return;
      const scoped = scopeOf(currentUnits);
      if (floor !== undefined) { renderUnitGrid(scoped, ''); return; }

      const groups = building === undefined
        ? groupUnits(currentUnits, buildingOfUnit)
        : groupUnits(scoped, floorOfUnit);

      grid.innerHTML = groups.map((g) => {
        const done = g.completeUnits === g.units.length;
        const label = building === undefined
          ? (g.key === 'Other' ? 'Other' : `Bldg ${escapeHtml(g.key)}`)
          : (g.key === 'Other' ? 'Other' : `Floor ${escapeHtml(g.key)}`);
        return `
          <button class="unit-tile ${done ? 'complete' : (g.doneItems > 0 ? 'inprogress' : '')}" data-key="${escapeHtml(g.key)}">
            ${done ? '<div class="check">&#10003;</div>' : ''}
            <div class="unit-num">${label}</div>
            <div class="unit-progress">${g.completeUnits}/${g.units.length} units</div>
          </button>`;
      }).join('') || '<p class="help">No units.</p>';

      grid.querySelectorAll('.unit-tile').forEach((el) => {
        el.addEventListener('click', () => {
          const key = el.dataset.key;
          navigate(building === undefined
            ? `/project/${project.id}/b/${encodeURIComponent(key)}`
            : `/project/${project.id}/b/${encodeURIComponent(building)}/f/${encodeURIComponent(key)}`);
        });
      });
    }

    document.getElementById('backBtn').addEventListener('click', () => navigate(backTarget));
    if (canManage) document.getElementById('renameProjectBtn').addEventListener('click', async () => {
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
    if (canManage) document.getElementById('reimportBtn').addEventListener('click', async () => {
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
        <button class="secondary" id="backBtn">&larr; Back</button>
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

    document.getElementById('backBtn').addEventListener('click', () => navigate(floorRouteFor(projectId, unit.unitNumber)));

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
  // "ENL-50 120" -> "AAA-99 999". Letters and digits are generalised, and
  // separators kept, so a shape describes a plate's format without pinning it
  // to one particular unit's value.
  function shapeOf(value) {
    return String(value).replace(/[A-Za-z]/g, 'A').replace(/[0-9]/g, '9');
  }

  function matchesLearnedShape(value, shapes) {
    if (!shapes || !shapes.length) return false;
    return shapes.indexOf(shapeOf(value)) !== -1;
  }

  // Normalised label context: the words immediately before a value on the
  // plate, reduced so "Model Number", "MODEL NO." and "Model No:" compare
  // equal. This is what lets a correction teach WHERE on the label to look.
  function contextKey(text) {
    return String(text || '').toLowerCase().replace(/[^a-z]/g, '').slice(-18);
  }

  const emptyLearned = () => ({
    model: { prefer: [], avoid: [], contexts: [] },
    serial: { prefer: [], avoid: [], contexts: [] },
  });

  function parseModelSerial(text, learned) {
    const shapes = learned && learned.model && learned.model.prefer ? learned : emptyLearned();
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
      // Electrical ratings printed alongside the codes — "120VAC", "60HZ",
      // "1000W", "15A". These are letter-and-digit mixes exactly like a real
      // code, so shape alone cannot tell them apart. Checked first so it
      // applies on every path, strict or not.
      if (/^\d+(\.\d+)?(VAC|VDC|VA|V|HZ|KHZ|MHZ|GHZ|KW|W|MA|A|AMPS?|PSI|LBS?|KG|OZ|CFM|BTU|RPM)$/i.test(tok)) return false;
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

    // Picks the value following a label. Normally that's the first
    // code-shaped token, but some plates print a value containing a space
    // ("ENL-50 120"), which no amount of token-splitting recovers on its own.
    // A learned shape for this field authorises joining the next tokens — and
    // only a learned shape does, so nothing is glued together speculatively.
    // Every code-shaped token after a label is a candidate, including runs of
    // tokens joined together ("ENL-50" + "120"). Candidates are scored rather
    // than taking the first, because the first is exactly what gets it wrong
    // on a crowded plate — and a score is what lets one correction from the
    // crew outweigh the reading order.
    function pickValue(tokens, learnedField, contextText) {
      const field = learnedField || { prefer: [], avoid: [], contexts: [] };
      const ctx = contextKey(contextText);
      const contextKnown = field.contexts.length > 0 && field.contexts.some((c) => ctx.endsWith(c) || c.endsWith(ctx));

      let best = null;
      for (let i = 0; i < tokens.length; i++) {
        if (!isCode(tokens[i], { requireLetter: false })) continue;

        // The single token, plus each joined run starting at it.
        const forms = [tokens[i]];
        for (let extra = 1; extra <= 3 && i + extra < tokens.length; extra++) {
          forms.push(tokens.slice(i, i + 1 + extra).join(' '));
        }

        for (const value of forms) {
          const shape = shapeOf(value);
          let score = 0;
          // A shape the crew has confirmed for this appliance is the
          // strongest signal available; one they overwrote is a veto.
          if (field.prefer.indexOf(shape) !== -1) score += 50;
          if (field.avoid.indexOf(shape) !== -1) score -= 80;
          // Following a label word this appliance is known to use.
          if (contextKnown) score += 20;
          // All else equal, the value nearest the label wins.
          score -= i * 3;
          // Prefer the single token unless a join was specifically learned.
          if (value.includes(' ') && field.prefer.indexOf(shape) === -1) score -= 30;

          if (!best || score > best.score) best = { value, score };
        }
      }
      return best && best.score > -40 ? best.value : '';
    }

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
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const mIdx = modelIndex(line);
      const sIdx = serialIndex(line);
      if (mIdx === -1 && sIdx === -1) continue;

      if (mIdx !== -1 && sIdx !== -1) {
        // A column HEADER row ("MODEL NO.  SERIAL NO.  120VAC 60Hz"): the
        // values sit on the row underneath, in the same left-to-right order.
        // Checked before reading the header line itself, because anything
        // trailing the labels there belongs to a further column — that is how
        // a rating like "120VAC" ended up recorded as a serial number.
        const below = tokensOf(lines[li + 1] || '').filter((t) => isCode(t));
        if (below.length >= 2) {
          const modelFirst = mIdx < sIdx;
          if (!model) model = modelFirst ? below[0] : below[1];
          if (!serial) serial = modelFirst ? below[1] : below[0];
          continue;
        }

        // Otherwise both labels really are inline on this row, and each owns
        // the codes that follow it up to the next label.
        const first = Math.min(mIdx, sIdx);
        const firstIsModel = mIdx < sIdx;
        const segA = line.slice(first, Math.max(mIdx, sIdx));
        const segB = line.slice(Math.max(mIdx, sIdx));
        const tokensA = tokensOf(segA);
        const tokensB = tokensOf(segB);
        if (firstIsModel) {
          if (!model) model = pickValue(tokensA, shapes.model, segA) || model;
          if (!serial) serial = pickValue(tokensB, shapes.serial, segB) || serial;
        } else {
          if (!serial) serial = pickValue(tokensA, shapes.serial, segA) || serial;
          if (!model) model = pickValue(tokensB, shapes.model, segB) || model;
        }
        continue;
      }

      const labelStart = mIdx !== -1 ? mIdx : sIdx;
      const tail = tokensOf(line.slice(labelStart));
      const context = line.slice(labelStart, labelStart + 24);
      if (mIdx !== -1 && !model) model = pickValue(tail, shapes.model, context) || model;
      if (sIdx !== -1 && !serial) serial = pickValue(tail, shapes.serial, context) || serial;
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
        model = pickValue(tokensOf(next), shapes.model, line) || nextCodes[0];
      } else if (hasSerial && !serial) {
        serial = pickValue(tokensOf(next), shapes.serial, line) || nextCodes[0];
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

    // Final pass: honour what the crew has taught, wherever the value came
    // from. A value whose shape they have overwritten is dropped, and a
    // value matching a learned shape found anywhere in the text beats one
    // that matches nothing — this is what makes a single correction change
    // the outcome on the next unit rather than only on an identical layout.
    const allTokens = [];
    for (const line of lines) {
      const toks = tokensOf(line);
      for (let i = 0; i < toks.length; i++) {
        if (!isCode(toks[i], { requireLetter: false })) continue;
        allTokens.push(toks[i]);
        for (let extra = 1; extra <= 2 && i + extra < toks.length; extra++) {
          allTokens.push(toks.slice(i, i + 1 + extra).join(' '));
        }
      }
    }

    const applyLearning = (value, field) => {
      const learnedField = shapes[field];
      if (!learnedField) return value;
      const vetoed = value && learnedField.avoid.indexOf(shapeOf(value)) !== -1;
      const alreadyGood = value && learnedField.prefer.indexOf(shapeOf(value)) !== -1;
      if (alreadyGood) return value;
      if (!vetoed && !learnedField.prefer.length) return value;

      const other = field === 'model' ? serial : model;
      const match = allTokens.find((t) => learnedField.prefer.indexOf(shapeOf(t)) !== -1 && t !== other);
      if (match) return match;
      return vetoed ? '' : value;
    };

    model = applyLearning(model, 'model');
    serial = applyLearning(serial, 'serial');
    if (model && model === serial) serial = '';

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
          <div class="scan-photo-stage" id="photoStage" hidden>
            <img id="scanPhoto" alt="Captured nameplate" />
            <div class="scan-box scan-box-model" id="modelBox" hidden><span>MODEL</span></div>
            <div class="scan-box scan-box-serial" id="serialBox" hidden><span>SERIAL</span></div>
          </div>
          <div class="scan-placeholder" id="scanPlaceholder">
            <div class="scan-placeholder-mark">&#128247;</div>
            <p>Photograph the nameplate</p>
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
            <button class="capture-btn" id="captureBtn">Take photo</button>
          </div>
          <div class="fix-bar" id="fixBar" hidden>
            <span class="fix-bar-label">Wrong? Tap it on the photo:</span>
            <div class="fix-bar-buttons">
              <button class="quiet" id="fixModelBtn">Model</button>
              <button class="quiet" id="fixSerialBtn">Serial</button>
            </div>
          </div>
          <div class="fields">
            <div>
              <label>MODEL</label>
              <input type="text" id="modelField" autocomplete="off" />
              <button class="model-hint" id="modelHint" hidden></button>
            </div>
            <div>
              <label>SERIAL</label>
              <input type="text" id="serialField" autocomplete="off" />
            </div>
          </div>
          <div class="buttons">
            <button class="quiet" id="skipBtn">Skip</button>
            <button class="go-btn" id="confirmBtn">Confirm &amp; Next</button>
          </div>
          <div class="close-row">
            <a href="#" id="exitScan">&larr; Exit to unit</a>
            <span></span>
          </div>
        </div>
      </div>
    `;

    const photoEl = document.getElementById('scanPhoto');
    const photoStage = document.getElementById('photoStage');
    const modelBox = document.getElementById('modelBox');
    const serialBox = document.getElementById('serialBox');
    const fixBar = document.getElementById('fixBar');
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
        // Display a downscaled copy. A full-resolution phone photo as a data
        // URL is several megabytes of string held in memory, which is wasteful
        // on a phone when it's only ever shown a few hundred pixels wide. The
        // full-resolution canvas is kept for OCR and tap-to-read crops.
        photoEl.src = previewDataUrl(fullPhoto);
        photoStage.hidden = false;
        placeholderEl.hidden = true;
        fixBar.hidden = false;
        hideBoxes();
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

    // Which field the next tap on the photo should fill. Null means the tap
    // fills whichever field is still empty — the common case straight after a
    // capture. "Fix MODEL"/"Fix SERIAL" aim it at a specific field, which is
    // what you want when a value came back wrong rather than missing.
    let fixTarget = null;
    // What the reader proposed, so that a value the user changed by hand can
    // be told apart from one they simply accepted.
    const proposed = { model: '', serial: '' };
    // The text of the last read, so a hand-typed correction can be located
    // on the plate and its surrounding label words learned.
    let lastOcrText = '';

    function setFixTarget(target) {
      fixTarget = target;
      document.getElementById('fixModelBtn').classList.toggle('armed', target === 'model');
      document.getElementById('fixSerialBtn').classList.toggle('armed', target === 'serial');
      if (target) statusEl.textContent = `Tap the ${target.toUpperCase()} on the photo`;
    }

    document.getElementById('fixModelBtn').addEventListener('click', () => setFixTarget(fixTarget === 'model' ? null : 'model'));
    document.getElementById('fixSerialBtn').addEventListener('click', () => setFixTarget(fixTarget === 'serial' ? null : 'serial'));

    function hideBoxes() {
      modelBox.hidden = true;
      serialBox.hidden = true;
    }

    // Draws a box over the region a value was read from. The photo is
    // object-fit:contain, so the rendered image can be letterboxed inside the
    // element — the box has to be positioned against the rendered image, not
    // the element, or it drifts off the text it is meant to mark.
    function drawBox(el, box) {
      if (!box) { el.hidden = true; return; }
      const natW = photoEl.naturalWidth, natH = photoEl.naturalHeight;
      const elW = photoEl.clientWidth, elH = photoEl.clientHeight;
      if (!natW || !natH || !elW || !elH) { el.hidden = true; return; }

      const scale = Math.min(elW / natW, elH / natH);
      const renderedW = natW * scale, renderedH = natH * scale;
      const offsetX = (elW - renderedW) / 2, offsetY = (elH - renderedH) / 2;

      const pad = 0.004;
      el.style.left = `${offsetX + (box.left - pad) * renderedW}px`;
      el.style.top = `${offsetY + (box.top - pad) * renderedH}px`;
      el.style.width = `${(box.width + pad * 2) * renderedW}px`;
      el.style.height = `${(box.height + pad * 2) * renderedH}px`;
      el.hidden = false;
    }

    // Tapping the photo re-reads just that area at full sensor resolution.
    // When a plate is small in frame, or a value came back wrong, pointing at
    // the right line is far quicker than retaking the shot.
    photoEl.addEventListener('click', async (e) => {
      if (!fullPhoto || captureBtn.disabled) return;
      const rect = photoEl.getBoundingClientRect();
      const natW = photoEl.naturalWidth, natH = photoEl.naturalHeight;
      const scale = Math.min(rect.width / natW, rect.height / natH);
      const renderedW = natW * scale, renderedH = natH * scale;
      const offsetX = (rect.width - renderedW) / 2, offsetY = (rect.height - renderedH) / 2;

      // Ignore taps on the letterboxed margin rather than clamping them,
      // which would silently read the wrong part of the photo.
      const relX = (e.clientX - rect.left - offsetX) / renderedW;
      const relY = (e.clientY - rect.top - offsetY) / renderedH;
      if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return;

      captureBtn.disabled = true;
      statusEl.textContent = 'Reading that spot...';
      try {
        const region = cropRegion(fullPhoto, relX, relY);
        const guess = await readLabelFromCanvas(region, (msg) => { statusEl.textContent = msg; });
        const value = fixTarget === 'serial'
          ? (guess.serial || guess.model)
          : (guess.model || guess.serial);

        if (!value) {
          statusEl.textContent = 'Nothing readable there — tap directly on the number.';
        } else if (fixTarget) {
          (fixTarget === 'model' ? modelField : serialField).value = value;
          statusEl.textContent = `${fixTarget.toUpperCase()} set to ${value}. Check both, then Confirm.`;
          setFixTarget(null);
        } else {
          applyGuess(guess, 'Nothing readable there — tap directly on the number.');
        }
      } catch (err) {
        statusEl.textContent = `Couldn't read that spot (${err.message}).`;
      }
      captureBtn.disabled = false;
    });

    function applyGuess(guess, emptyMessage) {
      if (guess.sourceText) lastOcrText = guess.sourceText;
      if (guess.model) { modelField.value = guess.model; proposed.model = guess.model; }
      if (guess.serial) { serialField.value = guess.serial; proposed.serial = guess.serial; }

      // Show where each value came from, so a wrong read is obvious at a
      // glance instead of being discovered later in the spreadsheet.
      drawBox(modelBox, guess.modelBox);
      drawBox(serialBox, guess.serialBox);

      if (!guess.model && !guess.serial) {
        statusEl.textContent = emptyMessage || "Couldn't read it — tap the number on the photo, or type it below.";
      } else if (guess.model && guess.serial) {
        statusEl.textContent = 'Check the boxes match, then Confirm.';
      } else {
        statusEl.textContent = `Read the ${guess.model ? 'model' : 'serial'} only — tap the other one on the photo.`;
      }
    }

    document.getElementById('skipBtn').addEventListener('click', async () => {
      await saveItem(item.id, { status: 'skipped', scannedBy: scannedBy() });
      goToNext();
    });

    document.getElementById('confirmBtn').addEventListener('click', async () => {
      const model = modelField.value.trim();
      const serial = serialField.value.trim();

      // Check what's about to be saved against what this job already knows,
      // before it becomes a row in the export. A wrong value caught here costs
      // a tap; caught later it means walking back to the unit.
      const proceed = await checkBeforeSaving(model, serial);
      if (proceed === 'cancel') return;
      if (proceed === 'reassigned') return;

      await saveItem(item.id, { model, serial, status: 'done', scannedBy: scannedBy() });
      // Learn from what the user actually confirmed. A value they corrected
      // teaches the most, but an accepted one is worth recording too — it is
      // confirmation that this shape is what this appliance's plate looks
      // like, which is what lets a later ambiguous read be settled.
      learnFromConfirmation(item.name, 'model', model, proposed.model);
      learnFromConfirmation(item.name, 'serial', serial, proposed.serial);
      flashGreen(() => goToNext());
    });

    // Returns 'ok' to save here, 'cancel' to go back, or 'reassigned' when the
    // scan has been filed against the appliance it actually belongs to.
    async function checkBeforeSaving(model, serial) {
      // 1. Does this model belong to a different appliance on this job?
      //    This is the wrong-appliance catch: scanning the dryer while the
      //    washer is on screen produces the dryer's model, and the job has
      //    already recorded that model against the dryer on other units.
      const owner = applianceOwningModel(model, item.name);
      if (owner) {
        const otherItem = items.find((i) => i.name === owner.name);
        const choice = await showChoice(
          `That model is the ${owner.name}'s — it matches the ${owner.name} on ${owner.count} other unit${owner.count === 1 ? '' : 's'}. This screen is the ${item.name}.`,
          [
            otherItem ? { label: `Save as ${owner.name}`, value: 'reassign' } : null,
            { label: `Keep as ${item.name}`, value: 'keep' },
            { label: 'Go back', value: 'cancel' },
          ].filter(Boolean)
        );
        if (choice === 'cancel' || choice === null) return 'cancel';
        if (choice === 'reassign' && otherItem) {
          await saveItem(otherItem.id, { model, serial, status: 'done', scannedBy: scannedBy() });
          learnFromConfirmation(owner.name, 'model', model, proposed.model);
          learnFromConfirmation(owner.name, 'serial', serial, proposed.serial);
          toast(`Saved to ${owner.name}. ${item.name} still needs scanning.`);
          // Deliberately stays on this item rather than advancing: the
          // appliance on screen has not been scanned yet.
          modelField.value = '';
          serialField.value = '';
          statusEl.textContent = `Now scan the ${item.name}.`;
          return 'reassigned';
        }
      }

      // 2. Does the model differ from what every other unit carries?
      const expected = expectedModelFor(item.name);
      if (expected && model && model.replace(/[^A-Za-z0-9]/g, '').toUpperCase() !== expected.replace(/[^A-Za-z0-9]/g, '').toUpperCase()) {
        const ok = await showConfirm(
          `Every other ${item.name} on this job is ${expected}. This one reads ${model}. Save it anyway?`,
          'Save anyway'
        );
        if (!ok) return 'cancel';
      }

      // 2b. For an appliance whose model varies per unit (the AHU), the value
      //     can't be checked but the format can — a model of the wrong shape
      //     is still a misread.
      if (!expected && model) {
        const modelFormat = modelFormatFor(item.name);
        if (modelFormat && shapeOf(model) !== modelFormat) {
          const ok = await showConfirm(
            `${item.name} models on this job look like ${modelFormat.replace(/A/g, 'X').replace(/9/g, '0')}. This one doesn't match that pattern. Save it anyway?`,
            'Save anyway'
          );
          if (!ok) return 'cancel';
        }
      }

      // 3. Does the serial match the format the other units use? Serials are
      //    unique per unit, so only the SHAPE can be checked — which is
      //    exactly what catches an unrelated number picked off the plate.
      const format = serialFormatFor(item.name);
      if (format && serial && shapeOf(serial) !== format) {
        const example = ((projectProfile.appliances[item.name] || {}).serialShapes || [])[0];
        const ok = await showConfirm(
          `${item.name} serials on this job look like ${format.replace(/A/g, 'X').replace(/9/g, '0')} (${example ? example.count : 'several'} units). This one doesn't match that pattern. Save it anyway?`,
          'Save anyway'
        );
        if (!ok) return 'cancel';
      }

      return 'ok';
    }

    // Finds the label words a value follows in the OCR text, so a correction
    // teaches not just what the value looks like but where on the plate it
    // lives. "ENL-50 120" typed by hand becomes: this appliance's model is
    // shaped AAA-99 999 and follows the words "Model Number".
    function contextFor(value) {
      if (!value || !lastOcrText) return null;
      for (const line of lastOcrText.split('\n')) {
        const at = line.toUpperCase().indexOf(value.toUpperCase());
        if (at > 0) return contextKey(line.slice(Math.max(0, at - 24), at));
      }
      return null;
    }

    function learnFromConfirmation(itemName, field, value, proposedValue) {
      const post = (body) => api('/api/patterns', { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
      const usable = (v) => v && v.length >= 3 && /9/.test(shapeOf(v)) && shapeOf(v).length >= 4;
      const corrected = value && proposedValue && value !== proposedValue;

      if (usable(value)) {
        post({
          itemName, field, shape: shapeOf(value), sample: value,
          contextLabel: contextFor(value),
          // A correction is far stronger evidence than an acceptance: the
          // crew looked at the plate and disagreed with the machine. Weighting
          // it heavily is what makes one typed-in value actually change the
          // next read, instead of being averaged away by passive confirmations.
          weight: corrected ? 5 : 1,
        });
      }

      // What they overwrote is recorded as a thing this field is not. Without
      // this the same wrong candidate keeps winning on the next unit — the
      // "120VAC as a serial" failure would simply repeat.
      if (corrected && usable(proposedValue)) {
        post({ itemName, field, shape: shapeOf(proposedValue), sample: proposedValue, rejected: true, weight: 3 });
      }
    }

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

    // Once the job has settled on a model for this appliance, offer it as a
    // one-tap fill. Shown, never auto-filled: a wrong model silently copied
    // across 296 units would be far worse than typing it.
    function showModelHint() {
      const expected = expectedModelFor(item.name);
      const hint = document.getElementById('modelHint');
      if (!hint || !expected || modelField.value.trim()) { if (hint) hint.hidden = true; return; }
      hint.textContent = `Usually ${expected} — tap to use`;
      hint.hidden = false;
      hint.onclick = () => {
        modelField.value = expected;
        hint.hidden = true;
      };
    }

    // Warm the OCR engine up, and load anything already learned about this
    // appliance's plate format, while the user is framing their shot.
    ensureWorker().catch(() => {});
    loadLearnedShapes(item.name, projectId).then(showModelHint);
  }

  // A small on-screen copy of the captured photo.
  function previewDataUrl(photo) {
    const scale = Math.min(1, 1200 / Math.max(photo.width, photo.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(photo.width * scale);
    canvas.height = Math.round(photo.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  }

  // Rotates a canvas by a quarter turn. Appliance plates are constantly
  // photographed sideways — a dishwasher label reads bottom-to-top on the door
  // edge, a dryer's runs around the drum — and OCR engines only read
  // horizontal text, so a perfectly sharp photo returns nothing at all.
  function rotateCanvas(source, degrees) {
    if (!degrees) return source;
    const swap = degrees === 90 || degrees === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? source.height : source.width;
    canvas.height = swap ? source.width : source.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    return canvas;
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
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve({ blob, width: canvas.width, height: canvas.height }), 'image/jpeg', 0.75);
    });
  }

  async function readLabelViaCloud(source) {
    const { blob, width, height } = await toUploadBlob(source);
    const form = new FormData();
    form.append('image', blob, 'label.jpg');
    const resp = await fetch('/api/ocr', { method: 'POST', body: form });
    if (!resp.ok) throw new Error(`cloud OCR failed (${resp.status})`);
    const data = await resp.json();
    const guess = parseModelSerial(data.text || '', learnedShapes);
    // The raw text is kept so a later hand-typed correction can be located on
    // the plate and its surrounding label words learned.
    guess.sourceText = data.text || '';
    // Keep the word positions (and the size they are relative to) so the app
    // can show which part of the photo each value was read from.
    guess.words = data.words || [];
    guess.sourceWidth = width;
    guess.sourceHeight = height;
    return guess;
  }

  // Finds where a recognised value sits in the photo, as fractions of the
  // image, so a box can be drawn over it at any display size.
  function locateValue(value, words, sw, sh) {
    if (!value || !words || !words.length || !sw || !sh) return null;
    const norm = (t) => (t || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const target = norm(value);
    if (!target) return null;

    const boxOf = (list) => {
      const left = Math.min(...list.map((w) => w.left));
      const top = Math.min(...list.map((w) => w.top));
      const right = Math.max(...list.map((w) => w.left + w.width));
      const bottom = Math.max(...list.map((w) => w.top + w.height));
      return { left: left / sw, top: top / sh, width: (right - left) / sw, height: (bottom - top) / sh };
    };

    // Exact single word.
    for (const w of words) {
      if (norm(w.text) === target) return boxOf([w]);
    }

    // A value split across consecutive words ("ENL-50 120" read as two).
    // Only words on roughly the same line are joined, so the box can't stretch
    // across unrelated parts of the plate.
    for (let i = 0; i < words.length; i++) {
      let joined = norm(words[i].text);
      if (!joined) continue;
      const group = [words[i]];
      for (let j = i + 1; j < words.length && j < i + 4; j++) {
        const sameLine = Math.abs(words[j].top - words[i].top) <= Math.max(words[i].height, 1) * 0.6;
        if (!sameLine) break;
        joined += norm(words[j].text);
        group.push(words[j]);
        if (joined === target) return boxOf(group);
        if (joined.length > target.length) break;
      }
    }

    // Partial match, but only when the word is most of the value. Without
    // this floor a stray "1" on the plate matches a 13-digit serial, and the
    // box lands on unrelated text — which is worse than showing no box,
    // because it looks like a confident answer.
    let best = null;
    for (const w of words) {
      const t = norm(w.text);
      if (!t || t.length < 4) continue;
      const contained = target.includes(t) || t.includes(target);
      if (!contained) continue;
      const overlap = Math.min(t.length, target.length) / Math.max(t.length, target.length);
      if (overlap >= 0.6 && (!best || overlap > best.overlap)) best = { w, overlap };
    }
    return best ? boxOf([best.w]) : null;
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

  // Shapes learned for the appliance currently being scanned.
  let learnedShapes = { model: [], serial: [] };

  // What this job has already confirmed, per appliance.
  let projectProfile = { appliances: {} };

  async function loadProjectProfile(projectId) {
    try {
      projectProfile = await api(`/api/project-profile?projectId=${projectId}`);
    } catch (e) {
      projectProfile = { appliances: {} };
    }
  }

  async function loadLearnedShapes(itemName, projectId) {
    try {
      const data = await api(`/api/patterns?itemName=${encodeURIComponent(itemName)}`);
      learnedShapes = data.patterns || emptyLearned();
    } catch (e) {
      learnedShapes = emptyLearned();
    }

    // Fold in the formats this job has actually confirmed. A serial format
    // seen on two or more units of the same appliance is established fact,
    // not a guess, and it outranks anything inferred from one photo — that is
    // what stops a water heater's serial being read off some unrelated number
    // elsewhere on the plate.
    await loadProjectProfile(projectId);
    const entry = (projectProfile.appliances || {})[itemName];
    if (!entry) return;

    for (const { value: shape, count } of entry.serialShapes || []) {
      if (count >= 2 && learnedShapes.serial.prefer.indexOf(shape) === -1) {
        learnedShapes.serial.prefer.unshift(shape);
      }
    }
    for (const { value: model, count } of entry.models || []) {
      const shape = shapeOf(model);
      if (count >= 2 && learnedShapes.model.prefer.indexOf(shape) === -1) {
        learnedShapes.model.prefer.unshift(shape);
      }
    }
  }

  // The model this appliance carries on every other unit, when the job is
  // consistent about it. Used as a hint, never silently filled in.
  function expectedModelFor(itemName) {
    const entry = (projectProfile.appliances || {})[itemName];
    if (!entry || !entry.models || !entry.models.length) return null;
    const top = entry.models[0];
    const total = entry.models.reduce((sum, m) => sum + m.count, 0);
    // Only claim an expectation when the job agrees with itself.
    return top.count >= 2 && top.count / total >= 0.8 ? top.value : null;
  }

  // Which OTHER appliance a model belongs to, if any. This is what catches a
  // dryer scanned onto the washer.
  function applianceOwningModel(model, exceptItemName) {
    const target = String(model || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (target.length < 4) return null;
    for (const [name, entry] of Object.entries(projectProfile.appliances || {})) {
      if (name === exceptItemName) continue;
      for (const m of entry.models || []) {
        if (m.count >= 2 && m.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase() === target) {
          return { name, count: m.count };
        }
      }
    }
    return null;
  }

  // The format an appliance's model takes, for the ones that vary per unit.
  // An AHU's model is different in every apartment but always the same shape,
  // so the value can't be checked while the shape still can.
  function modelFormatFor(itemName) {
    const entry = (projectProfile.appliances || {})[itemName];
    if (!entry || !entry.models || !entry.models.length) return null;
    const shapes = new Map();
    for (const m of entry.models) shapes.set(shapeOf(m.value), (shapes.get(shapeOf(m.value)) || 0) + m.count);
    const ranked = [...shapes.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((sum, r) => sum + r[1], 0);
    return ranked[0][1] >= 3 && ranked[0][1] / total >= 0.75 ? ranked[0][0] : null;
  }

  // Whether a serial looks like the others recorded for this appliance.
  function serialFormatFor(itemName) {
    const entry = (projectProfile.appliances || {})[itemName];
    if (!entry || !entry.serialShapes || !entry.serialShapes.length) return null;
    const top = entry.serialShapes[0];
    const total = entry.serialShapes.reduce((sum, sh) => sum + sh.count, 0);
    return top.count >= 3 && top.count / total >= 0.75 ? top.value : null;
  }

  async function readLabelFromCanvas(source, onProgress) {
    const guess = { model: '', serial: '' };

    // Cloud first when it's configured: it reads plates that defeat
    // in-browser OCR, and returns in a fraction of the time. Any failure —
    // no signal, quota exhausted, server down — falls through to the
    // on-device passes below, so scanning never hard-stops on site.
    if (await hasCloudOcr()) {
      try {
        // Upright first, then each quarter turn. A sideways plate returns
        // nothing at 0° no matter how sharp the photo is, so the orientation
        // sweep is what turns "couldn't read it" into a clean read — and it
        // only costs extra calls on the labels that actually need it.
        for (const degrees of [0, 90, 180, 270]) {
          if (degrees) onProgress('Label looks sideways — rotating...');
          const cloud = await readLabelViaCloud(rotateCanvas(source, degrees));
          if (!guess.model && cloud.model) {
            guess.model = cloud.model;
            guess.modelBox = null; // boxes are drawn against the upright photo
          }
          if (!guess.serial && cloud.serial) {
            guess.serial = cloud.serial;
            guess.serialBox = null;
          }
          if (!guess.sourceText) guess.sourceText = cloud.sourceText || '';
          if (degrees === 0) {
            guess.modelBox = locateValue(cloud.model, cloud.words, cloud.sourceWidth, cloud.sourceHeight);
            guess.serialBox = locateValue(cloud.serial, cloud.words, cloud.sourceWidth, cloud.sourceHeight);
          }
          if (guess.model && guess.serial) return guess;
        }
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
      const pass = parseModelSerial(data.text || '', learnedShapes);
      if (!guess.sourceText) guess.sourceText = data.text || '';
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
          <button class="primary" id="doneBtn">Next unit &rarr;</button>
        </div>
      </div>
    `;
    document.getElementById('doneBtn').addEventListener('click', () => navigate(floorRouteFor(projectId, unitNumber)));
  }

  // ---------------- Commitments & billing (administrators only) ----------------
  // Subcontracts, their schedules of values, change orders, and the pay
  // applications a sub fills in from a link. Money is displayed here but only
  // ever calculated on the server, so a screen can't disagree with a PDF.

  const money = (value) => {
    const n = Number(value || 0);
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  };
  const pct = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;
  const dateOnly = (value) => (value ? String(value).slice(0, 10) : '');

  async function renderCommitments(projectId) {
    root.innerHTML = `<div class="card"><p class="help">Loading commitments...</p></div>`;
    let data, project;
    try {
      project = (await api(`/api/projects/${projectId}`)).project;
      data = await api(`/api/commitments?projectId=${projectId}`);
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="help">Could not load commitments: ${escapeHtml(e.message)}</p></div>`;
      return;
    }

    const rows = data.commitments.map((c) => {
      const contractSum = Number(c.base_total || 0) + Number(c.co_total || 0);
      return `
        <tr data-id="${c.id}" class="clickable">
          <td><strong>${escapeHtml(c.sub_company)}</strong><div class="sub">${escapeHtml(c.title || '')}</div></td>
          <td>${escapeHtml(c.number || '')}</td>
          <td class="num">${money(c.base_total)}</td>
          <td class="num">${Number(c.co_total) ? money(c.co_total) : '&mdash;'}</td>
          <td class="num"><strong>${money(contractSum)}</strong></td>
          <td class="num">${c.pay_app_count || 0}</td>
        </tr>`;
    }).join('');

    root.innerHTML = `
      <div class="row between">
        <h1 style="margin:0;">Commitments</h1>
        <button class="secondary" id="backBtn">&larr; Tools</button>
      </div>
      <p class="help" style="margin:6px 0 0;">${escapeHtml(project.name)} &middot; subcontracts under Precision Builders</p>

      <div class="card">
        ${data.commitments.length ? `
          <table class="grid">
            <thead><tr><th>Subcontractor</th><th>Number</th><th class="num">Base</th><th class="num">Changes</th><th class="num">Contract sum</th><th class="num">Pay apps</th></tr></thead>
            <tbody id="commitmentRows">${rows}</tbody>
          </table>` : `<p class="help">No commitments yet. Add the first one below.</p>`}
      </div>

      <div class="card">
        <h2 style="margin-top:0;">New commitment</h2>
        <div class="field-grid">
          <label>SUBCONTRACTOR<input type="text" id="cSub" placeholder="Nohemy's Cleaning, LLC" /></label>
          <label>CONTRACT FOR<input type="text" id="cTitle" placeholder="Cleaning" /></label>
          <label>SUBCONTRACT NO.<input type="text" id="cNumber" placeholder="SC-24-03-002" /></label>
          <label>ADDRESS<input type="text" id="cAddr1" placeholder="950 Jackson Avenue" /></label>
          <label>CITY, STATE ZIP<input type="text" id="cAddr2" placeholder="Davenport, Florida 33837" /></label>
          <label>RETAINAGE %<input type="number" id="cRet" value="10" min="0" max="50" step="0.5" /></label>
        </div>
        <div class="row" style="margin-top:12px;">
          <button class="primary" id="addCommitment">Add commitment</button>
        </div>
      </div>
    `;

    document.getElementById('backBtn').addEventListener('click', () => navigate(`/project/${projectId}`));
    (document.getElementById('commitmentRows') || { querySelectorAll: () => [] })
      .querySelectorAll('tr').forEach((tr) => {
        tr.addEventListener('click', () => navigate(`/project/${projectId}/commitment/${tr.dataset.id}`));
      });

    document.getElementById('addCommitment').addEventListener('click', async () => {
      const subCompany = document.getElementById('cSub').value.trim();
      if (!subCompany) { toast('Enter the subcontractor'); return; }
      try {
        const result = await api('/api/commitments', {
          method: 'POST',
          body: JSON.stringify({
            projectId,
            subCompany,
            title: document.getElementById('cTitle').value.trim() || 'Subcontract',
            number: document.getElementById('cNumber').value.trim(),
            subAddress1: document.getElementById('cAddr1').value.trim(),
            subAddress2: document.getElementById('cAddr2').value.trim(),
            retainagePct: Number(document.getElementById('cRet').value || 10) / 100,
          }),
        });
        navigate(`/project/${projectId}/commitment/${result.commitment.id}`);
      } catch (e) {
        toast(`Could not add: ${e.message}`);
      }
    });
  }

  async function renderCommitment(projectId, commitmentId, tab = 'sov') {
    root.innerHTML = `<div class="card"><p class="help">Loading...</p></div>`;
    let data;
    try {
      data = await api(`/api/commitments/${commitmentId}`);
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="help">Could not load: ${escapeHtml(e.message)}</p></div>`;
      return;
    }

    const c = data.commitment;
    const base = data.sovLines.filter((l) => l.source === 'base');
    const cos = data.sovLines.filter((l) => l.source === 'co');
    const baseTotal = base.reduce((s, l) => s + Number(l.scheduled_value), 0);
    const coTotal = cos.reduce((s, l) => s + Number(l.scheduled_value), 0);

    const sovRows = base.map((l) => `
      <tr><td>${escapeHtml(l.item_no || '')}</td><td>${escapeHtml(l.description)}</td>
      <td class="num">${money(l.scheduled_value)}</td></tr>`).join('');

    const coRows = data.changeOrders.map((co) => `
      <tr class="clickable" data-co="${co.id}">
        <td>${escapeHtml(co.number)}</td>
        <td>${escapeHtml(co.title)}<div class="sub">${escapeHtml(co.description || '')}</div></td>
        <td class="num">${money(co.amount)}</td>
        <td><span class="pill ${co.status}">${co.status === 'approved' ? 'APPROVED' : co.status.toUpperCase()}</span></td>
        <td class="num">
          ${co.status === 'approved'
            ? `<button class="secondary small" data-unapprove="${co.id}">Un-approve</button>`
            : `<button class="go-btn small" data-approve="${co.id}">Approve</button>`}
          <button class="secondary small" data-open-co="${co.id}">Open</button>
        </td>
      </tr>`).join('');

    const appRows = data.payApps.map((p) => `
      <tr class="clickable" data-app="${p.id}">
        <td><strong>#${p.number}</strong></td>
        <td>${escapeHtml(dateOnly(p.period_start))} &ndash; ${escapeHtml(dateOnly(p.period_end))}</td>
        <td><span class="pill ${p.status}">${p.status.toUpperCase()}</span></td>
        <td>${p.submitted_at ? new Date(p.submitted_at).toLocaleDateString() : '&mdash;'}</td>
      </tr>`).join('');

    root.innerHTML = `
      <div class="row between">
        <div>
          <h1 style="margin:0;">${escapeHtml(c.sub_company)}</h1>
          <p class="help" style="margin:4px 0 0;">
            ${escapeHtml(c.title)}${c.number ? ` &middot; ${escapeHtml(c.number)}` : ''}
            &middot; ${pct(c.retainage_pct)} retainage
          </p>
        </div>
        <button class="secondary" id="backBtn">&larr; Commitments</button>
      </div>

      <div class="tabs">
        <button class="tab ${tab === 'sov' ? 'on' : ''}" data-tab="sov">Schedule of values</button>
        <button class="tab ${tab === 'changes' ? 'on' : ''}" data-tab="changes">Change orders${data.changeOrders.length ? ` (${data.changeOrders.length})` : ''}</button>
        <button class="tab ${tab === 'invoicing' ? 'on' : ''}" data-tab="invoicing">Invoicing${data.payApps.length ? ` (${data.payApps.length})` : ''}</button>
      </div>

      <div class="stats">
        <div class="stat"><div class="num">${money(baseTotal)}</div><div class="label">Original contract</div></div>
        <div class="stat"><div class="num">${money(coTotal)}</div><div class="label">Approved changes</div></div>
        <div class="stat"><div class="num">${money(baseTotal + coTotal)}</div><div class="label">Contract to date</div></div>
      </div>

      ${tab !== 'sov' ? '' : `
      <div class="card">
        <h2 style="margin-top:0;">Schedule of values</h2>
        ${base.length ? `
          <table class="grid">
            <thead><tr><th>Item no.</th><th>Description</th><th class="num">Scheduled value</th></tr></thead>
            <tbody>${sovRows}</tbody>
            <tfoot><tr><td></td><td><strong>Total</strong></td><td class="num"><strong>${money(baseTotal)}</strong></td></tr></tfoot>
          </table>
          <p class="help" style="margin-top:10px;">${base.length} lines. Once billing has started this can only be changed by change order.</p>
          <button class="secondary" id="replaceSov" style="margin-top:8px;">Replace schedule</button>
        ` : `
          <p class="help">Upload the subcontract's G703 or schedule of values &mdash; any spreadsheet with a description column and a value column. It finds the columns itself; there's no template to match.</p>
          <input type="file" id="sovFile" accept=".xlsx,.xls,.csv" />
          <div id="sovPreview"></div>
          <p class="help" style="margin-top:16px;">Or paste the rows straight from Excel &mdash; item number, description, value.</p>
          <textarea id="sovPaste" rows="8" placeholder="09-990 (S)&#9;BLD 5 - Floor 1 Rough&#9;3221.19"></textarea>
          <div class="row" style="margin-top:10px;">
            <button class="primary" id="saveSov">Save schedule</button>
            <span class="help" id="sovCount"></span>
          </div>
        `}
      </div>

      <div class="card danger-zone">
        <div class="row between">
          <div>
            <strong>Delete this commitment</strong>
            <div class="help">Its schedule of values, change orders and applications go with it. Once an application has been approved it can only be archived.</div>
          </div>
          <button class="danger-quiet" id="deleteCommitment">Delete&hellip;</button>
        </div>
      </div>
      `}

      ${tab !== 'changes' ? '' : `
      <div class="card">
        <h2 style="margin-top:0;">Change orders</h2>
        ${data.changeOrders.length ? `
          <table class="grid">
            <thead><tr><th>Number</th><th>Title</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
            <tbody id="coRows">${coRows}</tbody>
          </table>` : '<p class="help">No change orders yet.</p>'}
        <div class="field-grid" style="margin-top:14px;">
          <label>TITLE<input type="text" id="coTitle" placeholder="Clubhouse 2nd Story Add" /></label>
          <label>AMOUNT<input type="number" id="coAmount" step="0.01" placeholder="2458.28" /></label>
          <label>REASON<input type="text" id="coReason" placeholder="Design Development" /></label>
          <label>LOCATION<input type="text" id="coLocation" placeholder="Clubhouse" /></label>
        </div>
        <label style="display:block;margin-top:10px;">DESCRIPTION
          <textarea id="coDescription" rows="2" placeholder="Additional cost for cleaning the clubhouse 2nd floor..."></textarea>
        </label>
        <div class="row" style="margin-top:10px;"><button class="primary" id="addCo">Add change order</button></div>
      </div>

      `}

      ${tab !== 'invoicing' ? '' : `
      <div class="card">
        <h2 style="margin-top:0;">Pay applications</h2>
        ${data.payApps.length ? `
          <table class="grid">
            <thead><tr><th>App</th><th>Period</th><th>Status</th><th>Submitted</th></tr></thead>
            <tbody id="appRows">${appRows}</tbody>
          </table>` : '<p class="help">No applications yet.</p>'}
        ${base.length ? `
          <div class="field-grid" style="margin-top:14px;">
            <label>PERIOD FROM<input type="date" id="pStart" /></label>
            <label>PERIOD TO<input type="date" id="pEnd" /></label>
            <label>INVOICE NO.<input type="text" id="pInvoice" placeholder="optional" /></label>
          </div>
          <div class="row" style="margin-top:10px; gap:8px;">
            <button class="primary" id="openPeriod">Open billing period</button>
            <button class="secondary" id="backfillPeriod">Record an earlier application</button>
          </div>
          <p class="help" style="margin-top:8px;">Opening a period creates the link you send the sub. Previous completed carries forward from the last approved application.</p>
          <p class="help">Use <em>record an earlier application</em> for billing that happened before this sub was on here &mdash;
            it takes the number you give it and slots in behind the ones already listed.</p>
        ` : '<p class="help">Add the schedule of values before opening a billing period.</p>'}
      </div>
      `}
    `;

    const deleteCommitment = document.getElementById('deleteCommitment');
    if (deleteCommitment) deleteCommitment.addEventListener('click', async () => {
      const typed = await showPrompt(
        `Delete the commitment with ${c.sub_company}? Type the subcontractor's name to confirm.`,
        '', 'Delete commitment');
      if (!typed) return;
      try {
        await api(`/api/commitments/${commitmentId}`, {
          method: 'DELETE',
          body: JSON.stringify({ confirmName: typed }),
        });
        toast('Commitment deleted');
        navigate(`/project/${projectId}/commitments`);
      } catch (e) {
        // Approved applications can't be deleted — offer the honest alternative.
        if (/archive/i.test(e.message)) {
          const archive = await showConfirm(`${e.message}\n\nArchive it now?`, 'Archive');
          if (archive) {
            try {
              await api(`/api/commitments/${commitmentId}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
              toast('Commitment archived');
              navigate(`/project/${projectId}/commitments`);
            } catch (err) { toast(err.message); }
          }
          return;
        }
        toast(e.message);
      }
    });

    root.querySelectorAll('.tab').forEach((button) => {
      button.addEventListener('click', () => {
        const route = button.dataset.tab === 'sov'
          ? `/project/${projectId}/commitment/${commitmentId}`
          : `/project/${projectId}/commitment/${commitmentId}/${button.dataset.tab}`;
        navigate(route);
      });
    });

    document.getElementById('backBtn').addEventListener('click', () => navigate(`/project/${projectId}/commitments`));

    const sovFile = document.getElementById('sovFile');
    if (sovFile) {
      sovFile.addEventListener('change', async () => {
        const file = sovFile.files[0];
        if (!file) return;
        const preview = document.getElementById('sovPreview');
        preview.innerHTML = '<p class="help">Reading the file...</p>';
        const form = new FormData();
        form.append('file', file);
        let found;
        try {
          const token = (function () { try { return localStorage.getItem('scanner-token'); } catch (e) { return null; } })();
          const response = await fetch(`/api/commitments/${commitmentId}/sov/preview`, {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            credentials: 'same-origin',
            body: form,
          });
          found = await response.json();
          if (!response.ok) throw new Error(found.error || 'Could not read that file');
        } catch (e) {
          preview.innerHTML = `<p class="help">${escapeHtml(e.message)}</p>`;
          return;
        }

        const changeOrders = (found.skipped || []).filter((s) => s.reason === 'change order');
        preview.innerHTML = `
          <div class="preview">
            <div class="row between">
              <strong>${found.lines.length} lines &middot; ${money(found.total)}</strong>
              <span class="help">from sheet "${escapeHtml(found.sheetName)}"</span>
            </div>
            ${changeOrders.length ? `<p class="help" style="margin:8px 0 0;">
              ${changeOrders.length} change-order line${changeOrders.length === 1 ? '' : 's'} left out of the base schedule
              (${changeOrders.map((c) => escapeHtml(c.description)).join(', ')}).
              Add ${changeOrders.length === 1 ? 'it' : 'them'} as change orders below so ${changeOrders.length === 1 ? 'it carries its' : 'they carry their'} own approval.
            </p>` : ''}
            <table class="grid" style="margin-top:10px;">
              <thead><tr><th>Item no.</th><th>Description</th><th class="num">Scheduled value</th></tr></thead>
              <tbody>
                ${found.lines.slice(0, 6).map((l) => `<tr><td>${escapeHtml(l.itemNo)}</td><td>${escapeHtml(l.description)}</td><td class="num">${money(l.scheduledValue)}</td></tr>`).join('')}
                ${found.lines.length > 6 ? `<tr><td></td><td class="help">&hellip; and ${found.lines.length - 6} more</td><td class="num help">${escapeHtml(found.lines[found.lines.length - 1].description)}: ${money(found.lines[found.lines.length - 1].scheduledValue)}</td></tr>` : ''}
              </tbody>
            </table>
            <div class="row" style="margin-top:12px;">
              <button class="primary" id="saveImported">Save these ${found.lines.length} lines</button>
            </div>
          </div>`;

        document.getElementById('saveImported').addEventListener('click', async () => {
          try {
            await api(`/api/commitments/${commitmentId}/sov`, { method: 'PUT', body: JSON.stringify({ lines: found.lines }) });
            toast(`Saved ${found.lines.length} lines`);
            renderCommitment(projectId, commitmentId, tab);
          } catch (e) { toast(`Could not save: ${e.message}`); }
        });
      });
    }

    const sovPaste = document.getElementById('sovPaste');
    if (sovPaste) {
      const parseSov = () => sovPaste.value.split('\n').map((line) => {
        const parts = line.split('\t').length > 1 ? line.split('\t') : line.split(/\s{2,}|,(?=\s*[^,]*$)/);
        if (parts.length < 2) return null;
        const scheduledValue = parseFloat(String(parts[parts.length - 1]).replace(/[$,\s]/g, ''));
        if (!isFinite(scheduledValue)) return null;
        const description = parts.length >= 3 ? parts.slice(1, -1).join(' ').trim() : String(parts[0]).trim();
        const itemNo = parts.length >= 3 ? String(parts[0]).trim() : '';
        if (!description) return null;
        return { itemNo, description, scheduledValue };
      }).filter(Boolean);

      sovPaste.addEventListener('input', () => {
        const lines = parseSov();
        const total = lines.reduce((s, l) => s + l.scheduledValue, 0);
        document.getElementById('sovCount').textContent =
          lines.length ? `${lines.length} lines, ${money(total)}` : '';
      });

      document.getElementById('saveSov').addEventListener('click', async () => {
        const lines = parseSov();
        if (!lines.length) { toast('Nothing recognised — three columns: item, description, value'); return; }
        try {
          await api(`/api/commitments/${commitmentId}/sov`, { method: 'PUT', body: JSON.stringify({ lines }) });
          toast(`Saved ${lines.length} lines`);
          renderCommitment(projectId, commitmentId, tab);
        } catch (e) { toast(`Could not save: ${e.message}`); }
      });
    }

    const replaceBtn = document.getElementById('replaceSov');
    if (replaceBtn) {
      replaceBtn.addEventListener('click', async () => {
        const ok = await showConfirm('Replace the whole schedule of values? This only works before any billing has started.', 'Replace');
        if (!ok) return;
        try {
          await api(`/api/commitments/${commitmentId}/sov`, { method: 'PUT', body: JSON.stringify({ lines: [] }) });
          renderCommitment(projectId, commitmentId, tab);
        } catch (e) { toast(e.message); }
      });
    }

    document.getElementById('addCo').addEventListener('click', async () => {
      const title = document.getElementById('coTitle').value.trim();
      if (!title) { toast('Give the change order a title'); return; }
      try {
        const created = await api(`/api/commitments/${commitmentId}/change-orders`, {
          method: 'POST',
          body: JSON.stringify({
            title,
            amount: Number(document.getElementById('coAmount').value || 0),
            reason: document.getElementById('coReason').value.trim(),
            location: document.getElementById('coLocation').value.trim(),
            description: document.getElementById('coDescription').value.trim(),
          }),
        });
        navigate(`/project/${projectId}/commitment/${commitmentId}/co/${created.changeOrder.id}`);
      } catch (e) { toast(`Could not add: ${e.message}`); }
    });

    root.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/change-orders/${btn.dataset.approve}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
          toast('Approved — it now bills as its own line');
          renderCommitment(projectId, commitmentId, tab);
        } catch (e) { toast(e.message); }
      });
    });
    root.querySelectorAll('[data-unapprove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/change-orders/${btn.dataset.unapprove}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending' }) });
          renderCommitment(projectId, commitmentId, tab);
        } catch (e) { toast(e.message); }
      });
    });

    const openBtn = document.getElementById('openPeriod');
    if (openBtn) {
      openBtn.addEventListener('click', async () => {
        try {
          const result = await api(`/api/commitments/${commitmentId}/pay-apps`, {
            method: 'POST',
            body: JSON.stringify({
              periodStart: document.getElementById('pStart').value || null,
              periodEnd: document.getElementById('pEnd').value || null,
              invoiceNo: document.getElementById('pInvoice').value.trim(),
            }),
          });
          navigate(`/project/${projectId}/commitment/${commitmentId}/app/${result.payApp.id}`);
        } catch (e) { toast(e.message); }
      });
    }

    const backfillBtn = document.getElementById('backfillPeriod');
    if (backfillBtn) {
      backfillBtn.addEventListener('click', async () => {
        const typed = await showPrompt(
          'What number was this application? It slots in at that position and everything after it re-reads its figures.',
          '1', 'Record it');
        if (typed === null) return;
        try {
          const result = await api(`/api/commitments/${commitmentId}/pay-apps`, {
            method: 'POST',
            body: JSON.stringify({
              backfill: true,
              number: parseInt(typed, 10),
              periodStart: document.getElementById('pStart').value || null,
              periodEnd: document.getElementById('pEnd').value || null,
              invoiceNo: document.getElementById('pInvoice').value.trim(),
            }),
          });
          navigate(`/project/${projectId}/commitment/${commitmentId}/app/${result.payApp.id}`);
        } catch (e) { toast(e.message); }
      });
    }

    root.querySelectorAll('[data-open-co]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate(`/project/${projectId}/commitment/${commitmentId}/co/${btn.dataset.openCo}`);
      });
    });
    (document.getElementById('coRows') || { querySelectorAll: () => [] })
      .querySelectorAll('tr').forEach((tr) => {
        tr.addEventListener('click', () => navigate(`/project/${projectId}/commitment/${commitmentId}/co/${tr.dataset.co}`));
      });

    (document.getElementById('appRows') || { querySelectorAll: () => [] })
      .querySelectorAll('tr').forEach((tr) => {
        tr.addEventListener('click', () => navigate(`/project/${projectId}/commitment/${commitmentId}/app/${tr.dataset.app}`));
      });
  }

  // One change order: its details, its lines, its backup, and the document.
  async function renderChangeOrder(projectId, commitmentId, changeOrderId) {
    root.innerHTML = `<div class="card"><p class="help">Loading change order...</p></div>`;
    let data, project;
    try {
      data = await api(`/api/change-orders/${changeOrderId}`);
      project = (await api(`/api/projects/${projectId}`)).project;
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="help">Could not load: ${escapeHtml(e.message)}</p></div>`;
      return;
    }

    const co = data.changeOrder;
    const s = data.sums;
    const sovLine = data.sovLine;
    const commitment = data.commitment || {};
    const locked = co.status === 'approved';
    const lines = data.lines.length ? data.lines : [{ budget_code: '', description: '', amount: 0 }];

    const field = (label, id, value, type = 'text', extra = '') =>
      `<label>${label}<input type="${type}" id="${id}" value="${escapeHtml(value === null || value === undefined ? '' : String(value))}" ${locked ? 'disabled' : ''} ${extra} /></label>`;

    root.innerHTML = `
      <div class="row between">
        <div>
          <h1 style="margin:0;">${escapeHtml(co.number)} &middot; ${escapeHtml(co.title)}</h1>
          <p class="help" style="margin:4px 0 0;">
            ${escapeHtml(co.sub_company)} &middot; <span class="pill ${co.status}">${co.status.toUpperCase()}</span>
          </p>
        </div>
        <div class="row" style="gap:8px;">
          <button class="secondary" id="backBtn">&larr; Change orders</button>
          <button class="secondary" id="exportPdf">Export PDF</button>
        </div>
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Details</h2>
        <div class="field-grid">
          ${field('TITLE', 'coTitle', co.title)}
          ${field('CHANGE REASON', 'coReason', co.reason || '')}
          ${field('LOCATION', 'coLocation', co.location || '')}
          ${field('REQUEST RECEIVED FROM', 'coRequestedFrom', co.requested_from || '')}
          ${field('REVIEWED BY', 'coReviewedBy', co.reviewed_by || '')}
          ${field('FINAL REVIEWER', 'coFinalReviewer', co.final_reviewer || '')}
          ${field('DUE DATE', 'coDueDate', dateOnly(co.due_date), 'date')}
          ${field('SCHEDULE IMPACT (DAYS)', 'coScheduleImpact', co.schedule_impact_days || 0, 'number')}
          ${field('ACCOUNTING METHOD', 'coAccountingMethod', co.accounting_method || 'Amount Based')}
          ${field('REVISION', 'coRevision', co.revision || 0, 'number')}
        </div>
        <label style="display:block;margin-top:12px;">DESCRIPTION
          <textarea id="coDescription" rows="3" ${locked ? 'disabled' : ''}>${escapeHtml(co.description || '')}</textarea>
        </label>
        ${locked ? '' : '<div class="row" style="margin-top:12px;"><button class="primary" id="saveDetails">Save details</button></div>'}
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Line items</h2>
        <table class="grid">
          <thead><tr><th>#</th><th>Budget code</th><th>Description</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody id="coLines">
            ${lines.map((l, i) => `
              <tr>
                <td>${i + 1}</td>
                <td><input type="text" class="co-line" data-field="budgetCode" value="${escapeHtml(l.budget_code || '')}" ${locked ? 'disabled' : ''} /></td>
                <td><input type="text" class="co-line wide" data-field="description" value="${escapeHtml(l.description || '')}" ${locked ? 'disabled' : ''} /></td>
                <td class="num"><input type="number" step="0.01" class="co-line cell" data-field="amount" value="${Number(l.amount || 0)}" ${locked ? 'disabled' : ''} /></td>
                <td>${locked ? '' : '<button class="secondary small remove-line">&times;</button>'}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr><td></td><td></td><td><strong>Grand total</strong></td><td class="num"><strong id="coTotal">${money(s.thisChangeOrder)}</strong></td><td></td></tr></tfoot>
        </table>
        ${locked ? '' : `
          <div class="row" style="margin-top:12px; gap:8px;">
            <button class="secondary" id="addLine">Add line</button>
            <button class="primary" id="saveLines">Save lines</button>
          </div>`}
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Attachments</h2>
        <p class="help">The sub's quote, a marked-up drawing, a photo. PDFs and images print behind the change order in the exported document.</p>
        <div id="attachmentList">
          ${data.attachments.length ? data.attachments.map((a) => `
            <div class="row between attachment">
              <a href="/api/attachments/${a.id}" target="_blank" rel="noopener">${escapeHtml(a.filename)}</a>
              <span class="row" style="gap:10px;">
                <span class="help">${Math.max(1, Math.round(a.size_bytes / 1024))} KB</span>
                ${locked ? '' : `<button class="secondary small" data-remove-attachment="${a.id}">Remove</button>`}
              </span>
            </div>`).join('') : '<p class="help">Nothing attached yet.</p>'}
        </div>
        ${locked ? '' : '<input type="file" id="attachFiles" multiple style="margin-top:12px;" />'}
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Contract sums</h2>
        <table class="summary">
          <tr><td>The original (Contract Sum)</td><td class="num">${money(s.originalContractSum)}</td></tr>
          <tr><td>Net change by previously authorized Change Orders</td><td class="num">${money(s.netChangeByPrevious)}</td></tr>
          <tr><td>The contract sum prior to this Change Order was</td><td class="num">${money(s.contractSumPrior)}</td></tr>
          <tr><td>This Change Order</td><td class="num">${money(s.thisChangeOrder)}</td></tr>
          <tr class="due"><td>The new contract sum including this Change Order will be</td><td class="num">${money(s.newContractSum)}</td></tr>
        </table>
        <p class="help" style="margin-top:10px;">Every figure here is a sum of what's already recorded &mdash; none of them can be typed.</p>
        ${!project.address1 || !project.owner_name ? `
          <div class="field-grid" style="margin-top:14px;">
            <label>PROJECT ADDRESS<input type="text" id="projAddr1" value="${escapeHtml(project.address1 || '')}" placeholder="251 Galactic Drive" /></label>
            <label>CITY, STATE ZIP<input type="text" id="projAddr2" value="${escapeHtml(project.address2 || '')}" placeholder="Merritt Island, Florida 32952" /></label>
            <label>PROPERTY OWNER<input type="text" id="projOwner" value="${escapeHtml(project.owner_name || '')}" placeholder="Fortenberry Apartments Venture, LP" /></label>
          </div>
          <div class="row" style="margin-top:10px;"><button class="secondary" id="saveProjectAddress">Save project address</button></div>
          <p class="help">The change order prints the job's address; the conditional waiver names the property owner. Set them once and every document after this has them.</p>
        ` : ''}
        ${locked && sovLine ? `
        <div style="margin-top:18px; padding-top:14px; border-top:1px solid #e6e6e6;">
          <strong style="font-size:13px;">Retainage on this change order</strong>
          <div class="row" style="gap:10px; align-items:flex-end; margin-top:8px;">
            <label style="flex:0 0 130px;">PERCENT
              <input type="number" id="coRetPct" min="0" max="50" step="0.5"
                value="${sovLine.retainage_pct === null || sovLine.retainage_pct === undefined
                  ? Number(commitment.retainage_pct || 0) * 100
                  : Number(sovLine.retainage_pct) * 100}" />
            </label>
            <button class="secondary" id="saveCoRet">Save</button>
          </div>
          <p class="help" style="margin-top:8px;">Normally the contract rate. Set it to 0 where this change order was
            paid out in full without retainage being held &mdash; the applications then show what was really held
            instead of a figure nobody kept.</p>
        </div>` : ''}
        <div class="row between" style="margin-top:16px; gap:8px;">
          <span class="row" style="gap:8px;">
            ${locked
              ? `<button class="secondary" id="unapprove">Un-approve</button>
                 <span class="help">Approved ${co.approved_at ? new Date(co.approved_at).toLocaleDateString() : ''} &mdash; it's in the schedule of values and can be billed.</span>`
              : `<button class="go-btn" id="approve">Approve &mdash; adds it to the schedule of values</button>`}
          </span>
          <button class="danger-quiet" id="deleteCo">Delete change order&hellip;</button>
        </div>
      </div>
    `;

    document.getElementById('backBtn').addEventListener('click', () => navigate(`/project/${projectId}/commitment/${commitmentId}/changes`));
    document.getElementById('exportPdf').addEventListener('click', () => {
      window.open(`/api/change-orders/${changeOrderId}/pdf`, '_blank');
    });

    const collectLines = () => Array.from(document.querySelectorAll('#coLines tr')).map((tr) => {
      const get = (f) => {
        const input = tr.querySelector(`[data-field="${f}"]`);
        return input ? input.value : '';
      };
      return { budgetCode: get('budgetCode'), description: get('description'), amount: Number(get('amount') || 0) };
    }).filter((l) => l.description.trim());

    const retotal = () => {
      const total = collectLines().reduce((sum, l) => sum + Math.round(l.amount * 100), 0) / 100;
      document.getElementById('coTotal').textContent = money(total);
    };
    root.querySelectorAll('.co-line').forEach((input) => input.addEventListener('input', retotal));

    const addLine = document.getElementById('addLine');
    if (addLine) addLine.addEventListener('click', () => {
      const tbody = document.getElementById('coLines');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${tbody.children.length + 1}</td>
        <td><input type="text" class="co-line" data-field="budgetCode" /></td>
        <td><input type="text" class="co-line wide" data-field="description" /></td>
        <td class="num"><input type="number" step="0.01" class="co-line cell" data-field="amount" value="0" /></td>
        <td><button class="secondary small remove-line">&times;</button></td>`;
      tbody.appendChild(tr);
      tr.querySelectorAll('.co-line').forEach((i) => i.addEventListener('input', retotal));
      tr.querySelector('.remove-line').addEventListener('click', () => { tr.remove(); retotal(); });
    });
    root.querySelectorAll('.remove-line').forEach((btn) => {
      btn.addEventListener('click', () => { btn.closest('tr').remove(); retotal(); });
    });

    const saveLines = document.getElementById('saveLines');
    if (saveLines) saveLines.addEventListener('click', async () => {
      try {
        await api(`/api/change-orders/${changeOrderId}/lines`, { method: 'PUT', body: JSON.stringify({ lines: collectLines() }) });
        toast('Lines saved');
        renderChangeOrder(projectId, commitmentId, changeOrderId);
      } catch (e) { toast(e.message); }
    });

    const saveDetails = document.getElementById('saveDetails');
    if (saveDetails) saveDetails.addEventListener('click', async () => {
      const value = (id) => document.getElementById(id).value;
      try {
        await api(`/api/change-orders/${changeOrderId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: value('coTitle'), reason: value('coReason'), location: value('coLocation'),
            requestedFrom: value('coRequestedFrom'), reviewedBy: value('coReviewedBy'),
            finalReviewer: value('coFinalReviewer'), dueDate: value('coDueDate') || null,
            scheduleImpactDays: value('coScheduleImpact'), accountingMethod: value('coAccountingMethod'),
            revision: value('coRevision'), description: value('coDescription'),
          }),
        });
        toast('Saved');
        renderChangeOrder(projectId, commitmentId, changeOrderId);
      } catch (e) { toast(e.message); }
    });

    const attach = document.getElementById('attachFiles');
    if (attach) attach.addEventListener('change', async () => {
      if (!attach.files.length) return;
      const form = new FormData();
      Array.from(attach.files).forEach((f) => form.append('files', f));
      toast('Uploading...');
      try {
        const token = (function () { try { return localStorage.getItem('scanner-token'); } catch (e) { return null; } })();
        const response = await fetch(`/api/change-orders/${changeOrderId}/attachments`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: 'same-origin',
          body: form,
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Upload failed');
        renderChangeOrder(projectId, commitmentId, changeOrderId);
      } catch (e) { toast(e.message); }
    });

    root.querySelectorAll('[data-remove-attachment]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await showConfirm('Remove this attachment?', 'Remove');
        if (!ok) return;
        try {
          await api(`/api/attachments/${btn.dataset.removeAttachment}`, { method: 'DELETE' });
          renderChangeOrder(projectId, commitmentId, changeOrderId);
        } catch (e) { toast(e.message); }
      });
    });

    const saveAddress = document.getElementById('saveProjectAddress');
    if (saveAddress) saveAddress.addEventListener('click', async () => {
      try {
        await api(`/api/projects/${projectId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            address1: document.getElementById('projAddr1').value,
            address2: document.getElementById('projAddr2').value,
            ownerName: document.getElementById('projOwner').value,
          }),
        });
        toast('Saved');
        renderChangeOrder(projectId, commitmentId, changeOrderId);
      } catch (e) { toast(e.message); }
    });

    document.getElementById('pdfApp').addEventListener('click', () => {
      window.open(`/api/pay-apps/${payAppId}/pdf/application`, '_blank');
    });
    document.getElementById('pdfWaiver').addEventListener('click', () => {
      window.open(`/api/pay-apps/${payAppId}/pdf/waiver`, '_blank');
    });

    const approve = document.getElementById('approve');
    if (approve) approve.addEventListener('click', async () => {
      const ok = await showConfirm(
        `Approve ${co.number} for ${money(s.thisChangeOrder)}? It joins the schedule of values and can be billed from the next application.`,
        'Approve');
      if (!ok) return;
      try {
        await api(`/api/change-orders/${changeOrderId}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
        toast('Approved — now in the schedule of values');
        renderChangeOrder(projectId, commitmentId, changeOrderId);
      } catch (e) { toast(e.message); }
    });

    const unapprove = document.getElementById('unapprove');
    if (unapprove) unapprove.addEventListener('click', async () => {
      try {
        await api(`/api/change-orders/${changeOrderId}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending' }) });
        renderChangeOrder(projectId, commitmentId, changeOrderId);
      } catch (e) { toast(e.message); }
    });

    const saveCoRet = document.getElementById('saveCoRet');
    if (saveCoRet) saveCoRet.addEventListener('click', async () => {
      const value = Number(document.getElementById('coRetPct').value);
      if (!Number.isFinite(value) || value < 0 || value > 50) return toast('Enter a percent between 0 and 50');
      try {
        await api(`/api/sov-lines/${sovLine.id}/retainage`, {
          method: 'PATCH',
          body: JSON.stringify({ retainagePct: value / 100 }),
        });
        toast(value === 0 ? 'No retainage held on this change order' : `Retainage set to ${value}%`);
        renderChangeOrder(projectId, commitmentId, changeOrderId);
      } catch (e) { toast(e.message); }
    });

    document.getElementById('deleteCo').addEventListener('click', async () => {
      const ok = await showConfirm(
        `Delete ${co.number} (${money(s.thisChangeOrder)})? Its line items and attachments go with it. This can't be undone.`,
        'Delete');
      if (!ok) return;
      try {
        await api(`/api/change-orders/${changeOrderId}`, { method: 'DELETE' });
        toast('Change order deleted');
        navigate(`/project/${projectId}/commitment/${commitmentId}/changes`);
      } catch (e) { toast(e.message); }
    });
  }

  // The administrator's view of one application: what the sub entered, what
  // you changed, and the summary the cheque is written from.
  async function renderPayApp(projectId, commitmentId, payAppId) {
    root.innerHTML = `<div class="card"><p class="help">Loading application...</p></div>`;
    let view;
    try {
      view = await api(`/api/pay-apps/${payAppId}`);
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="help">Could not load: ${escapeHtml(e.message)}</p></div>`;
      return;
    }

    const p = view.payApp;
    const c = view.commitment;
    const editable = p.status !== 'approved';
    const fullLink = p.token ? `${location.origin}/bill.html?t=${p.token}` : null;

    const lineRow = (l) => `
      <tr>
        <td>${escapeHtml(l.itemNo || '')}</td>
        <td>${escapeHtml(l.description)}${l.edited ? ` <span class="pill edited">EDITED</span>` : ''}</td>
        <td class="num">${money(l.scheduledValue)}</td>
        <td class="num">${money(l.previousCompleted)}</td>
        <td class="num">${editable
          ? `<input class="cell" type="number" step="0.01" value="${l.thisPeriod}" data-line="${l.id}" data-field="thisPeriod" />`
          : money(l.thisPeriod)}</td>
        <td class="num">${editable
          ? `<input class="cell" type="number" step="0.01" value="${l.materialsStored}" data-line="${l.id}" data-field="materialsStored" />`
          : money(l.materialsStored)}</td>
        <td class="num">${money(l.totalCompleted)}</td>
        <td class="num">${pct(l.percent)}</td>
        <td class="num">${money(l.balanceToFinish)}</td>
        <td class="num">${money(l.retainage)}</td>
      </tr>`;

    const block = (rows, label, totals) => rows.length ? `
      <tr class="block-head"><td colspan="10">${label}</td></tr>
      ${rows.map(lineRow).join('')}
      <tr class="block-total">
        <td></td><td><strong>Total</strong></td>
        <td class="num">${money(totals.scheduledValue)}</td>
        <td class="num">${money(totals.previousCompleted)}</td>
        <td class="num">${money(totals.thisPeriod)}</td>
        <td class="num">${money(totals.materialsStored)}</td>
        <td class="num">${money(totals.totalCompleted)}</td>
        <td class="num">${pct(totals.percent)}</td>
        <td class="num">${money(totals.balanceToFinish)}</td>
        <td class="num">${money(totals.retainage)}</td>
      </tr>` : '';

    const s = view.summary;
    root.innerHTML = `
      <div class="row between">
        <div>
          <h1 style="margin:0;">Application #${p.number}</h1>
          <p class="help" style="margin:4px 0 0;">
            ${escapeHtml(c.sub_company)} &middot; ${escapeHtml(dateOnly(p.period_start))} &ndash; ${escapeHtml(dateOnly(p.period_end))}
            &middot; <span class="pill ${p.status}">${p.status.toUpperCase()}</span>
          </p>
        </div>
        <button class="secondary" id="backBtn">&larr; ${escapeHtml(c.sub_company)}</button>
      </div>

      ${fullLink ? `
      <div class="card link-card">
        <div class="row between">
          <div>
            <strong>The sub's billing link</strong>
            <div class="help">Send this to ${escapeHtml(c.sub_company)}. It opens their application and nothing else.</div>
          </div>
          <div class="row" style="gap:8px;">
            <button class="secondary" id="copyLink">Copy link</button>
            <button class="secondary" id="reissueLink">Reissue</button>
          </div>
        </div>
        <code class="link">${escapeHtml(fullLink)}</code>
      </div>` : `<div class="card"><p class="help">This application has no live link. <button class="secondary" id="reissueLink">Create one</button></p></div>`}

      <div class="card scroll-x">
        <table class="grid payapp">
          <thead>
            <tr>
              <th>Item</th><th>Description</th><th class="num">Scheduled</th><th class="num">Previous</th>
              <th class="num">This period</th><th class="num">Stored</th><th class="num">Total</th>
              <th class="num">%</th><th class="num">Balance</th><th class="num">Retainage</th>
            </tr>
          </thead>
          <tbody>
            ${block(view.lines.filter((l) => l.source !== 'co'), 'Contract lines', view.base)}
            ${block(view.lines.filter((l) => l.source === 'co'), 'Change orders', view.changeOrders)}
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Summary</h2>
        <table class="summary">
          <tr><td>1. Original contract sum</td><td class="num">${money(s.originalContractSum)}</td></tr>
          <tr><td>2. Net change by change orders</td><td class="num">${money(s.netChangeByChangeOrders)}</td></tr>
          <tr><td>3. Contract sum to date</td><td class="num">${money(s.contractSumToDate)}</td></tr>
          <tr><td>4. Total completed and stored to date</td><td class="num">${money(s.totalCompletedAndStored)}</td></tr>
          <tr><td>5. Retainage <span class="help">(${(s.effectiveRetainageRate * 100).toFixed(2)}% of completed work${
            Math.abs(s.effectiveRetainageRate - s.contractRetainageRate) > 0.0001
              ? `, contract rate ${(s.contractRetainageRate * 100).toFixed(0)}%` : ''})</span></td><td class="num">${money(s.totalRetainage)}</td></tr>
          <tr><td>6. Total earned less retainage</td><td class="num">${money(s.totalEarnedLessRetainage)}</td></tr>
          <tr><td>7. Less previous certificates${
            Number(s.priorPaymentAdjustment) > 0
              ? `<br><span class="help">${money(s.previousCertificatesFromApplications)} from application ${p.number - 1}, plus ${money(s.priorPaymentAdjustment)}${p.prior_payment_note ? ` ${escapeHtml(p.prior_payment_note)}` : ' paid outside the applications'}</span>`
              : ''}</td><td class="num">${money(s.previousCertificates)}</td></tr>
          <tr class="due"><td>8. Current payment due</td><td class="num">${money(s.currentPaymentDue)}</td></tr>
          <tr><td>9. Balance to finish, including retainage</td><td class="num">${money(s.balanceToFinishIncludingRetainage)}</td></tr>
        </table>
        ${p.signer_name ? `<p class="help" style="margin-top:12px;">Signed ${escapeHtml(p.signer_name)}${p.signer_title ? `, ${escapeHtml(p.signer_title)}` : ''} on ${new Date(p.submitted_at).toLocaleString()}</p>` : ''}
        <div class="row between" style="margin-top:14px; gap:8px;">
          <span class="row" style="gap:8px;">
            ${p.status === 'approved'
              ? `<button class="secondary" id="reopen">Reopen for changes</button>`
              : `<button class="go-btn" id="approve">Approve application</button>`}
          </span>
          <span class="row" style="gap:8px;">
            <button class="secondary" id="pdfApp">Pay application PDF</button>
            <button class="secondary" id="pdfWaiver">Conditional waiver PDF</button>
          </span>
        </div>
      </div>

      ${canManage ? `
      <div class="card">
        <h2 style="margin-top:0;">Numbering &amp; payments made outside</h2>
        <p class="help">Money that already reached ${escapeHtml(c.sub_company)} without going through an application &mdash;
          a change order paid direct, a mobilisation cheque. It comes off line 7 so the next application
          doesn't pay it twice, and it never counts as earned work.</p>
        <div class="row" style="gap:10px; align-items:flex-end; margin-top:10px;">
          <label style="flex:0 0 130px;">Application no.
            <input type="number" min="1" step="1" id="appNumber" value="${p.number}">
          </label>
          <label style="flex:0 0 160px;">Amount
            <input type="number" step="0.01" min="0" id="priorAdj" value="${Number(p.prior_payment_adjustment || 0).toFixed(2)}">
          </label>
          <label style="flex:1;">What it was
            <input type="text" id="priorNote" maxlength="120" placeholder="e.g. CO #02 paid direct, no retainage held"
              value="${escapeHtml(p.prior_payment_note || '')}">
          </label>
          <button class="secondary" id="savePrior">Save</button>
        </div>
        ${p.status !== 'approved' ? `
        <div style="margin-top:16px; padding-top:14px; border-top:1px solid #e6e6e6;">
          <button class="secondary" id="resyncPrev">Re-read previous completed</button>
          <p class="help" style="margin-top:8px;">Use this after recording an earlier application. Work this one counted as
            <em>this period</em> moves into <em>previous</em> where the earlier application already billed it. Totals
            don't change &mdash; only which period they fall in.</p>
        </div>` : ''}
      </div>

      <div class="card danger-zone">
        <div class="row between" style="align-items:center; gap:12px;">
          <div>
            <strong>Delete this application</strong>
            <p class="help" style="margin:4px 0 0;">Only the newest application on a commitment can go, so nothing
              billed on top of it changes behind your back.</p>
          </div>
          <button class="danger-quiet" id="deletePayApp">Delete&hellip;</button>
        </div>
      </div>` : ''}
    `;

    document.getElementById('backBtn').addEventListener('click', () => navigate(`/project/${projectId}/commitment/${commitmentId}`));

    const copyBtn = document.getElementById('copyLink');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(fullLink); toast('Link copied'); }
      catch (e) { toast('Select the link and copy it'); }
    });

    const reissue = document.getElementById('reissueLink');
    if (reissue) reissue.addEventListener('click', async () => {
      const ok = await showConfirm('Issue a new link? The old one stops working immediately.', 'Reissue');
      if (!ok) return;
      try {
        await api(`/api/pay-apps/${payAppId}`, { method: 'PATCH', body: JSON.stringify({ reissueLink: true }) });
        renderPayApp(projectId, commitmentId, payAppId);
      } catch (e) { toast(e.message); }
    });

    root.querySelectorAll('input.cell').forEach((input) => {
      input.addEventListener('change', async () => {
        const body = {};
        body[input.dataset.field] = Number(input.value || 0);
        try {
          await api(`/api/pay-apps/${payAppId}/lines/${input.dataset.line}`, { method: 'PATCH', body: JSON.stringify(body) });
          renderPayApp(projectId, commitmentId, payAppId);
        } catch (e) { toast(e.message); }
      });
    });

    const approve = document.getElementById('approve');
    if (approve) approve.addEventListener('click', async () => {
      const ok = await showConfirm(`Approve application #${p.number} for ${money(s.currentPaymentDue)}? It locks after this.`, 'Approve');
      if (!ok) return;
      try {
        await api(`/api/pay-apps/${payAppId}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
        toast('Approved');
        renderPayApp(projectId, commitmentId, payAppId);
      } catch (e) { toast(e.message); }
    });

    const reopen = document.getElementById('reopen');
    if (reopen) reopen.addEventListener('click', async () => {
      try {
        await api(`/api/pay-apps/${payAppId}`, { method: 'PATCH', body: JSON.stringify({ status: 'open' }) });
        renderPayApp(projectId, commitmentId, payAppId);
      } catch (e) { toast(e.message); }
    });

    const savePrior = document.getElementById('savePrior');
    if (savePrior) savePrior.addEventListener('click', async () => {
      try {
        await api(`/api/pay-apps/${payAppId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            number: parseInt(document.getElementById('appNumber').value, 10),
            priorPaymentAdjustment: Number(document.getElementById('priorAdj').value || 0),
            priorPaymentNote: document.getElementById('priorNote').value,
          }),
        });
        toast('Saved');
        renderPayApp(projectId, commitmentId, payAppId);
      } catch (e) { toast(e.message); }
    });

    const resync = document.getElementById('resyncPrev');
    if (resync) resync.addEventListener('click', async () => {
      try {
        const result = await api(`/api/pay-apps/${payAppId}/resync-previous`, { method: 'POST' });
        toast(result.linesChanged
          ? `${result.linesChanged} line${result.linesChanged === 1 ? '' : 's'} moved into previous`
          : 'Already in step with the application before it');
        renderPayApp(projectId, commitmentId, payAppId);
      } catch (e) { toast(e.message); }
    });

    const deletePayApp = document.getElementById('deletePayApp');
    if (deletePayApp) deletePayApp.addEventListener('click', async () => {
      const approved = p.status === 'approved';
      let body = {};
      if (approved) {
        const typed = await showPrompt(
          `Application #${p.number} was approved for ${money(s.currentPaymentDue)}. Type ${p.number} to confirm.`,
          '', 'Delete application');
        if (typed === null) return;
        body = { confirmNumber: typed.trim() };
      } else {
        const ok = await showConfirm(`Delete application #${p.number}? This can't be undone.`, 'Delete');
        if (!ok) return;
      }
      try {
        await api(`/api/pay-apps/${payAppId}`, { method: 'DELETE', body: JSON.stringify(body) });
        toast('Application deleted');
        navigate(`/project/${projectId}/commitment/${commitmentId}`);
      } catch (e) { toast(e.message); }
    });
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Who's using this, before anything renders — the buttons a field-team
  // account never gets should never flash up in the first place.
  fetch('/api/auth/status', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((status) => {
      currentUser = status.user || null;
      // Offline or before sign-in is switched on, nothing changes.
      canManage = !currentUser || currentUser.role === 'admin';
    })
    .catch(() => {})
    .then(() => route());
})();
