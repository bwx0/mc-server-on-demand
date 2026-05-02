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
    <button class="primary" id="start">启动服务器</button>
    <button class="danger" id="stop">安全停止</button>
    <button class="danger" id="forceStop">强制释放</button>
    <button id="preflight">预检</button>
  </section>

  <h2>详情</h2>
  <pre id="output">Loading...</pre>

  <script>
    const tokenInput = document.getElementById('token');
    const output = document.getElementById('output');
    tokenInput.value = localStorage.getItem('controlToken') || '';

    function headers() {
      return {
        'content-type': 'application/json',
        'x-control-token': localStorage.getItem('controlToken') || tokenInput.value,
      };
    }

    async function request(path, options = {}) {
      const response = await fetch(path, { ...options, headers: headers() });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || response.statusText);
      return body;
    }

    function show(data) {
      output.textContent = JSON.stringify(data, null, 2);
      const state = data.state || data;
      document.getElementById('phase').textContent = state.phase || '-';
      document.getElementById('players').textContent = String(state.playerCount ?? '-');
      document.getElementById('runtime').textContent = state.runtimeName || state.runtimeId || '-';
    }

    async function load() {
      try { show(await request('/api/status')); }
      catch (error) { output.textContent = error.message; }
    }

    document.getElementById('saveToken').onclick = () => {
      localStorage.setItem('controlToken', tokenInput.value);
      load();
    };
    document.getElementById('refresh').onclick = load;
    document.getElementById('preflight').onclick = async () => show(await request('/api/preflight'));
    document.getElementById('start').onclick = async () => show(await request('/api/start', { method: 'POST', body: '{}' }));
    document.getElementById('stop').onclick = async () => show(await request('/api/stop', { method: 'POST', body: JSON.stringify({ force: false }) }));
    document.getElementById('forceStop').onclick = async () => show(await request('/api/stop', { method: 'POST', body: JSON.stringify({ force: true }) }));
    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
}
