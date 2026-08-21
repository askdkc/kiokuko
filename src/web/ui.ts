import { DEFAULT_WEB_LOCALE, WEB_LOCALE_LABELS, WEB_LOCALES, WEB_MESSAGES } from './i18n.js';

const WEB_I18N_CONFIG = JSON.stringify({
  defaultLocale: DEFAULT_WEB_LOCALE,
  localeLabels: WEB_LOCALE_LABELS,
  locales: WEB_LOCALES,
  messages: WEB_MESSAGES,
})
  .replaceAll('&', '\\u0026')
  .replaceAll('<', '\\u003c')
  .replaceAll('>', '\\u003e')
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029');

export const WEB_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kiokuko Web</title>
  <style>
    :root { color-scheme: light; --ink:#1e293b; --muted:#64748b; --line:#e2e8f0; --panel:#ffffff; --surface:#f8fafc; --accent:#2563eb; --accent-soft:#eff6ff; --warn:#b45309; --danger:#b91c1c; }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    body { margin:0; background:linear-gradient(135deg,#f8fafc,#eef2ff); color:var(--ink); font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input,select,textarea { font:inherit; }
    button { cursor:pointer; }
    .shell { max-width:1440px; margin:0 auto; padding:28px; }
    .topbar { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(420px,.9fr); gap:24px; align-items:start; margin-bottom:22px; }
    .brand,.topbar-side { min-width:0; }
    .topbar-side { display:flex; flex-direction:column; gap:10px; align-self:stretch; }
    .eyebrow { color:var(--accent); font-size:12px; font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
    h1 { margin:4px 0 0; font-size:clamp(28px,4vw,44px); letter-spacing:-.04em; }
    .subtitle { margin:8px 0 0; color:var(--muted); }
    .language-picker { position:relative; align-self:flex-end; z-index:10; }
    .language-toggle { display:grid; place-items:center; width:44px; height:44px; border:1px solid var(--line); border-radius:12px; background:var(--panel); color:var(--ink); box-shadow:0 6px 18px rgba(15,23,42,.06); }
    .language-toggle:hover,.language-toggle[aria-expanded="true"] { border-color:#93c5fd; background:var(--accent-soft); color:var(--accent); }
    .language-toggle:focus-visible,.language-option:focus-visible { outline:3px solid rgba(37,99,235,.25); outline-offset:2px; }
    .language-toggle svg { width:22px; height:22px; }
    .language-menu { position:absolute; top:calc(100% + 8px); right:0; display:grid; gap:2px; width:max-content; min-width:168px; padding:6px; border:1px solid var(--line); border-radius:14px; background:var(--panel); box-shadow:0 18px 48px rgba(15,23,42,.16); }
    .language-option { display:flex; align-items:center; justify-content:space-between; gap:18px; width:100%; border:0; border-radius:9px; padding:9px 11px; background:transparent; color:var(--ink); text-align:left; }
    .language-option:hover,.language-option:focus-visible,.language-option[aria-checked="true"] { background:var(--accent-soft); color:var(--accent); }
    .language-option[aria-checked="true"]::after { content:"✓"; font-weight:800; }
    .toolbar { display:flex; gap:10px; align-items:center; justify-content:flex-end; flex-wrap:wrap; margin-top:auto; }
    .topbar-side .control { flex:1 1 210px; width:auto; min-width:0; }
    .topbar-side .search { flex:1.4 1 240px; width:auto; min-width:0; }
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
    .operator-panel { grid-column:1 / -1; margin-top:16px; }
    .operator-grid { display:grid; grid-template-columns:minmax(240px,.7fr) minmax(420px,1.3fr); gap:16px; }
    .run-list { display:flex; flex-direction:column; gap:8px; max-height:360px; overflow:auto; }
    .run-card { border:1px solid var(--line); border-radius:12px; padding:11px; background:var(--panel); text-align:left; }
    .run-card.selected { border-color:#93c5fd; background:var(--accent-soft); }
    .detail-block { border-top:1px solid var(--line); padding-top:12px; margin-top:12px; }
    .detail-block h3 { margin:0 0 8px; font-size:14px; }
    .detail-text { white-space:pre-wrap; overflow-wrap:anywhere; color:var(--muted); font-size:13px; }
    .curator-panel { margin-top:16px; }
    .curator-list { display:grid; gap:12px; }
    .curator-card { border:1px solid var(--line); border-radius:14px; padding:16px; background:var(--panel); }
    .curator-card h3 { margin:8px 0; font-size:17px; }
    .curator-overview { margin:8px 0 12px; color:var(--muted); white-space:pre-wrap; line-height:1.55; }
    .curator-draft { margin:12px 0; padding:12px; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
    .curator-draft h4 { margin:0 0 10px; font-size:14px; }
    .curator-draft-label { margin:10px 0 4px; color:var(--muted); font-size:12px; font-weight:700; }
    .curator-draft-value { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; font-size:13px; line-height:1.5; }
    .curator-reasons { color:var(--muted); font-size:12px; white-space:pre-wrap; }
    @media (max-width:680px) { .operator-grid { grid-template-columns:1fr; } }
    @media (max-width:1050px) { .layout { grid-template-columns:180px minmax(280px,1fr); } .editor-panel { grid-column:1 / -1; } }
    @media (max-width:680px) { .shell { padding:16px; } .topbar { display:block; position:relative; } .brand { padding-right:56px; } .topbar-side { margin-top:16px; align-self:auto; } .language-picker { position:absolute; top:0; right:0; } .toolbar { justify-content:stretch; margin-top:0; } .topbar-side .control,.topbar-side .search { flex:1 1 100%; width:100%; } .search { min-width:0; } .layout { grid-template-columns:1fr; } .genres-panel { order:0; } .list-panel { order:1; } .editor-panel { order:2; } .entry-list { max-height:none; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="eyebrow" data-i18n="eyebrow">Local memory console</div>
        <h1>Kiokuko Web</h1>
        <p class="subtitle" data-i18n="subtitle">Browse SQLite memory by role and purpose, memory type, and cross-cutting tags, and safely edit candidate entries.</p>
      </div>
      <div class="topbar-side">
        <div id="language-picker" class="language-picker">
          <button id="language-toggle" class="language-toggle" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="language-menu" aria-label="Language" data-i18n-aria-label="languageLabel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"></path></svg>
          </button>
          <div id="language-menu" class="language-menu" role="menu" aria-label="Language" data-i18n-aria-label="languageLabel" hidden></div>
        </div>
        <div class="toolbar">
          <select id="workspace" class="control" aria-label="Workspace" data-i18n-aria-label="workspaceLabel"></select>
          <input id="search" class="search" type="search" placeholder="Search memory…" aria-label="Search memory…" data-i18n-placeholder="searchPlaceholder" data-i18n-aria-label="searchPlaceholder">
          <button id="curator-button" class="button" type="button" data-i18n="curator">Curator</button>
          <button id="refresh" class="button" type="button" data-i18n="refresh">Refresh</button>
        </div>
      </div>
    </header>
    <div id="status" class="status" role="status"></div>
    <section class="layout">
      <aside class="panel genres-panel">
        <div class="panel-head"><h2 data-i18n="filtersPanelTitle">Role and purpose / tags</h2></div>
        <nav id="genres" class="genres" aria-label="Filter by role and purpose, memory type, or tag" data-i18n-aria-label="filtersNavLabel"></nav>
      </aside>
      <section class="panel list-panel">
        <div class="panel-head"><h2 id="list-title">Memory</h2><span id="result-count" class="badge">0 items</span></div>
        <div class="panel-body"><div id="entry-list" class="entry-list"></div></div>
      </section>
      <section class="panel editor-panel">
        <div class="panel-head"><h2 data-i18n="editorTitle">Details</h2><span id="editor-state" class="badge" data-i18n="unselected">Not selected</span></div>
        <div class="panel-body"><div id="editor"></div></div>
      </section>
    </section>
    <section id="curator-panel" class="panel curator-panel" hidden>
      <div class="panel-head"><h2 data-i18n="curatorTitle">Curator</h2><span class="badge" data-i18n="curatorBadge">user confirmation required</span></div>
      <div class="panel-body">
        <p class="subtitle" data-i18n="curatorDescription">Review reusable knowledge candidates and add them to global memory.</p>
        <div id="curator-list" class="curator-list"></div>
      </div>
    </section>
    <section class="panel operator-panel">
      <div class="panel-head"><h2 data-i18n="operatorTitle">Agent run operator view</h2><span class="badge" data-i18n="trustBadge">stored data is untrusted / non-actionable</span></div>
      <div class="panel-body operator-grid">
        <div><div id="run-list" class="run-list"></div><div id="run-page" class="status"></div></div>
        <div id="run-detail"><div class="editor-empty" data-i18n="runSelectFull">Select a run to view its intake, profile, timeline, delivery, feedback, and coverage.</div></div>
      </div>
    </section>
  </main>
  <script>
    const i18n = ${WEB_I18N_CONFIG};
    const localeStorageKey = 'kiokuko.web.locale';
    const normalizeLocale = (value) => {
      if (typeof value !== 'string') return null;
      const normalized = value.trim().replaceAll('_', '-').toLowerCase();
      if (!normalized) return null;
      const parts = normalized.split('-');
      const language = parts[0];
      if (language === 'en' || language === 'ja' || language === 'ko') return language;
      if (language === 'zh' && (parts.length === 1 || parts.includes('hans') || parts.includes('cn') || parts.includes('sg'))) return 'zh-CN';
      return null;
    };
    const readStoredLocale = () => { try { return localStorage.getItem(localeStorageKey); } catch { return null; } };
    const browserLocales = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
    const localeCandidates = [new URLSearchParams(location.search).get('lang'), readStoredLocale(), ...browserLocales];
    const initialLocale = localeCandidates.map(normalizeLocale).find(Boolean) || i18n.defaultLocale;
    const kinds = [
      ['all', 'kind.all'], ['fact', 'kind.fact'], ['decision', 'kind.decision'], ['lesson', 'kind.lesson'], ['preference', 'kind.preference'], ['reference', 'kind.reference']
    ];
    const botModes = [
      ['bot:common', 'bot.common'], ['bot:researcher', 'bot.researcher'], ['bot:builder', 'bot.builder'], ['bot:reviewer', 'bot.reviewer'], ['bot:devops', 'bot.devops'], ['bot:writer', 'bot.writer'], ['bot:analyst', 'bot.analyst']
    ];
    const state = { locale: initialLocale, workspace: '', kind: 'all', tag: '', query: '', entries: [], tags: [], selected: null, runs: [], selectedRun: null, curatorCandidates: [], curatorGlobalized: new Set(), curatorOpen: false, localizedStatus: null };
    const $ = (id) => document.getElementById(id);
    const t = (key, parameters = {}) => {
      const template = i18n.messages[state.locale]?.[key] ?? i18n.messages[i18n.defaultLocale]?.[key] ?? key;
      return template.replace(/\{([^}]+)\}/g, (_match, name) => Object.prototype.hasOwnProperty.call(parameters, name) ? String(parameters[name]) : '');
    };
    const tp = (key, count) => {
      const category = new Intl.PluralRules(state.locale).select(count) === 'one' ? 'one' : 'other';
      return t(key + '.' + category, { count });
    };
    const setI18nText = (element, key) => { element.dataset.i18n = key; element.textContent = t(key); return element; };
    const labelForKind = (kind) => { const item = kinds.find(([value]) => value === kind); return item ? t(item[1]) : kind; };
    const labelForStatus = (status) => i18n.messages[state.locale]?.['status.' + status] ?? status;
    const updateEditorState = () => {
      const element = $('editor-state');
      if (state.selected) { delete element.dataset.i18n; element.dataset.i18nStatus = state.selected.status; element.textContent = labelForStatus(state.selected.status); }
      else { delete element.dataset.i18nStatus; setI18nText(element, 'unselected'); }
    };
    const showStatus = (message, error = false) => { $('status').textContent = message; $('status').className = error ? 'status notice error' : 'status'; };
    const setStatus = (message, error = false) => { state.localizedStatus = null; showStatus(message, error); };
    const setLocalizedStatus = (key, parameters = {}, error = false) => { state.localizedStatus = { key, parameters, error }; showStatus(t(key, parameters), error); };
    const setLocalizedCountStatus = (key, count, error = false) => { state.localizedStatus = { key, count, error, plural: true }; showStatus(tp(key, count), error); };
    const renderLanguageMenu = () => {
      const menu = $('language-menu');
      menu.replaceChildren(...i18n.locales.map((locale) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'language-option';
        option.lang = locale;
        option.dataset.locale = locale;
        option.setAttribute('role', 'menuitemradio');
        option.setAttribute('aria-checked', String(locale === state.locale));
        option.textContent = i18n.localeLabels[locale];
        option.addEventListener('click', () => selectLocale(locale));
        return option;
      }));
    };
    const setLanguageMenuOpen = (open, restoreFocus = false) => {
      const menu = $('language-menu');
      const toggle = $('language-toggle');
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) requestAnimationFrame(() => menu.querySelector('[aria-checked="true"]')?.focus());
      else if (restoreFocus) toggle.focus();
    };
    const selectLocale = (value) => {
      state.locale = normalizeLocale(value) || i18n.defaultLocale;
      try { localStorage.setItem(localeStorageKey, state.locale); } catch {}
      setLanguageMenuOpen(false, true);
      applyTranslations(); renderFilters(); renderEntries(); renderRuns(); renderRunDetail(); renderCurator(); updateEditorState();
    };
    const applyTranslations = () => {
      document.documentElement.lang = state.locale;
      document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
      document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => { element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel)); });
      document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => { element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder)); });
      document.querySelectorAll('[data-i18n-status]').forEach((element) => {
        const value = labelForStatus(element.dataset.i18nStatus);
        if ('value' in element) element.value = value; else element.textContent = value;
      });
      renderLanguageMenu();
      if (state.localizedStatus) showStatus(state.localizedStatus.plural ? tp(state.localizedStatus.key, state.localizedStatus.count) : t(state.localizedStatus.key, state.localizedStatus.parameters), state.localizedStatus.error);
    };
    const api = async (path, options) => {
      const response = await fetch(path, options);
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message || t('requestFailed'));
      return value;
    };
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
      const botButtons = botModes.map(([tag, label]) => filterButton(tag, t(label), tagCounts[tag], state.tag === tag, () => { state.tag = tag; renderFilters(); loadEntries(); }));
      const kindButtons = kinds.map(([kind, label]) => filterButton(kind, t(label), kindCounts[kind], state.kind === kind, () => { state.kind = kind; renderFilters(); loadEntries(); }));
      const tagButtons = state.tags
        .filter((item) => !botModes.some(([tag]) => tag === item.tag))
        .map((item) => filterButton(item.tag, '#' + item.tag, item.count, state.tag === item.tag, () => { state.tag = item.tag; renderFilters(); loadEntries(); }));
      const root = $('genres'); root.replaceChildren(filterGroup(t('botFilterTitle'), botButtons), filterGroup(t('memoryTypeFilterTitle'), kindButtons));
      if (tagButtons.length > 0) root.append(filterGroup(t('crossTagFilterTitle'), tagButtons));
    }

    function renderEntries() {
      $('result-count').textContent = tp('entryCount', state.entries.length);
      $('list-title').textContent = state.tag ? '#' + state.tag : (state.kind === 'all' ? t('entriesTitle') : labelForKind(state.kind));
      const list = $('entry-list');
      if (!state.entries.length) {
        const empty = document.createElement('div'); empty.className = 'editor-empty'; setI18nText(empty, 'noEntries'); list.replaceChildren(empty); return;
      }
      list.replaceChildren(...state.entries.map((entry) => {
        const card = document.createElement('article'); card.className = 'entry-card ' + (state.selected?.id === entry.id ? 'selected' : '');
        const meta = document.createElement('div'); meta.className = 'entry-meta';
        const kind = document.createElement('span'); kind.className = 'badge'; kind.textContent = labelForKind(entry.kind);
        const status = document.createElement('span'); status.className = 'badge ' + entry.status; status.textContent = labelForStatus(entry.status);
        const revision = document.createElement('span'); revision.textContent = t('revision') + ' ' + entry.revision; meta.append(kind, status, revision);
        const title = document.createElement('h3'); title.textContent = entry.title;
        const snippet = document.createElement('p'); snippet.className = 'snippet'; snippet.textContent = entry.summary || entry.body;
        const tags = document.createElement('div'); tags.className = 'tags'; entry.tags.forEach((tag) => { const item = document.createElement('button'); item.type = 'button'; item.className = 'tag'; item.textContent = '#' + tag; item.addEventListener('click', (event) => { event.stopPropagation(); state.tag = tag; renderFilters(); loadEntries(); }); tags.append(item); });
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'button'; setI18nText(edit, 'edit'); edit.style.marginTop = '12px'; edit.addEventListener('click', (event) => { event.stopPropagation(); selectEntry(entry.id); });
        card.append(meta, title, snippet, tags, edit); card.addEventListener('click', () => selectEntry(entry.id)); return card;
      }));
    }

    function renderEditor() {
      const editor = $('editor');
      const entry = state.selected;
      updateEditorState();
      if (!entry) { const empty = document.createElement('div'); empty.className = 'editor-empty'; setI18nText(empty, 'selectMemory'); editor.replaceChildren(empty); return; }
      const form = document.createElement('form'); form.className = 'form';
      const row = document.createElement('div'); row.className = 'form-row';
      const kindLabel = document.createElement('label'); const kindLabelText = document.createElement('span'); setI18nText(kindLabelText, 'memoryType'); const kind = document.createElement('select'); kinds.filter(([value]) => value !== 'all').forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; setI18nText(option, label); kind.append(option); }); kind.value = entry.kind; kindLabel.append(kindLabelText, kind);
      const statusLabel = document.createElement('label'); const statusLabelText = document.createElement('span'); setI18nText(statusLabelText, 'status'); const status = document.createElement('input'); status.value = labelForStatus(entry.status); status.dataset.i18nStatus = entry.status; status.disabled = true; statusLabel.append(statusLabelText, status); row.append(kindLabel, statusLabel);
      const titleLabel = document.createElement('label'); const titleLabelText = document.createElement('span'); setI18nText(titleLabelText, 'title'); const title = document.createElement('input'); title.value = entry.title; titleLabel.append(titleLabelText, title);
      const bodyLabel = document.createElement('label'); const bodyLabelText = document.createElement('span'); setI18nText(bodyLabelText, 'body'); const body = document.createElement('textarea'); body.className = 'body'; body.value = entry.body; bodyLabel.append(bodyLabelText, body);
      const summaryLabel = document.createElement('label'); const summaryLabelText = document.createElement('span'); setI18nText(summaryLabelText, 'summary'); const summary = document.createElement('textarea'); summary.value = entry.summary || ''; summaryLabel.append(summaryLabelText, summary);
      const tagsLabel = document.createElement('label'); const tagsLabelText = document.createElement('span'); setI18nText(tagsLabelText, 'commaSeparatedTags'); const tags = document.createElement('input'); tags.value = entry.tags.join(', '); tagsLabel.append(tagsLabelText, tags);
      const jsonRow = document.createElement('div'); jsonRow.className = 'form-row';
      const scopeLabel = document.createElement('label'); const scopeLabelText = document.createElement('span'); setI18nText(scopeLabelText, 'scopeJson'); const scope = document.createElement('textarea'); scope.value = JSON.stringify(entry.scope, null, 2); scopeLabel.append(scopeLabelText, scope);
      const provenanceLabel = document.createElement('label'); const provenanceLabelText = document.createElement('span'); setI18nText(provenanceLabelText, 'provenanceJson'); const provenance = document.createElement('textarea'); provenance.value = JSON.stringify(entry.provenance, null, 2); provenanceLabel.append(provenanceLabelText, provenance); jsonRow.append(scopeLabel, provenanceLabel);
      const actions = document.createElement('div'); actions.className = 'toolbar';
      const save = document.createElement('button'); save.type = 'submit'; save.className = 'button primary'; setI18nText(save, 'save');
      const note = document.createElement('div'); note.className = entry.status === 'candidate' ? 'notice' : 'notice error'; setI18nText(note, entry.status === 'candidate' ? 'candidateNotice' : 'immutableNotice');
      if (entry.status !== 'candidate') { save.disabled = true; [kind, title, body, summary, tags, scope, provenance].forEach((control) => { control.disabled = true; }); }
      actions.append(save); form.append(row, titleLabel, bodyLabel, summaryLabel, tagsLabel, jsonRow, note, actions); form.addEventListener('submit', async (event) => { event.preventDefault(); if (save.disabled) return; try {
        const payload = { expectedRevision: entry.revision, kind: kind.value, title: title.value, body: body.value, summary: summary.value || null, scope: JSON.parse(scope.value || '{}'), provenance: JSON.parse(provenance.value || '{}'), tags: escapeTags(tags.value) };
        await api('/api/entries/' + encodeURIComponent(entry.id) + '?workspace=' + encodeURIComponent(state.workspace), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        setLocalizedStatus('saved'); await loadEntries(); await selectEntry(entry.id);
      } catch (error) { setStatus(error.message, true); }
      }); editor.replaceChildren(form);
    }

    async function selectEntry(id) { try { const result = await api('/api/entries/' + encodeURIComponent(id) + '?workspace=' + encodeURIComponent(state.workspace)); state.selected = result.entry; renderEntries(); renderEditor(); } catch (error) { setStatus(error.message, true); } }

    function renderCurator() {
      const panel = $('curator-panel');
      panel.hidden = !state.curatorOpen;
      if (!state.curatorOpen) return;
      const root = $('curator-list');
      if (!state.curatorCandidates.length) { const empty = document.createElement('div'); empty.className = 'editor-empty'; setI18nText(empty, 'noCuratorCandidates'); root.replaceChildren(empty); return; }
      root.replaceChildren(...state.curatorCandidates.map((candidate) => {
        const card = document.createElement('article'); card.className = 'curator-card';
        const meta = document.createElement('div'); meta.className = 'entry-meta';
        const kind = document.createElement('span'); kind.className = 'badge'; kind.textContent = labelForKind(candidate.kind);
        const score = document.createElement('span'); score.className = 'badge'; score.textContent = t('curatorScore', { score: candidate.score });
        meta.append(kind, score);
        if (candidate.knowledge && candidate.knowledge.skillReady) { const ready = document.createElement('span'); ready.className = 'badge'; setI18nText(ready, 'curatorSkillReady'); meta.append(ready); }
        const heading = document.createElement('h3'); heading.textContent = candidate.skillName;
        const overview = document.createElement('div'); overview.className = 'curator-overview'; overview.textContent = candidate.overview.join('\n');
        const knowledge = document.createElement('div'); knowledge.className = 'curator-reasons'; knowledge.textContent = candidate.knowledge ? [
          t('curatorEvidence', { hits: candidate.knowledge.qualifiedHits, runs: candidate.knowledge.independentRuns, workspaces: candidate.knowledge.independentWorkspaces }),
          t('curatorSilo', { value: candidate.knowledge.averageCompleteness }),
          ...(candidate.knowledge.readinessReasons || []),
        ].join('\n') : '';
        const draft = document.createElement('section'); draft.className = 'curator-draft';
        const draftHeading = document.createElement('h4'); setI18nText(draftHeading, 'curatorDraft');
        draft.append(draftHeading);
        const draftFields = [
          ['curatorDraftTitle', candidate.draft.title],
          ['curatorDraftSummary', candidate.draft.summary],
          ['curatorDraftBody', candidate.draft.body],
          ['curatorDraftVersion', candidate.draft.version],
          ['curatorDraftChanges', (candidate.draft.changes || []).map((change) => t({
            'portable-sections-generated': 'curatorChangePortableSections',
            'project-references-normalized': 'curatorChangeProjectReferences',
            'paths-generalized': 'curatorChangePaths',
            'applicability-retained': 'curatorChangeApplicability',
          }[change] || 'curatorChangeUnknown')).join('\n')],
        ];
        for (const [labelKey, value] of draftFields) {
          const label = document.createElement('div'); label.className = 'curator-draft-label'; setI18nText(label, labelKey);
          const content = document.createElement('pre'); content.className = 'curator-draft-value'; content.textContent = value;
          draft.append(label, content);
        }
        const reasons = document.createElement('div'); reasons.className = 'curator-reasons'; reasons.textContent = [...(candidate.reasons || []), ...(candidate.warnings || []).map((warning) => t('curatorWarning', { warning }))].join('\n');
        const action = document.createElement('button'); action.type = 'button'; action.className = 'button primary';
        const done = state.curatorGlobalized.has(candidate.entryId); action.disabled = done; setI18nText(action, done ? 'globalized' : 'globalize');
        action.addEventListener('click', async () => {
          action.disabled = true;
          try {
            await api('/api/curator/globalize?workspace=' + encodeURIComponent(state.workspace), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entryId: candidate.entryId, expectedRevision: candidate.revision }) });
            state.curatorGlobalized.add(candidate.entryId); setLocalizedStatus('curatorAdded'); renderCurator(); await loadEntries();
          } catch (error) { action.disabled = false; setStatus(error.message, true); }
        });
        card.append(meta, heading, overview, knowledge, draft, reasons, action); return card;
      }));
    }

    async function loadCurator() {
      if (!state.workspace) return;
      state.curatorOpen = true; renderCurator();
      try { const result = await api('/api/curator/candidates?workspace=' + encodeURIComponent(state.workspace) + '&limit=50'); state.curatorCandidates = result.candidates || []; renderCurator(); }
      catch (error) { setStatus(error.message, true); }
    }

    async function loadRunDetail(runId) {
      try {
        const result = await api('/api/operator/runs/' + encodeURIComponent(runId));
        state.selectedRun = result;
        renderRunDetail();
      } catch (error) { setStatus(error.message, true); }
    }

    function detailBlock(titleKey, value) {
      const block = document.createElement('section'); block.className = 'detail-block';
      const heading = document.createElement('h3'); setI18nText(heading, titleKey);
      const text = document.createElement('div'); text.className = 'detail-text'; text.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      block.append(heading, text); return block;
    }

    function renderRunDetail() {
      const root = $('run-detail'); const detail = state.selectedRun;
      if (!detail) { const empty = document.createElement('div'); empty.className = 'editor-empty'; setI18nText(empty, 'runSelect'); root.replaceChildren(empty); return; }
      const heading = document.createElement('h3'); setI18nText(heading, 'contextWarning');
      const blocks = [
        detailBlock('detailRunIntake', { run: detail.run, intake: detail.intake }),
        detailBlock('detailInitialProfile', detail.profile.initial),
        detailBlock('detailProjectedProfile', detail.profile.projected),
        detailBlock('detailPolicySource', { policyVersion: detail.profile.policyVersion, source: detail.profile.source, initialProfileHash: detail.profile.initialProfileHash }),
        detailBlock('detailCoverageWarnings', { coverage: detail.coverage, evidenceState: detail.evidenceState, warnings: detail.warnings }),
        detailBlock('detailTimelineEvidence', { timeline: detail.timeline, evidence: detail.evidence }),
        detailBlock('detailDeliveriesReasons', detail.deliveries),
        detailBlock('detailFeedback', detail.feedback),
        detailBlock('detailProposalLinks', { proposals: detail.proposals, links: detail.memoryLinks }),
      ];
      root.replaceChildren(heading, ...blocks);
    }

    function renderRuns() {
      const root = $('run-list');
      if (!state.runs.length) { const empty = document.createElement('div'); empty.className = 'editor-empty'; setI18nText(empty, 'noRuns'); root.replaceChildren(empty); return; }
      root.replaceChildren(...state.runs.map((run) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'run-card' + (state.selectedRun?.run?.runId === run.runId ? ' selected' : '');
        button.textContent = run.runId + ' / ' + (run.status || t('unknown')) + ' / ' + (run.title || t('untitled'));
        button.addEventListener('click', () => loadRunDetail(run.runId)); return button;
      }));
    }

    async function loadRuns() {
      if (!state.workspace) return;
      try {
        const result = await api('/api/operator/runs?workspace=' + encodeURIComponent(state.workspace) + '&limit=50');
        state.runs = result.items || []; renderRuns(); setI18nText($('run-page'), result.nextCursor ? 'nextPage' : 'end');
        if (!state.selectedRun && state.runs[0]) await loadRunDetail(state.runs[0].runId);
        else renderRunDetail();
      } catch (error) { setStatus(error.message, true); }
    }

    async function loadEntries() { if (!state.workspace) return; try { const params = new URLSearchParams({ workspace: state.workspace }); if (state.kind !== 'all') params.set('kind', state.kind); if (state.tag) params.set('tag', state.tag); if (state.query) params.set('q', state.query); const result = await api('/api/entries?' + params); state.entries = result.entries; if (state.selected && !state.entries.some((entry) => entry.id === state.selected.id)) state.selected = null; renderEntries(); renderFilters(); if (!state.selected && state.entries[0]) await selectEntry(state.entries[0].id); else renderEditor(); setLocalizedCountStatus('displayedCount', result.entries.length); } catch (error) { setStatus(error.message, true); } }
    async function loadTags() { if (!state.workspace) return; try { const result = await api('/api/tags?workspace=' + encodeURIComponent(state.workspace)); state.tags = result.tags; renderFilters(); } catch (error) { setStatus(error.message, true); } }
    async function loadWorkspaces() { try { const result = await api('/api/workspaces'); const select = $('workspace'); select.replaceChildren(...result.workspaces.map((item) => { const option = document.createElement('option'); option.value = item.workspace; option.textContent = (item.displayName || item.workspace) + ' (' + item.count + ')'; return option; })); if (!state.workspace && result.workspaces[0]) state.workspace = result.workspaces[0].workspace; select.value = state.workspace; if (state.workspace) { await loadTags(); await loadEntries(); await loadRuns(); if (state.curatorOpen) await loadCurator(); } else setLocalizedStatus('noWorkspace', {}, true); } catch (error) { setStatus(error.message, true); } }
    $('language-toggle').addEventListener('click', () => {
      setLanguageMenuOpen($('language-toggle').getAttribute('aria-expanded') !== 'true');
    });
    $('language-toggle').addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      setLanguageMenuOpen(true);
    });
    $('language-menu').addEventListener('keydown', (event) => {
      const options = [...$('language-menu').querySelectorAll('.language-option')];
      const current = options.indexOf(document.activeElement);
      let next = null;
      if (event.key === 'ArrowDown') next = options[(current + 1) % options.length];
      if (event.key === 'ArrowUp') next = options[(current - 1 + options.length) % options.length];
      if (event.key === 'Home') next = options[0];
      if (event.key === 'End') next = options.at(-1);
      if (event.key === 'Escape') { event.preventDefault(); setLanguageMenuOpen(false, true); return; }
      if (next) { event.preventDefault(); next.focus(); }
    });
    document.addEventListener('click', (event) => { if (!$('language-picker')?.contains(event.target)) setLanguageMenuOpen(false); });
    document.addEventListener('focusin', (event) => { if (!$('language-picker')?.contains(event.target)) setLanguageMenuOpen(false); });
    $('workspace').addEventListener('change', (event) => { state.workspace = event.target.value; state.selected = null; state.selectedRun = null; state.runs = []; state.tag = ''; state.curatorCandidates = []; state.curatorGlobalized = new Set(); state.curatorOpen = false; renderCurator(); loadTags().then(loadEntries).then(loadRuns); });
    $('curator-button').addEventListener('click', () => loadCurator());
    $('refresh').addEventListener('click', () => loadWorkspaces());
    let searchTimer; $('search').addEventListener('input', (event) => { clearTimeout(searchTimer); state.query = event.target.value.trim(); searchTimer = setTimeout(() => loadEntries(), 180); });
    applyTranslations();
    loadWorkspaces();
  </script>
</body>
</html>`;
