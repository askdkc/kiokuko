export const WEB_HTML = String.raw`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kiokuko Web</title>
  <style>
    :root { color-scheme: light; --ink:#1e293b; --muted:#64748b; --line:#e2e8f0; --panel:#ffffff; --surface:#f8fafc; --accent:#2563eb; --accent-soft:#eff6ff; --warn:#b45309; --danger:#b91c1c; }
    * { box-sizing:border-box; }
    body { margin:0; background:linear-gradient(135deg,#f8fafc,#eef2ff); color:var(--ink); font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input,select,textarea { font:inherit; }
    button { cursor:pointer; }
    .shell { max-width:1440px; margin:0 auto; padding:28px; }
    .topbar { display:flex; gap:18px; justify-content:space-between; align-items:flex-end; margin-bottom:22px; }
    .eyebrow { color:var(--accent); font-size:12px; font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
    h1 { margin:4px 0 0; font-size:clamp(28px,4vw,44px); letter-spacing:-.04em; }
    .subtitle { margin:8px 0 0; color:var(--muted); }
    .toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .control, .search { border:1px solid var(--line); border-radius:12px; background:var(--panel); color:var(--ink); padding:10px 12px; }
    .search { min-width:260px; }
    .button { border:1px solid var(--line); border-radius:12px; background:var(--panel); color:var(--ink); padding:10px 14px; font-weight:700; }
    .button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
    .button:disabled { cursor:not-allowed; opacity:.45; }
    .layout { display:grid; grid-template-columns:220px minmax(300px,1fr) minmax(360px,1.15fr); gap:16px; align-items:start; }
    .panel { background:rgba(255,255,255,.88); border:1px solid rgba(226,232,240,.9); border-radius:20px; box-shadow:0 14px 44px rgba(15,23,42,.08); overflow:hidden; }
    .panel-head { padding:18px 20px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:12px; }
    .panel-head h2 { margin:0; font-size:16px; }
    .panel-body { padding:16px; }
    .genres { padding:10px; }
    .filter-group + .filter-group { border-top:1px solid var(--line); margin-top:8px; padding-top:8px; }
    .filter-group-title { color:var(--muted); font-size:11px; font-weight:800; letter-spacing:.08em; padding:8px 12px 4px; text-transform:uppercase; }
    .genre { display:flex; justify-content:space-between; align-items:center; width:100%; border:0; background:transparent; color:var(--muted); border-radius:12px; padding:11px 12px; text-align:left; }
    .genre:hover,.genre.active { background:var(--accent-soft); color:var(--accent); }
    .count { min-width:26px; padding:2px 7px; border-radius:999px; background:#e2e8f0; color:var(--muted); font-size:12px; text-align:center; }
    .genre.active .count { background:#dbeafe; color:var(--accent); }
    .entry-list { display:flex; flex-direction:column; gap:10px; max-height:calc(100vh - 220px); overflow:auto; }
    .entry-card { border:1px solid var(--line); border-radius:14px; padding:14px; background:var(--panel); transition:.16s ease; }
    .entry-card:hover,.entry-card.selected { border-color:#93c5fd; box-shadow:0 8px 20px rgba(37,99,235,.10); }
    .entry-meta { display:flex; gap:7px; align-items:center; flex-wrap:wrap; color:var(--muted); font-size:12px; }
    .badge { border-radius:999px; padding:3px 8px; background:#f1f5f9; color:#475569; font-weight:700; }
    .badge.verified { background:#dcfce7; color:#166534; }
    .badge.candidate { background:#fef3c7; color:#92400e; }
    .badge.superseded { background:#fee2e2; color:#991b1b; }
    .entry-card h3 { margin:9px 0 6px; font-size:16px; }
    .snippet { margin:0; color:var(--muted); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-wrap; }
    .tags { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
    .tag { border:0; background:transparent; color:var(--accent); font-size:12px; padding:0; }
    .tag:hover { text-decoration:underline; }
    .form { display:grid; gap:12px; }
    label { display:grid; gap:6px; color:var(--muted); font-size:12px; font-weight:800; letter-spacing:.04em; }
    textarea,input,select { width:100%; border:1px solid var(--line); border-radius:10px; padding:10px 11px; background:#fff; color:var(--ink); }
    textarea { min-height:120px; resize:vertical; line-height:1.55; }
    textarea.body { min-height:260px; }
    .form-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .editor-empty { color:var(--muted); padding:30px 10px; text-align:center; }
    .notice { border-radius:12px; padding:11px 12px; background:#fffbeb; color:var(--warn); font-size:13px; }
    .notice.error { background:#fef2f2; color:var(--danger); }
    .status { color:var(--muted); font-size:12px; min-height:18px; }
    .operator-panel { grid-column:1 / -1; }
    .operator-grid { display:grid; grid-template-columns:minmax(240px,.7fr) minmax(420px,1.3fr); gap:16px; }
    .run-list { display:flex; flex-direction:column; gap:8px; max-height:360px; overflow:auto; }
    .run-card { border:1px solid var(--line); border-radius:12px; padding:11px; background:var(--panel); text-align:left; }
    .run-card.selected { border-color:#93c5fd; background:var(--accent-soft); }
    .detail-block { border-top:1px solid var(--line); padding-top:12px; margin-top:12px; }
    .detail-block h3 { margin:0 0 8px; font-size:14px; }
    .detail-text { white-space:pre-wrap; overflow-wrap:anywhere; color:var(--muted); font-size:13px; }
    @media (max-width:680px) { .operator-grid { grid-template-columns:1fr; } }
    @media (max-width:1050px) { .layout { grid-template-columns:180px minmax(280px,1fr); } .editor-panel { grid-column:1 / -1; } }
    @media (max-width:680px) { .shell { padding:16px; } .topbar { display:block; } .toolbar { margin-top:16px; } .search { min-width:0; flex:1; } .layout { grid-template-columns:1fr; } .genres-panel { order:0; } .list-panel { order:1; } .editor-panel { order:2; } .entry-list { max-height:none; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div>
        <div class="eyebrow">Local memory console</div>
        <h1>Kiokuko Web</h1>
        <p class="subtitle">Bot用途・記憶タイプ・横断タグからSQLiteの記憶を確認し、安全に候補エントリを編集します。</p>
      </div>
      <div class="toolbar">
        <select id="workspace" class="control" aria-label="ワークスペース"></select>
        <input id="search" class="search" type="search" placeholder="記憶を検索…" aria-label="記憶を検索">
        <button id="refresh" class="button" type="button">更新</button>
      </div>
    </header>
    <div id="status" class="status" role="status"></div>
    <section class="layout">
      <aside class="panel genres-panel">
        <div class="panel-head"><h2>Bot用途 / タグ</h2></div>
        <nav id="genres" class="genres" aria-label="Bot用途・記憶タイプ・タグのフィルター"></nav>
      </aside>
      <section class="panel list-panel">
        <div class="panel-head"><h2 id="list-title">記憶</h2><span id="result-count" class="badge">0件</span></div>
        <div class="panel-body"><div id="entry-list" class="entry-list"></div></div>
      </section>
      <section class="panel editor-panel">
        <div class="panel-head"><h2>内容</h2><span id="editor-state" class="badge">未選択</span></div>
        <div class="panel-body"><div id="editor"></div></div>
      </section>
    </section>
    <section class="panel operator-panel">
      <div class="panel-head"><h2>Agent run operator view</h2><span class="badge">stored data is untrusted / non-actionable</span></div>
      <div class="panel-body operator-grid">
        <div><div id="run-list" class="run-list"></div><div id="run-page" class="status"></div></div>
        <div id="run-detail"><div class="editor-empty">runを選択すると intake、profile、timeline、delivery、feedback、coverage を表示します。</div></div>
      </div>
    </section>
  </main>
  <script>
    const kinds = [
      ['all', 'すべて'], ['fact', '事実'], ['decision', '決定'], ['lesson', '教訓'], ['preference', '好み'], ['reference', '参照']
    ];
    const botModes = [
      ['bot:common', '共通'], ['bot:researcher', 'Researcher'], ['bot:builder', 'Builder'], ['bot:reviewer', 'Reviewer'], ['bot:devops', 'DevOps'], ['bot:writer', 'Writer'], ['bot:analyst', 'Analyst']
    ];
    const state = { workspace: '', kind: 'all', tag: '', query: '', entries: [], tags: [], selected: null, runs: [], selectedRun: null };
    const $ = (id) => document.getElementById(id);
    const api = async (path, options) => {
      const response = await fetch(path, options);
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message || 'リクエストに失敗しました');
      return value;
    };
    const setStatus = (message, error = false) => { $('status').textContent = message; $('status').className = error ? 'status notice error' : 'status'; };
    const labelForKind = (kind) => (kinds.find((item) => item[0] === kind) || [kind, kind])[1];
    const escapeTags = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);

    function filterButton(key, label, count, active, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'genre ' + (active ? 'active' : '');
        const text = document.createElement('span'); text.textContent = label;
        const countBadge = document.createElement('span'); countBadge.className = 'count'; countBadge.textContent = String(count || 0);
        button.append(text, countBadge);
        button.dataset.filter = key;
        button.addEventListener('click', onClick);
        return button;
    }

    function filterGroup(title, buttons) {
      const group = document.createElement('section'); group.className = 'filter-group';
      const heading = document.createElement('div'); heading.className = 'filter-group-title'; heading.textContent = title; group.append(heading, ...buttons); return group;
    }

    function renderFilters() {
      const kindCounts = Object.fromEntries(kinds.map(([kind]) => [kind, kind === 'all' ? state.entries.length : state.entries.filter((entry) => entry.kind === kind).length]));
      const tagCounts = Object.fromEntries(state.tags.map((item) => [item.tag, item.count]));
      const botButtons = botModes.map(([tag, label]) => filterButton(tag, label, tagCounts[tag], state.tag === tag, () => { state.tag = tag; renderFilters(); loadEntries(); }));
      const kindButtons = kinds.map(([kind, label]) => filterButton(kind, label, kindCounts[kind], state.kind === kind, () => { state.kind = kind; renderFilters(); loadEntries(); }));
      const tagButtons = state.tags
        .filter((item) => !botModes.some(([tag]) => tag === item.tag))
        .map((item) => filterButton(item.tag, '#' + item.tag, item.count, state.tag === item.tag, () => { state.tag = item.tag; renderFilters(); loadEntries(); }));
      const root = $('genres'); root.replaceChildren(filterGroup('Bot用途（タグ）', botButtons), filterGroup('記憶タイプ', kindButtons));
      if (tagButtons.length > 0) root.append(filterGroup('横断タグ', tagButtons));
    }

    function renderEntries() {
      $('result-count').textContent = String(state.entries.length) + '件';
      $('list-title').textContent = state.tag ? '#' + state.tag : (state.kind === 'all' ? '記憶' : labelForKind(state.kind));
      const list = $('entry-list');
      if (!state.entries.length) {
        const empty = document.createElement('div'); empty.className = 'editor-empty'; empty.textContent = '該当する記憶はありません。'; list.replaceChildren(empty); return;
      }
      list.replaceChildren(...state.entries.map((entry) => {
        const card = document.createElement('article'); card.className = 'entry-card ' + (state.selected?.id === entry.id ? 'selected' : '');
        const meta = document.createElement('div'); meta.className = 'entry-meta';
        const kind = document.createElement('span'); kind.className = 'badge'; kind.textContent = labelForKind(entry.kind);
        const status = document.createElement('span'); status.className = 'badge ' + entry.status; status.textContent = entry.status;
        const revision = document.createElement('span'); revision.textContent = 'revision ' + entry.revision; meta.append(kind, status, revision);
        const title = document.createElement('h3'); title.textContent = entry.title;
        const snippet = document.createElement('p'); snippet.className = 'snippet'; snippet.textContent = entry.summary || entry.body;
        const tags = document.createElement('div'); tags.className = 'tags'; entry.tags.forEach((tag) => { const item = document.createElement('button'); item.type = 'button'; item.className = 'tag'; item.textContent = '#' + tag; item.addEventListener('click', (event) => { event.stopPropagation(); state.tag = tag; renderFilters(); loadEntries(); }); tags.append(item); });
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'button'; edit.textContent = '編集'; edit.style.marginTop = '12px'; edit.addEventListener('click', (event) => { event.stopPropagation(); selectEntry(entry.id); });
        card.append(meta, title, snippet, tags, edit); card.addEventListener('click', () => selectEntry(entry.id)); return card;
      }));
    }

    function renderEditor() {
      const editor = $('editor');
      const entry = state.selected;
      $('editor-state').textContent = entry ? entry.status : '未選択';
      if (!entry) { const empty = document.createElement('div'); empty.className = 'editor-empty'; empty.textContent = '左の記憶を選択すると内容を編集できます。'; editor.replaceChildren(empty); return; }
      const form = document.createElement('form'); form.className = 'form';
      const row = document.createElement('div'); row.className = 'form-row';
      const kindLabel = document.createElement('label'); kindLabel.textContent = '記憶タイプ'; const kind = document.createElement('select'); kinds.filter(([value]) => value !== 'all').forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; kind.append(option); }); kind.value = entry.kind; kindLabel.append(kind);
      const statusLabel = document.createElement('label'); statusLabel.textContent = '状態'; const status = document.createElement('input'); status.value = entry.status; status.disabled = true; statusLabel.append(status); row.append(kindLabel, statusLabel);
      const titleLabel = document.createElement('label'); titleLabel.textContent = 'タイトル'; const title = document.createElement('input'); title.value = entry.title; titleLabel.append(title);
      const bodyLabel = document.createElement('label'); bodyLabel.textContent = '本文'; const body = document.createElement('textarea'); body.className = 'body'; body.value = entry.body; bodyLabel.append(body);
      const summaryLabel = document.createElement('label'); summaryLabel.textContent = '要約'; const summary = document.createElement('textarea'); summary.value = entry.summary || ''; summaryLabel.append(summary);
      const tagsLabel = document.createElement('label'); tagsLabel.textContent = 'タグ（カンマ区切り）'; const tags = document.createElement('input'); tags.value = entry.tags.join(', '); tagsLabel.append(tags);
      const jsonRow = document.createElement('div'); jsonRow.className = 'form-row';
      const scopeLabel = document.createElement('label'); scopeLabel.textContent = 'scope JSON'; const scope = document.createElement('textarea'); scope.value = JSON.stringify(entry.scope, null, 2); scopeLabel.append(scope);
      const provenanceLabel = document.createElement('label'); provenanceLabel.textContent = 'provenance JSON'; const provenance = document.createElement('textarea'); provenance.value = JSON.stringify(entry.provenance, null, 2); provenanceLabel.append(provenance); jsonRow.append(scopeLabel, provenanceLabel);
      const actions = document.createElement('div'); actions.className = 'toolbar';
      const save = document.createElement('button'); save.type = 'submit'; save.className = 'button primary'; save.textContent = '保存';
      const note = document.createElement('div'); note.className = entry.status === 'candidate' ? 'notice' : 'notice error'; note.textContent = entry.status === 'candidate' ? '候補エントリはrevisionを確認して更新します。' : 'verified / superseded は直接上書きできません。履歴を保つためCLIで置換してください。';
      if (entry.status !== 'candidate') { save.disabled = true; [kind, title, body, summary, tags, scope, provenance].forEach((control) => { control.disabled = true; }); }
      actions.append(save); form.append(row, titleLabel, bodyLabel, summaryLabel, tagsLabel, jsonRow, note, actions); form.addEventListener('submit', async (event) => { event.preventDefault(); if (save.disabled) return; try {
        const payload = { expectedRevision: entry.revision, kind: kind.value, title: title.value, body: body.value, summary: summary.value || null, scope: JSON.parse(scope.value || '{}'), provenance: JSON.parse(provenance.value || '{}'), tags: escapeTags(tags.value) };
        await api('/api/entries/' + encodeURIComponent(entry.id) + '?workspace=' + encodeURIComponent(state.workspace), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        setStatus('保存しました。'); await loadEntries(); await selectEntry(entry.id);
      } catch (error) { setStatus(error.message, true); }
      }); editor.replaceChildren(form);
    }

    async function selectEntry(id) { try { const result = await api('/api/entries/' + encodeURIComponent(id) + '?workspace=' + encodeURIComponent(state.workspace)); state.selected = result.entry; renderEntries(); renderEditor(); } catch (error) { setStatus(error.message, true); } }

    async function loadRunDetail(runId) {
      try {
        const result = await api('/api/operator/runs/' + encodeURIComponent(runId));
        state.selectedRun = result;
        renderRunDetail();
      } catch (error) { setStatus(error.message, true); }
    }

    function detailBlock(title, value) {
      const block = document.createElement('section'); block.className = 'detail-block';
      const heading = document.createElement('h3'); heading.textContent = title;
      const text = document.createElement('div'); text.className = 'detail-text'; text.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      block.append(heading, text); return block;
    }

    function renderRunDetail() {
      const root = $('run-detail'); const detail = state.selectedRun;
      if (!detail) { const empty = document.createElement('div'); empty.className = 'editor-empty'; empty.textContent = 'runを選択すると詳細を表示します。'; root.replaceChildren(empty); return; }
      const heading = document.createElement('h3'); heading.textContent = 'Stored context / recommendations: untrusted, non-actionable';
      const blocks = [
        detailBlock('run / intake', { run: detail.run, intake: detail.intake }),
        detailBlock('initial profile (immutable view)', detail.profile.initial),
        detailBlock('projected profile (ledger revisions)', detail.profile.projected),
        detailBlock('policy / profile source', { policyVersion: detail.profile.policyVersion, source: detail.profile.source, initialProfileHash: detail.profile.initialProfileHash }),
        detailBlock('coverage / evidence warnings', { coverage: detail.coverage, evidenceState: detail.evidenceState, warnings: detail.warnings }),
        detailBlock('timeline / evidence', { timeline: detail.timeline, evidence: detail.evidence }),
        detailBlock('context deliveries / selection reasons', detail.deliveries),
        detailBlock('context / run / intake feedback', detail.feedback),
        detailBlock('memory proposal links', { proposals: detail.proposals, links: detail.memoryLinks }),
      ];
      root.replaceChildren(heading, ...blocks);
    }

    function renderRuns() {
      const root = $('run-list');
      if (!state.runs.length) { const empty = document.createElement('div'); empty.className = 'editor-empty'; empty.textContent = 'runはありません。'; root.replaceChildren(empty); return; }
      root.replaceChildren(...state.runs.map((run) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'run-card' + (state.selectedRun?.run?.runId === run.runId ? ' selected' : '');
        button.textContent = run.runId + ' / ' + (run.status || 'unknown') + ' / ' + (run.title || 'untitled');
        button.addEventListener('click', () => loadRunDetail(run.runId)); return button;
      }));
    }

    async function loadRuns() {
      if (!state.workspace) return;
      try {
        const result = await api('/api/operator/runs?workspace=' + encodeURIComponent(state.workspace) + '&limit=50');
        state.runs = result.items || []; renderRuns(); $('run-page').textContent = result.nextCursor ? '次ページあり（bounded cursor）' : '末尾';
        if (!state.selectedRun && state.runs[0]) await loadRunDetail(state.runs[0].runId);
        else renderRunDetail();
      } catch (error) { setStatus(error.message, true); }
    }

    async function loadEntries() { if (!state.workspace) return; try { const params = new URLSearchParams({ workspace: state.workspace }); if (state.kind !== 'all') params.set('kind', state.kind); if (state.tag) params.set('tag', state.tag); if (state.query) params.set('q', state.query); const result = await api('/api/entries?' + params); state.entries = result.entries; if (state.selected && !state.entries.some((entry) => entry.id === state.selected.id)) state.selected = null; renderEntries(); renderFilters(); if (!state.selected && state.entries[0]) await selectEntry(state.entries[0].id); else renderEditor(); setStatus(String(result.entries.length) + '件を表示中'); } catch (error) { setStatus(error.message, true); } }
    async function loadTags() { if (!state.workspace) return; try { const result = await api('/api/tags?workspace=' + encodeURIComponent(state.workspace)); state.tags = result.tags; renderFilters(); } catch (error) { setStatus(error.message, true); } }
    async function loadWorkspaces() { try { const result = await api('/api/workspaces'); const select = $('workspace'); select.replaceChildren(...result.workspaces.map((item) => { const option = document.createElement('option'); option.value = item.workspace; option.textContent = (item.displayName || item.workspace) + ' (' + item.count + ')'; return option; })); if (!state.workspace && result.workspaces[0]) state.workspace = result.workspaces[0].workspace; select.value = state.workspace; if (state.workspace) { await loadTags(); await loadEntries(); await loadRuns(); } else setStatus('workspaceがありません。CLIで kiokuko use または record を実行してください。', true); } catch (error) { setStatus(error.message, true); } }
    $('workspace').addEventListener('change', (event) => { state.workspace = event.target.value; state.selected = null; state.selectedRun = null; state.runs = []; state.tag = ''; loadTags().then(loadEntries).then(loadRuns); });
    $('refresh').addEventListener('click', () => loadWorkspaces());
    let searchTimer; $('search').addEventListener('input', (event) => { clearTimeout(searchTimer); state.query = event.target.value.trim(); searchTimer = setTimeout(() => loadEntries(), 180); });
    loadWorkspaces();
  </script>
</body>
</html>`;
