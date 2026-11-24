/* Talento · Entregas — app do motorista (piloto).
   Funciona sem internet: a lista do dia e as marcações ficam no celular (IndexedDB)
   e sobem para a loja quando houver sinal. Sem config.js preenchido, roda em modo demonstração. */
'use strict';
(function () {
  const CFG = window.TALENTO_CFG || {};
  const DEMO = !CFG.supabaseUrl || !CFG.anonKey;
  const LOJA_TEL = CFG.grupoLoja || '';
  const MOTIVOS = ['Cliente não estava', 'Endereço não encontrado', 'Cliente pediu para outro dia', 'Material errado ou faltando', 'Sem acesso para o caminhão'];
  const PAY = { pago: 'Pago no balcão', receber: 'Receber na entrega', crediario: 'Crediário: assinar' };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const hoje = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  /* ---------- armazenamento local (IndexedDB) ---------- */
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((ok, err) => {
      const r = indexedDB.open('talento-entregas', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('kv'); d.createObjectStore('fila', { keyPath: 'id' }); d.createObjectStore('fotos'); };
      r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((ok, err) => { const t = d.transaction(store, mode); const s = t.objectStore(store); const r = fn(s); t.oncomplete = () => ok(r && r.result); t.onerror = () => err(t.error); });
  }
  const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
  const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));
  const filaAll = () => tx('fila', 'readonly', (s) => s.getAll());
  const filaPut = (e) => tx('fila', 'readwrite', (s) => s.put(e));
  const filaDel = (id) => tx('fila', 'readwrite', (s) => s.delete(id));
  const fotoGet = (k) => tx('fotos', 'readonly', (s) => s.get(k));
  const fotoSet = (k, b) => tx('fotos', 'readwrite', (s) => s.put(b, k));

  /* ---------- estado ---------- */
  let S = { data: hoje(), lista: null, est: { done: {}, falha: {}, nota: {}, forma: {}, avisou: {} }, ui: { failOpen: {}, block: {} }, fila: 0, sess: null, fotoUrl: {} };
  const estKey = () => 'estado-' + S.data;
  async function salvarEstado() { await kvSet(estKey(), S.est); }

  /* ---------- servidor (Supabase via REST, sem bibliotecas) ---------- */
  async function api(path, opt) {
    opt = opt || {};
    const h = Object.assign({ apikey: CFG.anonKey, Authorization: 'Bearer ' + (S.sess ? S.sess.access_token : CFG.anonKey) }, opt.headers || {});
    const r = await fetch(CFG.supabaseUrl + path, Object.assign({}, opt, { headers: h }));
    if (r.status === 401 && S.sess && !opt._retry) { await renovar(); return api(path, Object.assign({}, opt, { _retry: true })); }
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 200));
    return r;
  }
  async function entrar(email, senha) {
    const r = await fetch(CFG.supabaseUrl + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: senha }) });
    if (!r.ok) throw new Error('Login não aceito');
    S.sess = await r.json(); await kvSet('sessao', S.sess);
  }
  async function renovar() {
    const r = await fetch(CFG.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: S.sess.refresh_token }) });
    if (!r.ok) throw new Error('Sessão expirada');
    S.sess = await r.json(); await kvSet('sessao', S.sess);
  }
  async function baixarLista() {
    if (DEMO) { const r = await fetch('demo.json'); return r.json(); }
    const r = await api('/rest/v1/listas?data=eq.' + S.data + '&select=conteudo,atualizado_em&order=atualizado_em.desc&limit=1');
    const j = await r.json();
    return j.length ? j[0].conteudo : null;
  }

  /* ---------- fila de envio ---------- */
  async function registrar(tipo, dados, fotoKey) {
    const e = { id: uid(), tipo: tipo, data: S.data, ts: new Date().toISOString(), dados: dados, foto: fotoKey || null };
    await filaPut(e); await contarFila(); sincronizar();
  }
  async function contarFila() { S.fila = (await filaAll()).length; pintarSinal(); }
  let sincronizando = false;
  async function sincronizar() {
    if (DEMO || sincronizando || !navigator.onLine || !S.sess) return pintarSinal();
    sincronizando = true; pintarSinal();
    try {
      const itens = (await filaAll()).sort((a, b) => a.ts < b.ts ? -1 : 1);
      for (const e of itens) {
        let foto_path = null;
        if (e.foto) {
          const blob = await fotoGet(e.foto);
          if (blob) {
            foto_path = e.data + '/' + S.sess.user.id + '/' + e.id + '.jpg';
            await api('/storage/v1/object/notinhas/' + foto_path, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }, body: blob });
          }
        }
        await api('/rest/v1/eventos?on_conflict=client_id', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ client_id: e.id, data: e.data, tipo: e.tipo, dados: e.dados, foto_path: foto_path, criado_no_celular: e.ts }) });
        await filaDel(e.id);
      }
    } catch (err) { console.warn('sync', err); }
    sincronizando = false; await contarFila();
  }
  window.addEventListener('online', sincronizar);
  setInterval(sincronizar, 60000);

  /* ---------- fotos: reduz antes de guardar (economiza dados) ---------- */
  function reduzir(file) {
    return new Promise((ok) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        const m = 1280, k = Math.min(1, m / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob((b) => ok(b || file), 'image/jpeg', 0.7);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ok(file); };
      img.src = url;
    });
  }

  /* ---------- telas ---------- */
  function pintarSinal() {
    const el = $('sinal'); if (!el) return;
    if (DEMO) { el.className = 'sinal'; el.textContent = 'Modo demonstração: nada é enviado para a loja.'; return; }
    if (!navigator.onLine) { el.className = 'sinal off'; el.textContent = 'Sem sinal. ' + (S.fila ? S.fila + ' registro(s) guardado(s) no celular, sobem quando pegar sinal.' : 'Tudo guardado no celular.'); return; }
    if (S.fila) { el.className = 'sinal'; el.innerHTML = (sincronizando ? 'Enviando ' : 'Esperando envio: ') + S.fila + ' registro(s). <button type="button" id="enviarJa">Enviar agora</button>'; const b = $('enviarJa'); if (b) b.onclick = sincronizar; return; }
    el.className = 'sinal ok'; el.textContent = 'Tudo enviado para a loja.';
  }
  const waLink = (d, txt) => 'https://wa.me/' + (d ? '55' + d : '') + (txt ? '?text=' + encodeURIComponent(txt) : '');

  function render() {
    pintarSinal();
    const L = S.lista;
    if (!L) { $('main').innerHTML = '<p class="vazio">Ainda não há lista para hoje. Abra o app no Wi-Fi da loja depois que a pauta for carregada.</p>'; return; }
    const stops = L.stops || [];
    const feitos = stops.filter((s) => S.est.done[s.id]).length;
    $('contador').textContent = feitos + '/' + stops.length;
    $('barra').style.width = (stops.length ? Math.round(feitos / stops.length * 100) : 0) + '%';
    let cred = 0, rec = 0; stops.forEach((s) => s.pedidos.forEach((p) => { if (p.pay === 'crediario') cred++; if (p.pay === 'receber') rec++; }));
    $('chips').innerHTML = '<span><b>' + cred + '</b> crediário p/ assinar</span><span><b>' + rec + '</b> a receber</span><span><b>' + (L.waits || []).filter((w) => !S.est.avisou[w.id]).length + '</b> aguardando cliente</span>';
    let h = '';
    stops.forEach((s, i) => { h += cardParada(s, i); });
    h += '<h2 class="sec">Aguardando o cliente avisar</h2>';
    h += (L.waits || []).map((w) => '<div class="espera"><b>' + esc(w.nome) + '</b><span>Pedido ' + esc(w.num) + ' · ' + esc(w.data) + '</span><span>' + esc(w.resumo) + '</span><span>Obs.: ' + esc(w.obs) + '</span><button type="button" data-a="avisou" data-id="' + esc(w.id) + '">' + (S.est.avisou[w.id] ? 'Cliente avisou: entra na próxima pauta' : 'Cliente avisou que pode levar') + '</button></div>').join('') || '<p class="vazio">Nenhum.</p>';
    h += fechamento();
    $('main').innerHTML = h;
  }

  function cardParada(s, i) {
    const done = !!S.est.done[s.id], falha = S.est.falha[s.id] || '';
    const hasLoc = s.lat != null;
    const cls = done ? 'ok' : falha ? 'err' : hasLoc ? '' : 'semloc';
    let h = '<article class="card' + (done ? ' feito' : '') + (falha ? ' falhou' : '') + '">';
    h += '<div class="cab"><div class="n ' + cls + '"><i>' + (i + 1) + '</i></div><div><h2>' + esc(s.nome) + '</h2><div class="end">' + esc(s.endereco) + '</div></div></div>';
    if (s.prazo) h += '<span class="tag prazo">' + esc(s.prazo) + '</span>';
    if (s.outroLocal) h += '<span class="tag outro">Entregar em outro endereço: ver obs.</span>';
    if (s.obs) h += '<div class="obs"><b>Obs.:</b> ' + esc(s.obs) + '</div>';
    s.pedidos.forEach((p, j) => {
      const key = s.id + '-' + j;
      h += '<section class="ped ' + p.pay + '"><h3>Pedido ' + esc(p.num) + '<small>' + esc(p.data) + ' · ' + esc(p.vendedor) + '</small></h3><ul>' + p.itens.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>';
      if (p.jaLevou) h += '<span class="ja">Já levou na loja: ' + esc(p.jaLevou) + '</span>';
      h += '<div class="pay"><b>' + PAY[p.pay] + '</b><span>' + esc(p.payNote) + '</span></div>';
      if (p.pay === 'receber') {
        const f = S.est.forma[key] || '';
        h += '<span>' + (f ? 'Recebido em ' + f.toLowerCase() : 'Como o cliente pagou?') + '</span><div class="formas">' + ['Dinheiro', 'Pix', 'Cartão'].map((x) => '<button type="button" class="' + (f === x ? 'sel' : '') + '" data-a="forma" data-k="' + key + '" data-v="' + x + '">' + x + '</button>').join('') + '</div>';
      }
      if (p.pay === 'crediario') {
        const tem = !!S.est.nota[key];
        h += '<span>A notinha vai grampeada: o cliente assina e você fotografa.</span>';
        h += '<label class="btn cam' + (tem ? ' tem' : '') + '">' + (tem ? 'Tirar outra foto' : 'Fotografar notinha assinada') + '<input type="file" accept="image/*" capture="environment" data-a="nota" data-k="' + key + '" data-s="' + esc(s.id) + '" data-p="' + esc(p.num) + '"></label>';
        if (tem && S.fotoUrl[key]) h += '<div class="thumb"><img src="' + S.fotoUrl[key] + '" alt="Notinha assinada">Notinha assinada e fotografada.</div>';
        else if (tem) h += '<div class="thumb">Notinha fotografada.</div>';
      }
      h += '</section>';
    });
    if (s.flags && s.flags.length) h += '<div class="flags"><b>Cadastro para corrigir:</b> ' + esc(s.flags.join(' ')) + '</div>';
    (s.fones || []).forEach((f) => {
      h += '<div class="fone"><span>' + esc(f.label) + ': <b>' + esc(f.num) + '</b></span>' + (f.d ? '<a class="btn" href="' + waLink(f.d) + '">WhatsApp</a>' : '') + '<a class="btn" href="tel:' + esc(f.d || String(f.num).replace(/\D/g, '')) + '">Ligar</a></div>';
    });
    if (hasLoc) { if (s.locNote) h += '<span class="ja">' + esc(s.locNote) + '</span>'; }
    else h += pedirLocal(s);
    const maps = hasLoc ? 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + s.lat + ',' + s.lon : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(s.busca || s.endereco);
    h += '<div class="linha"><a class="btn ' + (hasLoc ? 'prim' : '') + '" href="' + maps + '">' + (hasLoc ? 'Navegar' : 'Buscar endereço') + '</a><button type="button" class="' + (done ? 'feitoBtn' : '') + '" data-a="done" data-id="' + esc(s.id) + '">' + (done ? '✓ Entregue' : 'Entregar') + '</button></div>';
    if (S.ui.block[s.id]) h += '<span class="aviso" role="status">Fotografe a notinha assinada do crediário antes de concluir.</span>';
    if (falha) h += '<div class="falha" role="status"><b>Não entregue: ' + esc(falha) + '</b><span>A loja é avisada e o pedido volta para a pauta.</span><button type="button" data-a="undo" data-id="' + esc(s.id) + '">Desfazer</button></div>';
    else if (!done && S.ui.failOpen[s.id]) h += '<div class="motivos"><b>O que aconteceu?</b>' + MOTIVOS.map((m) => '<button type="button" data-a="motivo" data-id="' + esc(s.id) + '" data-v="' + esc(m) + '">' + esc(m) + '</button>').join('') + '<button type="button" data-a="fechaFalha" data-id="' + esc(s.id) + '">Cancelar</button></div>';
    else if (!done) h += '<button type="button" data-a="abreFalha" data-id="' + esc(s.id) + '" style="color:#991b1b;border-color:#fca5a5">Não consegui entregar</button>';
    return h + '</article>';
  }

  function primeiro(n) { const w = String(n).split(' ')[0]; return w.charAt(0) + w.slice(1).toLowerCase(); }
  function pedirLocal(s) {
    const cel = ((s.fones || []).find((f) => f.d) || {}).d || '';
    const nums = s.pedidos.map((p) => p.num).join(' e ');
    const msg = 'Olá, ' + primeiro(s.nome) + '! Tudo bem?\nAqui é o pessoal da entrega da Talento Materiais de Construção. 🚚\nEstamos organizando a entrega do seu pedido nº ' + nums + ' e precisamos da localização do lugar onde vamos descarregar.\nPode nos mandar por aqui? É só tocar no 📎 (clipe), escolher "Localização" e depois "Enviar localização atual", de preferência estando no local da obra.\nSe puder, mande também uma foto de onde quer que o material fique.\nObrigado!';
    const ret = 'Localização: ' + s.nome + (s.cod ? ' (cód. ' + s.cod + ')' : '') + ' · Pedido ' + nums;
    return '<div class="pedir"><b>Sem localização salva. Mensagem pronta para pedir:</b><p>' + esc(msg) + '</p>' + (cel ? '<a class="btn verde" href="' + waLink(cel, msg) + '">Pedir localização no WhatsApp</a>' : '<span class="aviso">Sem celular válido no cadastro: pedir pela loja.</span>') + '<span><b>Depois que o cliente mandar:</b> encaminhe a localização ao grupo da loja e mande junto:</span><p><b>' + esc(ret) + '</b></p><a class="btn" href="' + waLink(LOJA_TEL, ret) + '">Enviar identificação para a loja</a></div>';
  }

  function fechamento() {
    const st = (S.lista && S.lista.stops) || [];
    const nome = (s) => primeiro(s.nome) + ' (' + s.pedidos.map((p) => p.num).join(', ') + ')';
    const ent = st.filter((s) => S.est.done[s.id]), fal = st.filter((s) => S.est.falha[s.id]), pen = st.filter((s) => !S.est.done[s.id] && !S.est.falha[s.id]);
    let ct = 0, cf = 0; const rec = [];
    ent.forEach((s) => s.pedidos.forEach((p, j) => { const k = s.id + '-' + j; if (p.pay === 'crediario') { ct++; if (S.est.nota[k]) cf++; } if (p.pay === 'receber') rec.push(p.num + ': ' + (S.est.forma[k] || 'forma não marcada') + ' · ' + p.payNote); }));
    const linhas = ['Entregues: ' + (ent.map(nome).join(', ') || 'nenhuma'), 'Não entregues: ' + (fal.map((s) => nome(s) + ' – ' + S.est.falha[s.id].toLowerCase()).join('; ') || 'nenhuma'), 'Faltam: ' + (pen.map(nome).join(', ') || 'nenhuma'), 'Notinhas de crediário fotografadas: ' + cf + ' de ' + ct, 'Recebido na entrega: ' + (rec.join('; ') || 'nada')];
    const txt = '*Fechamento das entregas ' + S.data.split('-').reverse().join('/') + (S.motorista ? ' – ' + S.motorista : '') + '*\n' + linhas.map((l) => '• ' + l).join('\n');
    return '<section class="fecha"><h2>Fechamento do dia</h2><div class="nums"><div><b>' + ent.length + '</b>entregues</div><div><b>' + fal.length + '</b>não entregues</div><div><b>' + pen.length + '</b>faltam</div></div><ul>' + linhas.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul><a class="btn" href="' + waLink(LOJA_TEL, txt) + '">Enviar fechamento para a loja</a></section>';
  }

  /* ---------- ações ---------- */
  const achar = (id) => (S.lista.stops || []).find((s) => s.id === id);
  const faltaFoto = (s) => s.pedidos.some((p, j) => p.pay === 'crediario' && !S.est.nota[s.id + '-' + j]);
  $('main').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-a]'); if (!b || b.tagName === 'INPUT') return;
    const a = b.dataset.a, id = b.dataset.id;
    if (a === 'done') {
      const s = achar(id); const was = !!S.est.done[id];
      if (!was && faltaFoto(s)) { S.ui.block[id] = true; return render(); }
      S.est.done[id] = !was; if (!was) delete S.est.falha[id]; S.ui.block[id] = false;
      await salvarEstado(); await registrar(was ? 'entrega_desfeita' : 'entregue', { parada: id, pedidos: s.pedidos.map((p) => p.num) });
    } else if (a === 'abreFalha') { S.ui.failOpen[id] = true; }
    else if (a === 'fechaFalha') { S.ui.failOpen[id] = false; }
    else if (a === 'motivo') {
      const s = achar(id); S.est.falha[id] = b.dataset.v; S.est.done[id] = false; S.ui.failOpen[id] = false;
      await salvarEstado(); await registrar('nao_entregue', { parada: id, pedidos: s.pedidos.map((p) => p.num), motivo: b.dataset.v });
    } else if (a === 'undo') {
      const s = achar(id); delete S.est.falha[id];
      await salvarEstado(); await registrar('falha_desfeita', { parada: id, pedidos: s.pedidos.map((p) => p.num) });
    } else if (a === 'forma') {
      const k = b.dataset.k; S.est.forma[k] = S.est.forma[k] === b.dataset.v ? '' : b.dataset.v;
      await salvarEstado(); await registrar('pagamento', { chave: k, forma: S.est.forma[k] });
    } else if (a === 'avisou') {
      S.est.avisou[id] = !S.est.avisou[id]; await salvarEstado(); await registrar('cliente_avisou', { espera: id, valor: S.est.avisou[id] });
    }
    render();
  });
  $('main').addEventListener('change', async (ev) => {
    const el = ev.target; if (el.dataset.a !== 'nota' || !el.files || !el.files[0]) return;
    const k = el.dataset.k, blob = await reduzir(el.files[0]), fk = S.data + '/' + k + '/' + uid();
    await fotoSet(fk, blob);
    if (S.fotoUrl[k]) URL.revokeObjectURL(S.fotoUrl[k]);
    S.fotoUrl[k] = URL.createObjectURL(blob); S.est.nota[k] = fk; S.ui.block[el.dataset.s] = false;
    await salvarEstado(); await registrar('foto_notinha', { chave: k, parada: el.dataset.s, pedido: el.dataset.p }, fk);
    render();
  });

  /* ---------- login (uma vez por celular) ---------- */
  function telaLogin(msg) {
    const L = $('login'); L.hidden = false;
    L.innerHTML = '<img src="logo.png" alt="Talento"><h1>Entregas</h1><p>Entrada feita uma vez neste celular.</p>' + (msg ? '<p class="aviso">' + esc(msg) + '</p>' : '') + '<input id="lEmail" type="email" autocomplete="username" placeholder="E-mail do celular"><input id="lSenha" type="password" autocomplete="current-password" placeholder="Senha"><button type="button" class="prim" id="lOk">Entrar</button>';
    $('lOk').onclick = async () => { try { await entrar($('lEmail').value.trim(), $('lSenha').value); L.hidden = true; iniciar(); } catch (e) { telaLogin('Não entrou. Confira e-mail e senha e se há sinal.'); } };
  }

  /* ---------- início ---------- */
  async function iniciar() {
    S.est = (await kvGet(estKey())) || S.est;
    for (const k of Object.keys(S.est.nota || {})) { const b = await fotoGet(S.est.nota[k]); if (b) S.fotoUrl[k] = URL.createObjectURL(b); }
    if (!DEMO) {
      S.sess = S.sess || (await kvGet('sessao'));
      if (!S.sess) return telaLogin();
      S.motorista = (S.sess.user && S.sess.user.user_metadata && S.sess.user.user_metadata.nome) || '';
      $('quem').textContent = S.motorista ? 'Motorista: ' + S.motorista : '';
    } else $('quem').textContent = 'Demonstração com os 15 cupons do lote';
    S.lista = await kvGet('lista-' + S.data);
    render();
    if (navigator.onLine || DEMO) {
      try { const nova = await baixarLista(); if (nova) { S.lista = nova; await kvSet('lista-' + S.data, nova); } } catch (e) { console.warn('lista', e); }
      render();
    }
    await contarFila(); sincronizar();
  }
  window.addEventListener('offline', pintarSinal);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  iniciar();
})();
