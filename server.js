import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectMongo } from './db.js';
import Telemetry from './models/Telemetry.js'; // single-doc-per-device model
import { startMqtt } from './mqtt.js';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

/**
 * Fetch the single document for a device (raw map)
 * GET /api/device/:deviceId
 */
app.get('/api/device/:deviceId', async (req, res) => {
  try {
    const doc = await Telemetry.findOne({ deviceId: req.params.deviceId }).lean();
    if (!doc) return res.status(404).json({ error: 'Device not found' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Flatten the map → rows for charts/tables
 * GET /api/device/:deviceId/rows?limit=500
 * returns: [{ ts, ...dataFields }]
 */
app.get('/api/device/:deviceId/rows', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const limit = Math.min(parseInt(req.query.limit || '500', 10), 5000);

    const doc = await Telemetry.findOne({ deviceId }).lean();
    if (!doc || !doc.data) return res.json([]);

    // Convert { data: { "isoTs": {...} } } -> [{ ts, ... }]
    let rows = Object.entries(doc.data).map(([ts, data]) => ({ ts, ...(data || {}) }));
    rows.sort((a, b) => a.ts.localeCompare(b.ts)); // oldest → newest
    if (rows.length > limit) rows = rows.slice(-limit);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Simple Chart.js viewer
 * GET /view/:deviceId
 */
app.get('/view/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>ThingString | ${deviceId}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: system-ui, Arial, sans-serif; margin: 30px; background:#fafafa; color:#222; }
    .wrap { max-width: 1000px; margin: auto; }
    h1 { font-size: 22px; }
    .controls { margin-bottom: 15px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    button, input, select { padding: 6px 10px; font-size:14px; }
    canvas { width: 100%; height: 420px; background:white; border:1px solid #ddd; border-radius:8px; }
    .info { margin-top:10px; font-size:13px; color:#555; }
    table { border-collapse:collapse; width:100%; margin-top:12px; font-size:12px; }
    th, td { border:1px solid #ddd; padding:4px 6px; text-align:left; white-space:nowrap; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Device: ${deviceId}</h1>

    <div class="controls">
      <label>Max Points <input id="limit" type="number" min="10" max="10000" value="500"></label>
      <label>Fields
        <select id="fields" multiple size="4" style="min-width:180px"></select>
      </label>
      <button id="reload">Reload</button>
      <button id="export">Export CSV</button>
      <span id="status" class="info"></span>
    </div>

    <canvas id="chart"></canvas>
    <details>
      <summary>Latest Data (Table)</summary>
      <div id="table"></div>
    </details>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script>
    const deviceId = ${JSON.stringify(deviceId)};
    const chartCtx = document.getElementById('chart').getContext('2d');
    const limitEl = document.getElementById('limit');
    const fieldsSel = document.getElementById('fields');
    const statusEl = document.getElementById('status');
    const tableEl = document.getElementById('table');
    let chart;

    function buildChart(labels, datasets) {
      if (chart) chart.destroy();
      chart = new Chart(chartCtx, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive:true,
          interaction:{ mode:'index', intersect:false },
          scales:{ x:{ title:{ display:true, text:'Time' } },
                   y:{ title:{ display:true, text:'Value' } } }
        }
      });
    }

    function renderTable(rows, keys) {
      const head = '<tr><th>Timestamp</th>' + keys.map(k=>'<th>'+k+'</th>').join('') + '</tr>';
      const body = rows.slice(-50).map(r =>
        '<tr><td>'+new Date(r.ts).toLocaleString()+'</td>' +
        keys.map(k=>'<td>'+ (r[k]??'') +'</td>').join('') + '</tr>'
      ).join('');
      tableEl.innerHTML = '<table>'+head+body+'</table>';
    }

    function detectNumericKeys(rows) {
      const last = rows[rows.length-1] || {};
      return Object.keys(last).filter(k => k !== 'ts' && typeof last[k] === 'number');
    }

    function fillFieldSelect(keys) {
      fieldsSel.innerHTML = '';
      for (const k of keys.sort()) {
        const opt = document.createElement('option');
        opt.value = k; opt.textContent = k;
        if (['temp','temperature','humidity','rh'].includes(k)) opt.selected = true;
        fieldsSel.appendChild(opt);
      }
      if (!fieldsSel.selectedOptions.length && keys[0]) fieldsSel.options[0].selected = true;
    }

    async function load() {
      statusEl.textContent = 'Loading...';
      const limit = parseInt(limitEl.value || '500', 10);
      const res = await fetch('/api/device/' + encodeURIComponent(deviceId) + '/rows?limit=' + limit);
      const rows = await res.json();

      if (!fieldsSel.options.length) fillFieldSelect(detectNumericKeys(rows));
      const selected = Array.from(fieldsSel.selectedOptions).map(o => o.value);

      const labels = rows.map(r => new Date(r.ts).toLocaleString());
      const datasets = selected.map(k => ({
        label: k,
        data: rows.map(r => typeof r[k] === 'number' ? r[k] : null),
        spanGaps: true,
        borderWidth: 2
      }));

      buildChart(labels, datasets);
      renderTable(rows, selected);

      const last = rows.at(-1);
      statusEl.textContent = 'Points: ' + rows.length + (last ? ' · Last: ' + new Date(last.ts).toLocaleString() : '');
    }

    document.getElementById('reload').addEventListener('click', load);
    document.getElementById('export').addEventListener('click', async () => {
      const limit = parseInt(limitEl.value || '500', 10);
      const res = await fetch('/api/device/' + encodeURIComponent(deviceId) + '/rows?limit=' + limit);
      const rows = await res.json();
      const keys = Array.from(fieldsSel.selectedOptions).map(o => o.value);
      const head = ['ts', ...keys].join(',');
      const lines = [head, ...rows.map(r => [r.ts, ...keys.map(k => r[k] ?? '')].join(','))];
      const blob = new Blob([lines.join('\\n')], { type:'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = deviceId + '.csv'; a.click();
      URL.revokeObjectURL(url);
    });

    load();
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await connectMongo();
    startMqtt();
    app.listen(PORT, () => {
      console.log(`🚀 API on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
})();

// helpful in dev:
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
