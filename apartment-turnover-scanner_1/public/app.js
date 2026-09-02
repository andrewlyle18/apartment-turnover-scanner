(() => {
  const root = document.getElementById('view-root');
  const scannedByInput = document.getElementById('scannedByInput');

  scannedByInput.value = localStorage.getItem('scannedBy') || '';
  scannedByInput.addEventListener('change', () => {
    localStorage.setItem('scannedBy', scannedByInput.value.trim());
  });

  function scannedBy() {
    return scannedByInput.value.trim() || 'Unknown';
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
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
  let state = { units: [], hasProject: false };
  let pollTimer = null;

  async function loadUnits() {
    const data = await api('/api/units');
    state.units = data.units;
    state.hasProject = data.hasProject;
    return data;
  }

  function startPolling(renderFn) {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        await loadUnits();
        renderFn();
      } catch (e) { /* ignore transient poll errors */ }
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
    try {
      await loadUnits();
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="help">Could not reach the server: ${e.message}</p></div>`;
      return;
    }

    if (!state.hasProject) {
      renderImport();
      return;
    }

    if (!hash || hash === '/') {
      renderDashboard();
      return;
    }

    const unitMatch = hash.match(/^\/unit\/(\d+)$/);
    if (unitMatch) {
      const unit = state.units.find((u) => String(u.id) === unitMatch[1]);
      if (!unit) { navigate(''); return; }
      renderUnit(unit);
      return;
    }

    const scanMatch = hash.match(/^\/unit\/(\d+)\/scan\/(\d+)$/);
    if (scanMatch) {
      const unit = state.units.find((u) => String(u.id) === scanMatch[1]);
      if (!unit) { navigate(''); return; }
      const itemIndex = parseInt(scanMatch[2], 10);
      renderScan(unit, itemIndex);
      return;
    }

    navigate('');
  }

  // ---------------- Import view ----------------
  function renderImport() {
    root.innerHTML = `
      <div class="card">
        <h1>Load your unit list</h1>
        <p class="help">
          Upload an Excel (.xlsx) or CSV file. Column A should have the unit number
          (e.g. 101, 102, 214) and the columns after it should list the appliances
          in that unit &mdash; e.g. Refrigerator, Range, Microwave, Dishwasher, Disposal,
          Washer, Dryer, Water Heater, Air Handler. Every unit can have a different
          list. A header row is optional.
        </p>
        <input type="file" id="importFile" accept=".xlsx,.xls,.csv" />
        <div class="row" style="margin-top:12px;">
          <button class="primary" id="importBtn">Import</button>
        </div>
        <div id="importMsg" style="margin-top:10px;"></div>
      </div>
    `;
    document.getElementById('importBtn').addEventListener('click', async () => {
      const fileInput = document.getElementById('importFile');
      const msg = document.getElementById('importMsg');
      if (!fileInput.files.length) { msg.textContent = 'Choose a file first.'; return; }
      msg.textContent = 'Importing...';
      const formData = new FormData();
      formData.append('file', fileInput.files[0]);
      try {
        const resp = await fetch('/api/import', { method: 'POST', body: formData });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Import failed');
        toast(`Imported ${data.unitsImported} units`);
        navigate('');
        route();
      } catch (e) {
        msg.textContent = e.message;
      }
    });
  }

  // ---------------- Dashboard ----------------
  function renderDashboard() {
    const totalUnits = state.units.length;
    const completeUnits = state.units.filter((u) => u.complete).length;
    const totalItems = state.units.reduce((s, u) => s + u.totalItems, 0);
    const doneItems = state.units.reduce((s, u) => s + u.doneItems, 0);

    root.innerHTML = `
      <div class="row between">
        <h1>Units</h1>
        <div class="row">
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
        <div class="unit-grid" id="unitGrid"></div>
      </div>
      <div class="card">
        <h2>Export</h2>
        <div class="row">
          <a href="/api/export.xlsx"><button class="primary">Download Excel</button></a>
          <a href="/api/export.csv"><button class="secondary">Download CSV</button></a>
        </div>
      </div>
    `;

    function renderGrid(filter) {
      const grid = document.getElementById('unitGrid');
      const f = (filter || '').trim().toLowerCase();
      const units = state.units.filter((u) => !f || u.unitNumber.toLowerCase().includes(f));
      grid.innerHTML = units.map((u) => `
        <button class="unit-tile ${u.complete ? 'complete' : (u.inProgress ? 'inprogress' : '')}" data-id="${u.id}">
          ${u.complete ? '<div class="check">&#10003;</div>' : ''}
          <div class="unit-num">${escapeHtml(u.unitNumber)}</div>
          <div class="unit-progress">${u.doneItems}/${u.totalItems}</div>
        </button>
      `).join('') || '<p class="help">No units match.</p>';

      grid.querySelectorAll('.unit-tile').forEach((el) => {
        el.addEventListener('click', () => navigate(`/unit/${el.dataset.id}`));
      });
    }

    renderGrid('');
    document.getElementById('searchBox').addEventListener('input', (e) => renderGrid(e.target.value));
    document.getElementById('reimportBtn').addEventListener('click', () => {
      if (confirm('This replaces the current unit list and all progress. Continue?')) {
        state.hasProject = false;
        renderImport();
      }
    });

    startPolling(() => {
      // Re-render grid preserving current search text.
      const searchBox = document.getElementById('searchBox');
      const currentFilter = searchBox ? searchBox.value : '';
      const totalUnits2 = state.units.length;
      const completeUnits2 = state.units.filter((u) => u.complete).length;
      const totalItems2 = state.units.reduce((s, u) => s + u.totalItems, 0);
      const doneItems2 = state.units.reduce((s, u) => s + u.doneItems, 0);
      const statsEls = document.querySelectorAll('.stat .num');
      if (statsEls[0]) statsEls[0].textContent = `${completeUnits2}/${totalUnits2}`;
      if (statsEls[1]) statsEls[1].textContent = `${doneItems2}/${totalItems2}`;
      renderGrid(currentFilter);
    });
  }

  // ---------------- Unit detail ----------------
  function renderUnit(unit) {
    root.innerHTML = `
      <div class="row between">
        <h1>Unit ${escapeHtml(unit.unitNumber)}</h1>
        <button class="secondary" id="backBtn">&larr; All units</button>
      </div>
      <div class="card">
        <div class="row between" style="margin-bottom:10px;">
          <div>${unit.doneItems}/${unit.totalItems} scanned</div>
          <button class="primary" id="startScanBtn" ${unit.totalItems === 0 ? 'disabled' : ''}>
            ${unit.complete ? 'Re-scan / review' : 'Start scanning'}
          </button>
        </div>
        <div id="itemList"></div>
      </div>
      ${unit.complete ? `<div class="card big-check"><div class="mark">&#10003;</div><div>Unit ${escapeHtml(unit.unitNumber)} complete</div></div>` : ''}
    `;

    document.getElementById('backBtn').addEventListener('click', () => navigate(''));

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
      el.addEventListener('click', () => navigate(`/unit/${unit.id}/scan/${el.dataset.idx}`));
    });

    document.getElementById('startScanBtn').addEventListener('click', () => {
      const firstPending = unit.items.findIndex((i) => i.status !== 'done');
      navigate(`/unit/${unit.id}/scan/${firstPending === -1 ? 0 : firstPending}`);
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

  function renderScan(unit, itemIndex) {
    const items = unit.items;
    if (itemIndex >= items.length) {
      renderUnitCompleteScreen(unit);
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
            <div class="progress">Item ${itemIndex + 1} of ${items.length} &middot; Unit ${escapeHtml(unit.unitNumber)}</div>
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
      navigate(`/unit/${unit.id}`);
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
      navigate(`/unit/${unit.id}/scan/${itemIndex + 1}`);
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

  function renderUnitCompleteScreen(unit) {
    root.innerHTML = `
      <div class="card big-check">
        <div class="mark">&#10003;</div>
        <div>Unit ${escapeHtml(unit.unitNumber)} complete</div>
        <div class="row" style="justify-content:center;margin-top:14px;">
          <button class="primary" id="doneBtn">Back to all units</button>
        </div>
      </div>
    `;
    document.getElementById('doneBtn').addEventListener('click', () => navigate(''));
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  route();
})();
