export function renderUi() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Minecraft On-Demand</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { max-width: 920px; margin: 32px auto; padding: 0 20px; line-height: 1.5; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    button { padding: 10px 14px; border: 1px solid currentColor; border-radius: 8px; background: transparent; cursor: pointer; }
    button.primary { background: #166534; color: white; border-color: #166534; }
    button.danger { background: #991b1b; color: white; border-color: #991b1b; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    input { padding: 10px; border-radius: 8px; border: 1px solid #888; min-width: 280px; }
    pre { overflow: auto; padding: 16px; border-radius: 10px; background: rgba(127,127,127,.12); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 20px 0; }
    .card { border: 1px solid rgba(127,127,127,.35); border-radius: 12px; padding: 16px; }
    .label { color: #777; font-size: 13px; }
    .value { font-size: 24px; font-weight: 700; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 12px 0; }
    .status-line { display: flex; gap: 14px; flex-wrap: wrap; color: #777; font-size: 14px; margin: 8px 0 12px; }
    .spinner { width: 14px; height: 14px; border: 2px solid rgba(127,127,127,.35); border-top-color: currentColor; border-radius: 50%; animation: spin .8s linear infinite; display: none; }
    .busy .spinner { display: inline-block; }
    .hidden { display: none; }
    .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin: 16px 0; }
    .chart { min-height: 150px; }
    .chart svg { width: 100%; height: 90px; overflow: visible; }
    .echart { height: 190px; margin-top: 8px; }
    .metric-big { font-size: 22px; font-weight: 700; margin: 4px 0 8px; }
    .bar { height: 10px; border-radius: 999px; background: rgba(127,127,127,.2); overflow: hidden; }
    .bar span { display: block; height: 100%; background: currentColor; }
    .player-row { display: grid; grid-template-columns: 90px 1fr 64px; gap: 8px; align-items: center; margin: 8px 0; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Minecraft On-Demand</h1>
      <p>需要时启动超高配 Minecraft Java 服务器，空闲时自动停服。</p>
    </div>
    <button id="refresh">刷新</button>
  </header>

  <section class="card">
    <div class="label">控制令牌</div>
    <div class="row">
      <input id="token" type="password" placeholder="输入TOKEN">
      <button id="saveToken">保存</button>
    </div>
  </section>

  <section class="grid">
    <div class="card"><div class="label">状态</div><div class="value" id="phase">-</div></div>
    <div class="card"><div class="label">在线人数</div><div class="value" id="players">-</div></div>
    <div class="card"><div class="label">运行实例</div><div class="value" id="runtime">-</div></div>
  </section>

  <section class="row">
    <button class="primary action" id="start">启动服务器</button>
    <button class="danger action" id="stop">安全停止</button>
    <button class="danger action" id="forceStop">强制释放</button>
    <button class="action admin-only" id="preflight">预检</button>
  </section>

  <div class="status-line" id="statusLine">
    <span class="spinner" aria-hidden="true"></span>
    <span id="busyText">空闲</span>
    <span>状态更新时间：<span id="updatedAt">-</span></span>
    <span>最近心跳：<span id="heartbeatAt">-</span></span>
    <span>自动停服：<span id="idleStopEta">-</span></span>
  </div>
  <section>
    <h2>监控视图</h2>
    <div class="charts" id="charts">
      <div class="card">监控数据加载中...</div>
    </div>
  </section>
  <h2 id="detailsTitle">详情</h2>
  <pre id="output">Loading...</pre>

  <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  <script>
    const tokenInput = document.getElementById('token');
    const output = document.getElementById('output');
    const statusLine = document.getElementById('statusLine');
    const busyText = document.getElementById('busyText');
    const actionButtons = Array.from(document.querySelectorAll('button.action'));
    const adminOnlyElements = Array.from(document.querySelectorAll('.admin-only'));
    const detailsTitle = document.getElementById('detailsTitle');
    const charts = document.getElementById('charts');
    let busy = false;
    let currentPhase = 'unknown';
    let currentRole = null;
    let lastState = null;
    let lastSettings = null;
    let chartInstances = [];
    tokenInput.value = localStorage.getItem('controlToken') || '';

    function formatTime(value) {
      if (!value) return '-';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms)) return '-';
      if (ms <= 0) return '即将停止';
      const totalSeconds = Math.ceil(ms / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    function formatSeconds(seconds) {
      if (!Number.isFinite(Number(seconds))) return '-';
      const total = Math.max(0, Math.floor(Number(seconds)));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const rest = total % 60;
      return hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm ' + rest + 's';
    }

    function formatBytes(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '-';
      const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
      let scaled = number;
      let unit = 0;
      while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit += 1;
      }
      return scaled.toFixed(unit === 0 ? 0 : 1) + ' ' + units[unit];
    }

    function formatAxisTime(value) {
      const date = new Date(value);
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    }

    function latest(series) {
      return series?.length ? series[series.length - 1].v : null;
    }

    function sparkline(series) {
      if (!series?.length) return '<div class="label">暂无数据</div>';
      const values = series.map((point) => Number(point.v)).filter(Number.isFinite);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const span = max - min || 1;
      const width = 260;
      const height = 80;
      const points = series.map((point, index) => {
        const x = series.length === 1 ? width : index * width / (series.length - 1);
        const y = height - ((Number(point.v) - min) / span) * height;
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      return '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none"><polyline fill="none" stroke="currentColor" stroke-width="2" points="' + points + '"/></svg>';
    }

    function chartCard(title, value, series, formatter = (v) => v ?? '-') {
      return '<div class="card chart"><div class="label">' + title + '</div><div class="metric-big">' + formatter(value) + '</div>' + sparkline(series) + '</div>';
    }

    function disposeCharts() {
      for (const chart of chartInstances) {
        chart.dispose();
      }
      chartInstances = [];
    }

    function echartCard(id, title, value, formatter = (v) => v ?? '-') {
      return '<div class="card chart"><div class="label">' + title + '</div><div class="metric-big">' + formatter(value) + '</div><div class="echart" id="' + id + '"></div></div>';
    }

    function echartData(series) {
      return (series || []).map((point) => [point.t, point.v]);
    }

    function drawLineChart(id, title, series, formatter = (v) => v) {
      const element = document.getElementById(id);
      if (!element || !window.echarts) return;
      const chart = window.echarts.init(element);
      chart.setOption({
        tooltip: {
          trigger: 'axis',
          valueFormatter: (value) => String(formatter(value)),
        },
        grid: { left: 50, right: 16, top: 16, bottom: 48 },
        xAxis: {
          type: 'time',
          axisLabel: {
            formatter: formatAxisTime,
            hideOverlap: true,
            interval: 'auto',
          },
          splitNumber: 3,
        },
        yAxis: {
          type: 'value',
          scale: true,
          axisLabel: {
            formatter: (value) => String(formatter(value)).replace('/s', ''),
            width: 44,
            overflow: 'truncate',
          },
          splitNumber: 3,
        },
        dataZoom: [
          { type: 'inside' },
          { type: 'slider', height: 18, bottom: 8 },
        ],
        series: [{
          name: title,
          type: 'line',
          showSymbol: false,
          smooth: true,
          data: echartData(series),
        }],
      });
      chartInstances.push(chart);
    }

    function drawDiskPieChart(id, usedPercent) {
      const element = document.getElementById(id);
      if (!element || !window.echarts) return;
      const percent = Number(usedPercent);
      const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
      const chart = window.echarts.init(element);
      chart.setOption({
        tooltip: { trigger: 'item' },
        series: [{
          type: 'pie',
          radius: ['55%', '78%'],
          avoidLabelOverlap: true,
          label: { show: false },
          data: [
            { value: safePercent, name: '已用磁盘' },
            { value: 100 - safePercent, name: '可用磁盘' },
          ],
        }],
      });
      chartInstances.push(chart);
    }

    function renderPlayerRows(players) {
      if (!players?.length) return '<div class="label">当前没有在线玩家</div>';
      const max = Math.max(...players.map((player) => player.sessionSeconds ?? player.seconds), 1);
      return players.map((player) => {
        const seconds = player.sessionSeconds ?? player.seconds;
        const width = Math.max(3, seconds / max * 100);
        return '<div class="player-row"><div>' + player.name + '</div><div class="bar"><span style="width:' + width + '%"></span></div><div>' + formatSeconds(seconds) + '</div></div>';
      }).join('');
    }

    function renderMetrics(data) {
      const metrics = data.metrics;
      const admin = currentRole === 'admin';
      if (!metrics?.enabled) {
        disposeCharts();
        charts.innerHTML = '<div class="card">' + (metrics?.message || '监控未配置') + '</div>';
        return;
      }
      if (window.echarts) {
        disposeCharts();
        charts.innerHTML = [
          admin ? echartCard('chartPlayers', '在线人数', metrics.stats.playersOnline, (v) => String(v ?? '-')) : '',
          echartCard('chartCpu', 'CPU 使用（核）', latest(metrics.series.cpuCores), (v) => Number(v ?? 0).toFixed(2)),
          echartCard('chartMemory', '内存使用率', latest(metrics.series.memoryPercent), (v) => Number(v ?? 0).toFixed(1) + '%'),
          echartCard('chartDiskPie', '磁盘使用率', metrics.stats.diskUsagePercent, (v) => Number(v ?? 0).toFixed(1) + '%'),
          echartCard('chartRx', '接收流量', latest(metrics.series.networkRxBps), formatBytes),
          echartCard('chartTx', '发送流量', latest(metrics.series.networkTxBps), formatBytes),
          admin ? echartCard('chartIdle', '空服时长', metrics.stats.idleSeconds, formatSeconds) : '',
          '<div class="card"><div class="label">运行状态</div><div class="metric-big">Uptime: '
            + formatSeconds(metrics.stats.uptimeSeconds)
            + '</div><div class="label">RCON状态</div><div class="metric-big">'
            + (metrics.stats.rconUp === 1 ? '正常' : '异常')
            + '</div></div>',
          admin ? '<div class="card"><div class="label">玩家过去 7 天累计在线时长</div>' + renderPlayerRows(metrics.playerDurations) + '</div>' : '',
        ].join('');
        if (admin) drawLineChart('chartPlayers', '在线人数', metrics.series.playersOnline, (v) => v);
        drawLineChart('chartCpu', 'CPU 使用（核）', metrics.series.cpuCores, (v) => Number(v).toFixed(2));
        drawLineChart('chartMemory', '内存使用率', metrics.series.memoryPercent, (v) => Number(v).toFixed(1) + '%');
        drawDiskPieChart('chartDiskPie', metrics.stats.diskUsagePercent);
        drawLineChart('chartRx', '接收流量', metrics.series.networkRxBps, formatBytes);
        drawLineChart('chartTx', '发送流量', metrics.series.networkTxBps, formatBytes);
        if (admin) drawLineChart('chartIdle', '空服时长', metrics.series.idleSeconds, formatSeconds);
        return;
      }
      disposeCharts();
      charts.innerHTML = [
        admin ? chartCard('在线人数', metrics.stats.playersOnline, metrics.series.playersOnline, (v) => String(v ?? '-')) : '',
        chartCard('CPU 使用（核）', latest(metrics.series.cpuCores), metrics.series.cpuCores, (v) => Number(v ?? 0).toFixed(2)),
        chartCard('内存使用率', latest(metrics.series.memoryPercent), metrics.series.memoryPercent, (v) => Number(v ?? 0).toFixed(1) + '%'),
        '<div class="card"><div class="label">磁盘使用率</div><div class="metric-big">' + Number(metrics.stats.diskUsagePercent ?? 0).toFixed(1) + '%</div></div>',
        chartCard('接收流量', latest(metrics.series.networkRxBps), metrics.series.networkRxBps, formatBytes),
        chartCard('发送流量', latest(metrics.series.networkTxBps), metrics.series.networkTxBps, formatBytes),
        admin ? chartCard('空服时长', metrics.stats.idleSeconds, metrics.series.idleSeconds, formatSeconds) : '',
        '<div class="card"><div class="label">运行状态</div><div class="metric-big">Uptime: '
          + formatSeconds(metrics.stats.uptimeSeconds)
          + '</div><div class="label">RCON状态</div><div class="metric-big">'
          + (metrics.stats.rconUp === 1 ? '正常' : '异常')
          + '</div></div>',
        admin ? '<div class="card"><div class="label">玩家过去 7 天累计在线时长</div>' + renderPlayerRows(metrics.playerDurations) + '</div>' : '',
      ].join('');
    }

    function updateIdleStopEta() {
      const target = document.getElementById('idleStopEta');
      if (!lastState || !lastSettings?.idleAutoStop) {
        target.textContent = '-';
        return;
      }
      if (lastState.phase !== 'running' || lastState.playerCount !== 0 || !lastState.zeroPlayersSince) {
        target.textContent = '-';
        return;
      }
      const startedAt = new Date(lastState.zeroPlayersSince).getTime();
      const stopAt = startedAt + Number(lastSettings.idleStopMinutes || 0) * 60 * 1000;
      target.textContent = formatDuration(stopAt - Date.now());
    }

    function setBusy(nextBusy, label = '加载中...') {
      busy = nextBusy;
      statusLine.classList.toggle('busy', busy);
      busyText.textContent = busy ? label : '空闲';
      updateButtons();
    }

    function setRole(role) {
      if (!role) return;
      currentRole = role;
      const admin = currentRole === 'admin';
      output.classList.toggle('hidden', !admin);
      detailsTitle.classList.toggle('hidden', !admin);
      for (const element of adminOnlyElements) {
        element.classList.toggle('hidden', !admin);
      }
    }

    function updateButtons() {
      const lifecycleBusy = ['starting', 'stopping', 'force-stopping'].includes(currentPhase);
      const startupPhase = ['starting', 'initializing'].includes(currentPhase);
      for (const button of actionButtons) {
        button.disabled = busy || lifecycleBusy;
      }
      document.getElementById('start').disabled = busy || lifecycleBusy || currentPhase === 'initializing' || currentPhase === 'running';
      document.getElementById('stop').disabled = busy || lifecycleBusy || startupPhase;
    }

    function headers() {
      return {
        'content-type': 'application/json',
        'x-control-token': localStorage.getItem('controlToken') || tokenInput.value,
      };
    }

    async function request(path, options = {}, label = '加载中...', useGlobalBusy = true) {
      if (useGlobalBusy) setBusy(true, label);
      try {
        const response = await fetch(path, { ...options, headers: headers() });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || response.statusText);
        return body;
      } finally {
        if (useGlobalBusy) setBusy(false);
      }
    }

    function show(data) {
      setRole(data.role);
      if (currentRole === 'admin') {
        output.textContent = JSON.stringify(data, null, 2);
      }
      const state = data.state || data;
      if (!state.phase) return;
      lastState = state;
      lastSettings = data.settings || lastSettings;
      currentPhase = state.phase || 'unknown';
      document.getElementById('phase').textContent = state.phase || '-';
      document.getElementById('players').textContent = String(state.playerCount ?? '-');
      document.getElementById('runtime').textContent = state.runtimeName || state.runtimeId || '-';
      document.getElementById('updatedAt').textContent = formatTime(state.updatedAt);
      document.getElementById('heartbeatAt').textContent = formatTime(state.lastHeartbeatAt);
      updateIdleStopEta();
      updateButtons();
    }

    async function runAction(fn) {
      try {
        show(await fn());
      } catch (error) {
        if (currentRole === 'admin') {
          output.textContent = error.message;
        } else {
          busyText.textContent = error.message;
        }
      }
    }

    async function load() {
      if (busy) return;
      try { show(await request('/api/status', {}, '刷新状态中...')); }
      catch (error) { output.textContent = error.message; }
    }

    async function loadMetrics() {
      try { renderMetrics(await request('/api/metrics/dashboard', {}, '刷新监控中...', false)); }
      catch (error) { charts.innerHTML = '<div class="card">' + error.message + '</div>'; }
    }

    document.getElementById('saveToken').onclick = () => {
      localStorage.setItem('controlToken', tokenInput.value);
      load();
    };
    document.getElementById('refresh').onclick = load;
    document.getElementById('preflight').onclick = () => runAction(() => request('/api/preflight', {}, '预检中...'));
    document.getElementById('start').onclick = () => runAction(() => request('/api/start', { method: 'POST', body: '{}' }, '启动中...'));
    document.getElementById('stop').onclick = () => runAction(() => request('/api/stop', { method: 'POST', body: JSON.stringify({ force: false }) }, '安全停止中...'));
    document.getElementById('forceStop').onclick = () => runAction(() => request('/api/stop', { method: 'POST', body: JSON.stringify({ force: true }) }, '强制释放中...'));
    load();
    loadMetrics();
    setInterval(load, 15000);
    setInterval(loadMetrics, 30000);
    setInterval(updateIdleStopEta, 1000);
    window.addEventListener('resize', () => {
      for (const chart of chartInstances) {
        chart.resize();
      }
    });
  </script>
</body>
</html>`;
}
