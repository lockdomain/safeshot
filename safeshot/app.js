// SafeShot app. OCR runs in a Web Worker (Tesseract.js, WebAssembly). Nothing is uploaded.
(() => {
  const $ = (id) => document.getElementById(id);
  const { CATS, detect } = window.SafeShotDetect;
  const view = $('view');
  const ctx = view.getContext('2d');
  const TESS = {
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
    langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
  };

  const st = { img: null, hits: [], catOff: new Set(), style: 'blur', scanning: false };

  // ---------- input ----------
  const drop = $('drop');
  $('file').onchange = (e) => e.target.files[0] && openFile(e.target.files[0]);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (f) openFile(f);
  });
  window.addEventListener('paste', (e) => {
    const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (it) openFile(it.getAsFile());
  });
  $('sample').onclick = (e) => { e.preventDefault(); e.stopPropagation(); openUrl('sample.png'); };
  $('reset').onclick = () => { $('editor').hidden = true; drop.hidden = false; st.img = null; st.hits = []; };

  function openFile(f) { openUrl(URL.createObjectURL(f)); }
  function openUrl(url) {
    const img = new Image();
    img.onload = () => start(img);
    img.src = url;
  }

  async function start(img) {
    st.img = img; st.hits = []; st.catOff.clear();
    view.width = img.naturalWidth; view.height = img.naturalHeight;
    drop.hidden = true; $('editor').hidden = false;
    $('progress').classList.remove('done');
    $('found').textContent = 'Scanning…';
    $('cats').innerHTML = '';
    render();
    try {
      const lines = await ocr(img);
      st.hits = detect(lines).map((h) => ({ ...h, on: true }));
    } catch (err) {
      console.error(err);
      $('found').textContent = 'Could not read text. You can still drag to hide areas.';
    }
    $('progress').classList.add('done');
    updateSide();
    render();
  }

  // Upscale small screenshots before OCR: Tesseract reads tiny UI text much better at 2x.
  async function ocr(img) {
    const scale = img.naturalWidth < 1800 ? 2 : 1;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth * scale; c.height = img.naturalHeight * scale;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    const res = await Tesseract.recognize(c, 'eng', {
      ...TESS,
      logger: (m) => {
        if (m.status === 'recognizing text') {
          $('bar').style.width = Math.round(m.progress * 100) + '%';
          $('ptext').textContent = `Reading text… ${Math.round(m.progress * 100)}%`;
        } else {
          $('ptext').textContent = m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…';
        }
      },
    });
    const lines = (res.data.lines || []).map((l) => ({
      words: l.words.map((w) => ({
        text: w.text,
        bbox: { x0: w.bbox.x0 / scale, y0: w.bbox.y0 / scale, x1: w.bbox.x1 / scale, y1: w.bbox.y1 / scale },
      })),
    }));
    return lines;
  }

  // ---------- side panel ----------
  function updateSide() {
    const active = st.hits.filter((h) => h.cat !== 'manual');
    const n = active.length;
    $('found').innerHTML = n
      ? `Found <b>${n}</b> thing${n === 1 ? '' : 's'} to hide`
      : 'Nothing sensitive found. Drag to hide areas yourself.';
    const counts = {};
    active.forEach((h) => (counts[h.cat] = (counts[h.cat] || 0) + 1));
    $('cats').innerHTML = '';
    Object.keys(CATS).filter((k) => counts[k]).forEach((k) => {
      const row = document.createElement('label');
      row.className = 'cat';
      row.innerHTML = `<span><input type="checkbox" ${st.catOff.has(k) ? '' : 'checked'}>${CATS[k]}</span><span class="n">${counts[k]}</span>`;
      row.querySelector('input').onchange = (e) => {
        if (e.target.checked) st.catOff.delete(k); else st.catOff.add(k);
        render();
      };
      $('cats').appendChild(row);
    });
  }
  $('style').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      st.style = b.dataset.s;
      $('style').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      render();
    };
  });

  // ---------- rendering ----------
  const isOn = (h) => h.on && !st.catOff.has(h.cat);
  function pad(b) {
    const p = Math.max(3, (b.y1 - b.y0) * 0.18);
    return { x: Math.max(0, b.x0 - p), y: Math.max(0, b.y0 - p), w: b.x1 - b.x0 + p * 2, h: b.y1 - b.y0 + p * 2 };
  }
  function hide(g, img, r) {
    if (st.style === 'bar') {
      g.fillStyle = '#111';
      g.beginPath(); g.roundRect(r.x, r.y, r.w, r.h, Math.min(6, r.h / 3)); g.fill();
      return;
    }
    if (st.style === 'pixel') {
      const s = Math.max(4, Math.round(r.h / 4));
      const tw = Math.max(1, Math.round(r.w / s)), th = Math.max(1, Math.round(r.h / s));
      const t = document.createElement('canvas');
      t.width = tw; t.height = th;
      t.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, tw, th);
      g.save(); g.imageSmoothingEnabled = false;
      g.drawImage(t, 0, 0, tw, th, r.x, r.y, r.w, r.h);
      g.restore();
      return;
    }
    // blur: draw a padded crop with a blur filter, clipped to the box
    g.save();
    g.beginPath(); g.roundRect(r.x, r.y, r.w, r.h, Math.min(6, r.h / 3)); g.clip();
    g.filter = `blur(${Math.max(6, r.h / 2.2)}px)`;
    const e = 30;
    g.drawImage(img, r.x - e, r.y - e, r.w + e * 2, r.h + e * 2, r.x - e, r.y - e, r.w + e * 2, r.h + e * 2);
    g.filter = 'none';
    g.fillStyle = 'rgba(128,128,128,.18)';
    g.fillRect(r.x, r.y, r.w, r.h);
    g.restore();
  }
  function paint(g, outlines) {
    g.drawImage(st.img, 0, 0);
    st.hits.forEach((h) => { if (isOn(h)) hide(g, st.img, pad(h.bbox)); });
    if (!outlines) return;
    const lw = Math.max(2, st.img.naturalWidth / 600);
    st.hits.forEach((h) => {
      const r = pad(h.bbox);
      g.save();
      g.lineWidth = lw;
      g.setLineDash(isOn(h) ? [] : [lw * 3, lw * 2]);
      g.strokeStyle = isOn(h) ? '#f59e0b' : 'rgba(160,160,170,.9)';
      g.beginPath(); g.roundRect(r.x, r.y, r.w, r.h, Math.min(6, r.h / 3)); g.stroke();
      g.restore();
    });
  }
  function render() { if (st.img) paint(ctx, true); }
  function exportCanvas() {
    const c = document.createElement('canvas');
    c.width = st.img.naturalWidth; c.height = st.img.naturalHeight;
    paint(c.getContext('2d'), false);
    return c;
  }

  // ---------- click to toggle, drag to add ----------
  let down = null;
  const toImg = (e) => {
    const r = view.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * view.width, y: ((e.clientY - r.top) / r.height) * view.height };
  };
  view.addEventListener('mousedown', (e) => { down = toImg(e); });
  view.addEventListener('mouseup', (e) => {
    if (!down || !st.img) return;
    const up = toImg(e);
    const dist = Math.hypot(up.x - down.x, up.y - down.y);
    if (dist < 6) {
      const hit = st.hits.find((h) => { const r = pad(h.bbox); return up.x >= r.x && up.x <= r.x + r.w && up.y >= r.y && up.y <= r.y + r.h; });
      if (hit) { hit.on = !hit.on; render(); }
    } else {
      st.hits.push({
        cat: 'manual', on: true, text: '',
        bbox: { x0: Math.min(down.x, up.x), y0: Math.min(down.y, up.y), x1: Math.max(down.x, up.x), y1: Math.max(down.y, up.y) },
      });
      render();
    }
    down = null;
  });

  // ---------- export ----------
  $('download').onclick = () => {
    const a = document.createElement('a');
    a.download = 'safeshot.png';
    a.href = exportCanvas().toDataURL('image/png');
    a.click();
  };
  $('copy').onclick = () => {
    exportCanvas().toBlob(async (blob) => {
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); $('copy').textContent = 'Copied'; }
      catch { $('copy').textContent = 'Not supported'; }
      setTimeout(() => ($('copy').textContent = 'Copy'), 1500);
    });
  };
})();
