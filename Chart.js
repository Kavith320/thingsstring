// GET /view/:deviceId → simple chart page (no external frontend)
app.get('/view/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>ThingString · ${deviceId}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { --fg:#222; --muted:#777; }
    body { font-family: system-ui, Arial, sans-serif; color:var(--fg); margin: 20px; }
    .wrap { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 18px; margin: 0 0 12px; }
    .controls { margin: 12px 0; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    input, button, select { padding: 6px 10px; }
    canvas { width: 100%; height: 460px; }
    .muted { color: var(--muted); font-size:12px; }
    table { border-collapse: collapse; margin-top: 14px; width: 100%; font-size: 12px;}
    th,td { border:1px solid #e6e6e6; padding:6px 8px; text-align:left; white-space:nowrap; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Device: ${deviceId}</h1>

    <div class="controls">
      <label>Show fields:
        <select id="fields" multiple size="4" style="min-width:180px"></select>
      </label>
      <label>Max points <input id="limit" type="number" min="10" max="10000" value="500" style="width:90px"></label>
      <button id="reload">Reload</button>
      <button id="exportCsv">Export CSV</button>
      <span id="msg" class="muted"></span>
    </div>

    <canvas id="chart"></canvas>

    <details>
      <summary>Raw latest rows</summary>
      <div id="tableWrap"></div>
    </details>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script>
    const deviceId = ${JSON.stringify(deviceId)};
    const chartCtx = document.getElementById('chart').getContext('2d');
    const msg = document.getElementById('msg');
    const fieldsSel = document.getElementById('fields');
    const limitEl = document.getElementById('limit');
    const tableWrap = document.getElementById('tableWrap');
    let chart;

    function buildChart(labels, datasets) {
      if (chart) chart.destroy();
      chart = new Chart(chartCtx, {
        type: 'line',
        data: { labels, datasets },
        options: {
          animation: false,
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { title: { text: 'Time', display: true } },
            y: { title: { text: 'Value', display: true } }
          }
        }
      });
    }

    function detectFields(rows) {
      // gather all keys under data.* except obvious non-numerics
      const set = new Set();
      for (const r of rows) {
        const d = r.data || {};
        for (const k of Object.keys(d)) {
          if (['ts','deviceId','userId'].includes(k)) continue;
          // prefer numeric fields
          if (typeof d[k] === 'number') set.add(k);
        }
      }
      return Array.from(set);
    }

    function fillFieldsSelect(keys) {
      fieldsSel.innerHTML = '';
      for (const k of keys.sort()) {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = k;
        // preselect temp/humidity if present
        if (['temp','temperature','humidity','rh'].includes(k)) opt.selected = true;
        fieldsSel.appendChild(opt);
      }
      if (!fieldsSel.selectedOptions.length && keys[0]) {
        fieldsSel.options[0].selected = true;
      }
    }

    function toRowsFromMap(doc) {
      // doc.data is { isoTs: { ... } }
      if (!doc || !doc.data) return [];
      const rows = Object.entries(doc.data).map(([ts, data]) => ({ ts, data }));
      rows.sort((a,b) => a.ts.localeCompare(b.ts)); // oldest → newest
      return rows;
    }

    function renderTable(rows, keys) {
      const head = ['ts', ...keys];
      let html = '<table><thead><tr>' + head.map(h=>'<th>'+h+'</th>').join('') + '</tr></thead><tbody>';
      for (const r of rows.slice(-50)) { // show last 50 rows
        html += '<tr><td>'+new Date(r.ts).toLocaleString()+'</td>' + keys.map(k => '<td>'+ (r.data?.[k] ?? '') +'</td>').join('') + '</tr>';
      }
      html += '</tbody></table>';
      tableWrap.innerHTML = html;
    }

    function exportCSV(rows, keys) {
      const head = ['ts', ...keys];
      const lines = [head.join(',')];
      for (const r of rows) {
        const row = [new Date(r.ts).toISOString(), ...keys.map(k => r.data?.[k] ?? '')];
        lines.push(row.join(','));
      }
      const blob = new Blob([lines.join('\\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = deviceId + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }

    async function loadAndRender() {
      msg.textContent = 'Loading...';
      const limit = parseInt(limitEl.value || '500', 10);

      // fetch entire device doc
      const res = await fetch('/api/device/' + encodeURIComponent(deviceId));
      if (!res.ok) {
        msg.textContent = 'Error: ' + (await res.text());
        return;
      }
      const doc = await res.json();
      let rows = toRowsFromMap(doc);
      if (rows.length > limit) rows = rows.slice(-limit);

      // detect fields, build selection UI once
      if (!fieldsSel.options.length) fillFieldsSelect(detectFields(rows));
      const selectedKeys = Array.from(fieldsSel.selectedOptions).map(o => o.value);

      // labels
      const labels = rows.map(r => new Date(r.ts).toLocaleString());

      // datasets (Chart.js gives colors automatically)
      const datasets = selectedKeys.map((k) => ({
        label: k,
        data: rows.map(r => (typeof r.data?.[k] === 'number' ? r.data[k] : null)),
        spanGaps: true
      }));

      buildChart(labels, datasets);
      renderTable(rows, selectedKeys);

      const last = rows[rows.length-1];
      msg.textContent = 'Points: ' + rows.length + (last ? ' · Last: ' + new Date(last.ts).toLocaleString() : '');
    }

    document.getElementById('reload').addEventListener('click', loadAndRender);
    document.getElementById('exportCsv').addEventListener('click', async () => {
      const res = await fetch('/api/device/' + encodeURIComponent(deviceId));
      const doc = await res.json();
      const rows = toRowsFromMap(doc);
      const keys = Array.from(fieldsSel.selectedOptions).map(o => o.value);
      exportCSV(rows, keys.length ? keys : detectFields(rows));
    });

    // load on open
    loadAndRender();
  </script>
</body>
</html>`);
});
