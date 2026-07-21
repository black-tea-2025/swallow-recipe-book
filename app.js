/* レシピ帳: 依存関係なし、すべて端末内で完結する。 */
(() => {
  'use strict';
  const APP = { name: '燕のレシピ帳', dbName: 'swallow-recipe-book', dbVersion: 1 };
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[c]);
  const now = () => new Date().toISOString();
  const id = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const formatDate = iso => new Intl.DateTimeFormat('ja-JP', { dateStyle:'medium', timeStyle:'short' }).format(new Date(iso));
  const normalize = text => String(text ?? '').trim().replace(/[\s\u3000]+/g, ' ').toLocaleLowerCase('en-US');
  const clone = data => JSON.parse(JSON.stringify(data));

  const state = { recipes:[], view:'home', currentId:null, tab:'ingredients', query:'', favoriteOnly:false, scrolls:new Map(), message:'', error:'', importTarget:null, dirty:false };
  let db;

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(APP.dbName, APP.dbVersion);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('recipes')) database.createObjectStore('recipes', { keyPath:'id' });
        if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings', { keyPath:'key' });
      };
      request.onsuccess = () => { db = request.result; resolve(); };
      request.onerror = () => reject(request.error);
    });
  }
  function tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const request = fn(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  const getAll = () => tx('recipes', 'readonly', store => store.getAll());
  const put = recipe => tx('recipes', 'readwrite', store => store.put(recipe));
  const remove = recipeId => tx('recipes', 'readwrite', store => store.delete(recipeId));
  async function replaceAll(recipes) {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('recipes', 'readwrite'); const store = transaction.objectStore('recipes');
      store.clear(); recipes.forEach(recipe => store.put(recipe)); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
  }
  async function refresh() { state.recipes = (await getAll()).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); }
  const current = () => state.recipes.find(recipe => recipe.id === state.currentId);
  function baseRecipe(overrides = {}) { const date = now(); return { id:id(), title:'', servings:'', ingredients:'', steps:'', originalText:'', originalFilename:'', favorite:false, createdAt:date, updatedAt:date, versions:[], ...overrides }; }
  function snapshot(recipe) { return { title:recipe.title, servings:recipe.servings, ingredients:recipe.ingredients, steps:recipe.steps, originalText:recipe.originalText, originalFilename:recipe.originalFilename, savedAt:recipe.updatedAt }; }
  function addVersion(recipe, prior) { return [snapshot(prior), ...(recipe.versions || [])].slice(0,2); }
  function contentChanged(a,b) { return ['title','servings','ingredients','steps','originalText','originalFilename'].some(key => a[key] !== b[key]); }
  async function saveEdited(existing, values) {
    const next = { ...existing, ...values };
    if (contentChanged(existing, next)) { next.versions = addVersion(next, existing); next.updatedAt = now(); }
    await put(next); await refresh(); return next;
  }

  function currentHeader(backAction = 'go-home') {
    return `<header class="page-head"><button class="icon" data-action="${backAction}" aria-label="戻る">‹</button><img class="brand-mark" src="icons/icon.svg" alt=""><div><h1>${esc(APP.name)}</h1></div></header>`;
  }
  function alertHtml() { return `${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ''}${state.message ? `<p class="notice" role="status">${esc(state.message)}</p>` : ''}`; }
  function render() {
    const app = $('#app'); if (!app) return;
    if (state.view === 'home') renderHome(app);
    if (state.view === 'view') renderView(app);
    if (state.view === 'edit') renderEdit(app, false);
    if (state.view === 'import') renderEdit(app, true);
    if (state.view === 'history') renderHistory(app);
    bindCommon(); app.focus({ preventScroll:true });
  }
  function renderHome(app) {
    app.innerHTML = `<header class="page-head"><img class="brand-mark" src="icons/icon.svg" alt=""><div><h1>${esc(APP.name)}</h1><p class="subtitle">料理中のための、端末内だけのレシピ帳</p></div></header>${alertHtml()}
      <input class="search" id="search" type="search" autocomplete="off" placeholder="料理名・材料で検索" value="${esc(state.query)}" aria-label="料理名・材料で検索">
      <div class="toolbar"><button data-action="import-home">txt・mdを取り込む</button><button data-action="backup">JSONバックアップ</button><button data-action="restore">JSON復元</button><button class="primary" data-action="new">＋ 新規作成</button></div>
      <div class="filter-row"><label><input type="checkbox" id="favorite-filter" ${state.favoriteOnly ? 'checked' : ''}> お気に入りだけ</label><span id="recipe-count"></span></div>
      <section class="recipe-list" id="recipe-list"></section>`;
    updateHomeResults();
    $('#search').addEventListener('input', event => { state.query = event.target.value; updateHomeResults(); });
    $('#favorite-filter').addEventListener('change', event => { state.favoriteOnly = event.target.checked; updateHomeResults(); });
    $('#recipe-list').addEventListener('click', event => {
      const button = event.target.closest('[data-open]');
      if (!button) return;
      state.currentId = button.dataset.open; state.tab = 'ingredients'; state.message=''; state.error=''; state.view='view'; render();
    });
  }
  function filteredRecipes() {
    const q = normalize(state.query);
    return state.recipes
      .filter(recipe => !state.favoriteOnly || recipe.favorite)
      .filter(recipe => !q || normalize(recipe.title).includes(q) || normalize(recipe.ingredients).includes(q));
  }
  function homeResultsHtml(recipes) {
    return recipes.length ? recipes.map(recipe => `<button class="recipe-card" data-open="${recipe.id}"><span class="recipe-meta"><span class="recipe-title">${esc(recipe.title)}</span>${recipe.servings ? `<span class="recipe-serving">${esc(recipe.servings)}</span>` : ''}</span>${recipe.favorite ? '<span class="star" aria-label="お気に入り">★</span>' : ''}</button>`).join('') : '<p class="empty">まだレシピがない。新規作成かファイル取り込みから始めよう。</p>';
  }
  function updateHomeResults() {
    const recipes = filteredRecipes();
    const count = $('#recipe-count'); const list = $('#recipe-list');
    if (!count || !list) return;
    count.textContent = `${recipes.length} 件`;
    list.innerHTML = homeResultsHtml(recipes);
  }
  function renderView(app) {
    const recipe = current(); if (!recipe) { goHome(); return; }
    const isIngredients = state.tab === 'ingredients';
    app.innerHTML = `${currentHeader()}${alertHtml()}<section class="recipe-info"><h2>${esc(recipe.title)}</h2>${recipe.servings ? `<p>${esc(recipe.servings)}</p>` : ''}</section>
      <div class="action-row"><button class="${recipe.favorite ? 'active' : ''}" data-action="favorite">${recipe.favorite ? '★ お気に入り' : '☆ お気に入り'}</button><button data-action="edit">編集</button><button data-action="import-update">ファイルで更新</button><button data-action="export">書き出し</button></div>
      <nav class="sticky-tabs" aria-label="レシピ内容"><button class="${isIngredients ? 'active' : ''}" data-tab="ingredients">材料</button><button class="${!isIngredients ? 'active' : ''}" data-tab="steps">手順</button></nav>
      <article class="reading" id="reading">${esc(isIngredients ? recipe.ingredients : recipe.steps) || '<span class="empty">まだ書かれていない。</span>'}</article>
      <details><summary>元テキストを確認</summary><div class="reading">${esc(recipe.originalText) || '元テキストはありません。'}</div></details>
      <div class="action-row"><button data-action="history">旧版履歴（${recipe.versions.length}）</button><button class="danger" data-action="delete">削除</button></div>`;
    requestAnimationFrame(() => window.scrollTo(0, state.scrolls.get(`${recipe.id}:${state.tab}`) || 0));
  }
  function editorData(recipe) { return recipe || baseRecipe(); }
  function renderEdit(app, importing) {
    const recipe = editorData(importing ? state.importTarget?.recipe : current());
    const heading = importing ? (state.importTarget?.existing ? 'ファイルで更新（プレビュー）' : '取り込みプレビュー') : (recipe.id ? 'レシピを編集' : '新規レシピ');
    const note = importing && state.importTarget?.oldDetected ? '旧レシピと思われる範囲を検出しました。全文は元テキストに保存されます。' : '';
    app.innerHTML = `${currentHeader(importing ? 'cancel-import' : 'cancel-edit')}<h2>${esc(heading)}</h2>${note ? `<p class="notice">${note}</p>` : ''}${alertHtml()}
      <form class="form" id="recipe-form" novalidate><label class="field">料理名 <input name="title" required value="${esc(recipe.title)}" placeholder="例：麻婆豆腐"></label><label class="field">何人分 <input name="servings" value="${esc(recipe.servings)}" placeholder="例：2人分"></label><label class="field">材料 <textarea name="ingredients" placeholder="改行も補足も、そのまま書ける">${esc(recipe.ingredients)}</textarea></label><label class="field">手順 <textarea name="steps" placeholder="改行も判断メモも、そのまま書ける">${esc(recipe.steps)}</textarea></label>
      ${importing ? `<p class="field">元ファイル名 <input name="originalFilename" value="${esc(recipe.originalFilename)}"></p><details><summary>元テキストを表示・編集</summary><label class="field"><textarea class="original" name="originalText">${esc(recipe.originalText)}</textarea></label></details>` : ''}
      <div class="form-actions"><button type="button" data-action="${importing ? 'cancel-import' : 'cancel-edit'}">キャンセル</button><button class="primary" type="submit">保存</button></div></form>`;
    const form = $('#recipe-form');
    form.addEventListener('input', () => { state.dirty = true; });
    form.addEventListener('submit', async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(form)); await submitEditor(values, importing, recipe); });
  }
  async function submitEditor(values, importing, draft) {
    const title = values.title.trim();
    if (!title) { state.error = '料理名を入力してください。'; render(); return; }
    const fields = { title, servings:values.servings, ingredients:values.ingredients, steps:values.steps };
    try {
      if (importing) {
        fields.originalFilename = values.originalFilename || ''; fields.originalText = values.originalText || '';
        const existing = state.importTarget.existing;
        const saved = existing ? await saveEdited(existing, fields) : baseRecipe({ ...fields });
        if (!existing) { await put(saved); await refresh(); }
        state.currentId = saved.id; state.importTarget = null; state.dirty = false; state.message = 'ファイル内容を保存しました。'; state.view = 'view'; render();
      } else if (draft && current()) {
        const saved = await saveEdited(current(), fields); state.currentId = saved.id; state.dirty = false; state.message = '保存しました。'; state.view = 'view'; render();
      } else {
        const saved = baseRecipe(fields); await put(saved); await refresh(); state.currentId = saved.id; state.dirty = false; state.message = '新しいレシピを保存しました。'; state.view = 'view'; render();
      }
    } catch (error) { state.error = `保存できませんでした: ${error.message}`; render(); }
  }
  function renderHistory(app) {
    const recipe = current(); if (!recipe) { goHome(); return; }
    app.innerHTML = `${currentHeader('back-view')}<h2>旧版履歴</h2><p class="subtitle">保存時点の内容です。最大2件を保持します。</p><section class="history-list">${recipe.versions.length ? recipe.versions.map((version,index) => `<article class="history-card"><p>${esc(formatDate(version.savedAt))}</p><strong>${esc(version.title)}</strong><div class="action-row"><button data-action="show-version" data-index="${index}">内容を見る</button><button data-action="restore-version" data-index="${index}">この版を復元</button></div></article>`).join('') : '<p class="empty">まだ旧版はありません。</p>'}</section>`;
  }
  function bindCommon() {
    document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => action(button.dataset.action, button)));
    document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  }
  async function action(name, button) {
    const recipe = current();
    if (name === 'go-home') return goHome();
    if (name === 'back-view') { state.view='view'; render(); return; }
    if (name === 'new') { state.currentId=null; state.view='edit'; state.dirty=false; state.error=''; state.message=''; render(); return; }
    if (name === 'edit') { state.view='edit'; state.dirty=false; state.error=''; render(); return; }
    if (name === 'cancel-edit') return leaveEditor('home-or-view');
    if (name === 'import-home') { state.importTarget={ existing:null, recipe:null, oldDetected:false }; $('#file-input').click(); return; }
    if (name === 'import-update') { state.importTarget={ existing:clone(recipe), recipe:null, oldDetected:false }; $('#file-input').click(); return; }
    if (name === 'cancel-import') return leaveEditor('home-or-view');
    if (name === 'favorite') { const next = { ...recipe, favorite:!recipe.favorite }; await put(next); await refresh(); render(); return; }
    if (name === 'history') { state.view='history'; render(); return; }
    if (name === 'delete') { if (confirm(`「${recipe.title}」を削除します。元に戻せません。`)) { await remove(recipe.id); await refresh(); state.currentId=null; state.message='削除しました。'; goHome(false); } return; }
    if (name === 'show-version') return showVersion(recipe.versions[Number(button.dataset.index)]);
    if (name === 'restore-version') return restoreVersion(Number(button.dataset.index));
    if (name === 'export') return showExport(recipe);
    if (name === 'backup') return downloadBackup();
    if (name === 'restore') { $('#restore-input').click(); return; }
  }
  function goHome(checkDirty = true) { if (checkDirty && state.dirty && !confirm('保存していない変更を破棄しますか？')) return; state.dirty=false; state.view='home'; state.error=''; render(); }
  function leaveEditor() { if (state.dirty && !confirm('保存していない変更を破棄しますか？')) return; state.dirty=false; state.importTarget=null; state.view=current() ? 'view' : 'home'; state.error=''; render(); }
  function switchTab(tab) { const recipe=current(); state.scrolls.set(`${recipe.id}:${state.tab}`, window.scrollY); state.tab=tab; render(); }
  function modal(content) { const backdrop=document.createElement('div'); backdrop.className='modal-backdrop'; backdrop.innerHTML=`<section class="modal" role="dialog" aria-modal="true">${content}</section>`; backdrop.addEventListener('click', event => { if (event.target === backdrop) backdrop.remove(); }); document.body.append(backdrop); backdrop.querySelector('[data-close]')?.focus(); return backdrop; }
  function showVersion(version) { modal(`<h2>${esc(formatDate(version.savedAt))} の版</h2><div class="history-content"><strong>${esc(version.title)}</strong>\n${esc(version.servings)}\n\n【材料】\n${esc(version.ingredients)}\n\n【手順】\n${esc(version.steps)}</div><div class="action-row"><button data-close>閉じる</button></div>`).querySelector('[data-close]').addEventListener('click', event => event.currentTarget.closest('.modal-backdrop').remove()); }
  async function restoreVersion(index) {
    const recipe=current(), version=recipe.versions[index]; if (!version || !confirm('この旧版を現在版として復元します。現在版は履歴に残ります。')) return;
    const currentSnap=snapshot(recipe); const other=recipe.versions.filter((_,i)=>i!==index); const next={...recipe,...clone(version), updatedAt:now(), versions:[currentSnap,...other].slice(0,2)}; delete next.savedAt;
    await put(next); await refresh(); state.message='旧版を復元しました。'; state.view='view'; render();
  }
  function filenameSafe(title) { return title.replace(/[\\/:*?"<>|]/g, '_').slice(0,80) || 'recipe'; }
  function download(name, content, type) { const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([content], {type})); a.download=name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0); }
  function showExport(recipe) { const content=`${recipe.title}\n${recipe.servings ? `${recipe.servings}\n` : ''}\n材料\n${recipe.ingredients}\n\n手順\n${recipe.steps}\n`; const md=`# ${recipe.title}\n\n${recipe.servings ? `${recipe.servings}\n\n` : ''}## 材料\n${recipe.ingredients}\n\n## 手順\n${recipe.steps}\n`; const box=modal(`<h2>書き出し</h2><p>元テキストは含めない標準形式です。</p><div class="action-row"><button data-txt>txt</button><button class="primary" data-md>md</button><button data-close>閉じる</button></div>`); $('[data-txt]',box).addEventListener('click',()=>download(`${filenameSafe(recipe.title)}.txt`,content,'text/plain;charset=utf-8')); $('[data-md]',box).addEventListener('click',()=>download(`${filenameSafe(recipe.title)}.md`,md,'text/markdown;charset=utf-8')); $('[data-close]',box).addEventListener('click',()=>box.remove()); }
  function downloadBackup() { download(`swallow-recipe-book-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify({ format:'swallow-recipe-book', version:1, exportedAt:now(), settings:{ appName:APP.name }, recipes:state.recipes },null,2),'application/json;charset=utf-8'); state.message='JSONバックアップをダウンロードしました。'; render(); }

  const titleClean = line => line.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*⌘?レシピ\s*/,'').trim();
  const isRecipeMarker = line => /^\s*#?\s*⌘?レシピ\s*$/i.test(line);
  const isOld = line => /(?:旧\s*(?:レシピ|版)|過去レシピ)/i.test(line);
  const isIngredients = line => /^\s*(?:#{1,6}\s*)?(?:材料(?:・調味料)?|調味料|分量)(?=\s|$|[:：])/i.test(line.trim());
  const isSteps = line => /^\s*(?:#{1,6}\s*)?(?:作り方|作りかた|手順|step\s*\d*|\d+[、.．)）]\s*)/i.test(line.trim());
  const serving = line => { const match=line.match(/(?:【\s*)?(?:\d+(?:\s*\/\s*\d+)?\s*(?:人分|人前|食分)|\d+\s*食(?:分)?|\d+(?:\s*\/\s*\d+)?\s*分量)(?:\s*】)?/); return match ? match[0].trim() : ''; };
  function parseRecipe(text, filename='') {
    const originalText=String(text ?? '').replace(/^\uFEFF/,''); const all=originalText.replace(/\r\n?/g,'\n'); const lines=all.split('\n'); const oldIndex=lines.findIndex(isOld); const active=oldIndex >= 0 ? lines.slice(0,oldIndex) : lines;
    const meaningful=active.map((line,index)=>({line,index})).filter(row => row.line.trim());
    let title='';
    for (const row of meaningful) { const candidate=titleClean(row.line); if (candidate && !isIngredients(row.line) && !isSteps(row.line) && !serving(row.line) && !/^(?:調理|制作)時間/i.test(candidate)) { title=candidate; break; } }
    if (!title) title=filename.replace(/\.[^.]+$/,'').replace(/^⌘?レシピ\s*/,'').trim() || '無題のレシピ';
    const servings=[]; active.forEach(line => { const hit=serving(line); if (hit && !servings.includes(hit)) servings.push(hit); });
    let ingredientStart=-1, stepStart=-1;
    active.forEach((line,index) => { if (ingredientStart<0 && isIngredients(line)) ingredientStart=index+1; if (stepStart<0 && isSteps(line)) stepStart=index; });
    if (ingredientStart<0) { const titleIndex=meaningful.find(row => titleClean(row.line)===title)?.index ?? 0; ingredientStart=Math.min(titleIndex+1, active.length); }
    let ingredients, steps;
    if (stepStart >= 0) { ingredients=active.slice(ingredientStart,stepStart); steps=active.slice(stepStart); }
    else { const nonblank=active.map((line,index)=>({line,index})).filter(row=>row.line.trim() && !isRecipeMarker(row.line)); const last=nonblank.at(-1)?.index ?? -1; const likelySentence=last>=ingredientStart && /[。．]$|(?:作る|入れ|炒め|煮|混ぜ|茹で|完成|出来上がり|一煮立ち)/.test(active[last]); if (likelySentence) { ingredients=active.slice(ingredientStart,last); steps=active.slice(last); } else { ingredients=active.slice(ingredientStart); steps=[]; } }
    // タイトル・人数見出しだけは重複を避ける。その他の行は捨てない。
    ingredients=ingredients.filter(line => !isRecipeMarker(line) && titleClean(line)!==title && !(/^(?:材料(?:・調味料)?|調味料|分量)(?=\s|$|[:：])/i.test(line.trim())));
    return { title, servings:servings.join(' / '), ingredients:ingredients.join('\n').replace(/^\n+|\n+$/g,''), steps:steps.join('\n').replace(/^\n+|\n+$/g,''), originalText, originalFilename:filename, oldDetected:oldIndex>=0 };
  }
  function mojibakeScore(text) { return (text.match(/[竚縺繧譁蛯]/g)||[]).length; }
  async function readText(file) { const buffer=await file.arrayBuffer(); const utf=new TextDecoder('utf-8',{fatal:false}).decode(buffer); try { const sjis=new TextDecoder('shift_jis',{fatal:false}).decode(buffer); return mojibakeScore(sjis) + 2 < mojibakeScore(utf) ? sjis : utf; } catch { return utf; } }
  async function importFile(file) { if (!file) return; if (!/\.(txt|md)$/i.test(file.name)) { state.error='txt または md ファイルを選んでください。'; render(); return; } try { const text=await readText(file); const parsed=parseRecipe(text,file.name); state.importTarget.recipe=baseRecipe(parsed); state.importTarget.recipe.oldDetected=parsed.oldDetected; state.importTarget.oldDetected=parsed.oldDetected; state.view='import'; state.dirty=false; state.error=''; render(); } catch(error) { state.error=`ファイルを読み込めませんでした: ${error.message}`; render(); } }
  function validRecipe(recipe) { return recipe && typeof recipe.id==='string' && typeof recipe.title==='string' && typeof recipe.ingredients==='string' && typeof recipe.steps==='string' && Array.isArray(recipe.versions); }
  async function restoreFile(file) { if (!file) return; try { const parsed=JSON.parse(await readText(file)); if (!parsed || parsed.format!=='swallow-recipe-book' || !Array.isArray(parsed.recipes) || !parsed.recipes.every(validRecipe)) throw new Error('レシピ帳のバックアップ形式ではありません。'); if (!confirm(`現在の ${state.recipes.length} 件をすべて置き換え、${parsed.recipes.length} 件を復元します。元に戻せません。`)) return; await replaceAll(parsed.recipes); await refresh(); state.message=`${state.recipes.length} 件を復元しました。`; state.view='home'; render(); } catch(error) { state.error=`復元しませんでした: ${error.message}`; render(); } }
  function setupInputs() { $('#file-input').addEventListener('change', event => { importFile(event.target.files[0]); event.target.value=''; }); $('#restore-input').addEventListener('change', event => { restoreFile(event.target.files[0]); event.target.value=''; }); window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue=''; } }); }
  async function start() { try { await openDB(); await refresh(); setupInputs(); render(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{}); } catch(error) { $('#app').innerHTML=`<p class="error">保存領域を開けませんでした: ${esc(error.message)}</p>`; } }
  globalThis.RecipeBook = { parseRecipe, normalize, validRecipe };
  if (typeof document !== 'undefined') start();
})();
