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
    button:disabled { opacity: .5; cursor: wait; }
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
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Minecraft On-Demand</h1>
      <p>按需启动高配 Minecraft Java Server，空服后告警或自动释放。</p>
    </div>
    <button id="refresh">刷新</button>
  </header>

  <section class="card">
    <div class="label">控制令牌</div>
    <div class="row">
      <input id="token" type="password" placeholder="CONTROL_TOKEN">
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
    <button class="action" id="preflight">预检</button>
  </section>

  <h2>详情</h2>
  <div class="status-line" id="statusLine">
    <span class="spinner" aria-hidden="true"></span>
    <span id="busyText">空闲</span>
    <span>状态更新时间：<span id="updatedAt">-</span></span>
    <span>最近心跳：<span id="heartbeatAt">-</span></span>
  </div>
  <pre id="output">Loading...</pre>

  <script>
    const tokenInput = document.getElementById('token');
    const output = document.getElementById('output');
    const statusLine = document.getElementById('statusLine');
    const busyText = document.getElementById('busyText');
    const actionButtons = Array.from(document.querySelectorAll('button.action'));
    let busy = false;
    let currentPhase = 'unknown';
    tokenInput.value = localStorage.getItem('controlToken') || '';

    function formatTime(value) {
      if (!value) return '-';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
    }

    function setBusy(nextBusy, label = '加载中...') {
      busy = nextBusy;
      statusLine.classList.toggle('busy', busy);
      busyText.textContent = busy ? label : '空闲';
      updateButtons();
    }

    function updateButtons() {
      const lifecycleBusy = ['starting', 'stopping', 'force-stopping'].includes(currentPhase);
      for (const button of actionButtons) {
        button.disabled = busy || lifecycleBusy;
      }
    }

    function headers() {
      return {
        'content-type': 'application/json',
        'x-control-token': localStorage.getItem('controlToken') || tokenInput.value,
      };
    }

    async function request(path, options = {}, label = '加载中...') {
      setBusy(true, label);
      try {
        const response = await fetch(path, { ...options, headers: headers() });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || response.statusText);
        return body;
      } finally {
        setBusy(false);
      }
    }

    function show(data) {
      output.textContent = JSON.stringify(data, null, 2);
      const state = data.state || data;
      if (!state.phase) return;
      currentPhase = state.phase || 'unknown';
      document.getElementById('phase').textContent = state.phase || '-';
      document.getElementById('players').textContent = String(state.playerCount ?? '-');
      document.getElementById('runtime').textContent = state.runtimeName || state.runtimeId || '-';
      document.getElementById('updatedAt').textContent = formatTime(state.updatedAt);
      document.getElementById('heartbeatAt').textContent = formatTime(state.lastHeartbeatAt);
      updateButtons();
    }

    async function runAction(fn) {
      try {
        show(await fn());
      } catch (error) {
        output.textContent = error.message;
      }
    }

    async function load() {
      if (busy) return;
      try { show(await request('/api/status', {}, '刷新状态中...')); }
      catch (error) { output.textContent = error.message; }
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
    setInterval(load, 15000);
  </script>
</body>
</html>`;
}
