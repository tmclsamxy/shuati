/* =========================================================
   刷题记忆 · 应知应会  —— 单页应用
   数据读写统一经由 Store（见 store.js），业务层不直接接触存储
   ========================================================= */
(function () {
'use strict';

/* ---------------- 常量 ---------------- */
var TYPE_LABEL = { single: '单选', multi: '多选', judge: '判断', fill: '填空' };
var DAY = 86400000;
// 间隔重复：第 n 次答对后的复习间隔（天）
var SRS_STEPS = [1, 2, 4, 7, 15, 30, 60];

/* ---------------- 内存缓存 ----------------
   数据真身在服务端（题库 / 进度 / 档案），这里只是本次会话的快照，
   所有写入都要经 Store 回写。
   -------------------------------------------- */
var DB = null;          // { questions: [], settings: { theme } }
var ME = null;          // 当前用户档案 { id, nickname, role, perms, createdAt }
var PROGRESS = {};      // { qid: { right, wrong, streak, mastery, lastAt, nextAt, fav, wrongFlag } }
var LOG_MS = 0;         // 本地累计学习时长（毫秒），用于本次会话计时展示

function uid(p) {
  return (p || 'q') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
/** 全局唯一 qid：时间戳 + 随机串，避免多端并发时撞号 */
function newQid() {
  return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function todayStr(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function blankDB() {
  return { questions: [], settings: { theme: 'light' } };
}

function normalizeDB(raw) {
  var d = raw || blankDB();
  d.questions = d.questions || [];
  d.settings = d.settings || { theme: 'light' };
  return d;
}

/** 从服务端拉取题库 + 当前用户进度，填充内存缓存 */
function loadCloudData() {
  return Promise.all([Store.Bank.all(), Store.Progress.all()]).then(function (res) {
    var bank = res[0], prog = res[1];
    if (bank.ok === false) throw new Error(bank.error);
    if (prog.ok === false) throw new Error(prog.error);
    DB = normalizeDB({ questions: bank.data, settings: DB ? DB.settings : null });
    PROGRESS = prog.data || {};
  });
}

/** 把某道题的进度立即回写服务端 */
function persistProg(qid) {
  var p = PROGRESS[qid];
  if (!p) return Promise.resolve();
  return Store.Progress.saveOne(qid, p).then(function (r) {
    if (r && r.ok === false) toast('进度保存失败：' + (r.error || ''), 'no');
  });
}
/* ---------------- 当前用户与权限 ---------------- */
function currentUser() { return ME; }
function isAdmin() { return !!ME && ME.role === 'admin'; }
function can(perm) {
  if (!ME) return false;
  if (ME.role === 'admin') return true;
  return !!(ME.perms && ME.perms[perm]);
}
/** 展示名：优先昵称，其次用户名 */
function displayName() {
  if (!ME) return '';
  return ME.nickname || ME.username || '用户';
}

function myProgress() { return PROGRESS; }
function progOf(qid) {
  if (!PROGRESS[qid]) {
    PROGRESS[qid] = { right: 0, wrong: 0, streak: 0, mastery: 0, lastAt: 0, nextAt: 0, fav: false, wrongFlag: false };
  }
  return PROGRESS[qid];
}
/** 掌握度 0-100：综合考虑正确率与最近表现 */
function masteryOf(qid) {
  var p = progOf(qid);
  var total = p.right + p.wrong;
  if (!total) return 0;
  var acc = p.right / total;
  var streakBonus = Math.min(p.streak, 4) / 4 * 0.35;
  var recency = p.lastAt ? Math.max(0, 1 - (Date.now() - p.lastAt) / (30 * DAY)) : 0;
  var m = acc * 0.6 + streakBonus + recency * 0.25;
  return Math.max(0, Math.min(100, Math.round(m * 100)));
}
function masteryLevel(m) {
  if (m >= 80) return { label: '已掌握', cls: 'ok' };
  if (m >= 55) return { label: '较熟练', cls: 'ok' };
  if (m >= 30) return { label: '模糊', cls: 'warn' };
  if (m > 0) return { label: '薄弱', cls: 'bad' };
  return { label: '未练习', cls: '' };
}

/* ---------------- 打卡 / 计时 ----------------
   打卡天数直接由「进度行的 lastAt」推导：
   某天有任意一题的 lastAt 落在该天，即视为当天打卡。
   -------------------------------------------- */
function logAnswer(isRight, ms) {
  LOG_MS += (ms || 0);
}
/** 本次会话累计学习时长（毫秒） */
function totalMs() { return LOG_MS; }

/** 当前用户所有答题日（YYYY-MM-DD）的集合 */
function myDaySet() {
  var set = {};
  DB.questions.forEach(function (q) {
    var p = PROGRESS[q.id];
    if (p && p.lastAt) set[todayStr(new Date(p.lastAt))] = 1;
  });
  return set;
}
function streakDays() {
  var logs = myDaySet(), n = 0, d = new Date();
  // 今天没学不算断（从今天或昨天起算）
  if (!logs[todayStr(d)]) d.setTime(d.getTime() - DAY);
  while (logs[todayStr(d)]) { n++; d.setTime(d.getTime() - DAY); }
  return n;
}
function longestStreak() {
  var keys = Object.keys(myDaySet()).sort();
  if (!keys.length) return 0;
  var best = 1, cur = 1;
  for (var i = 1; i < keys.length; i++) {
    var prev = new Date(keys[i - 1] + 'T00:00:00');
    var now = new Date(keys[i] + 'T00:00:00');
    if (Math.round((now - prev) / DAY) === 1) { cur++; best = Math.max(best, cur); }
    else cur = 1;
  }
  return best;
}

/* ---------------- 工具 ---------------- */
function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function shuffle(a) {
  a = a.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function toast(msg, kind) {
  var box = $('#toast');
  var el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(function () { el.classList.add('on'); });
  setTimeout(function () {
    el.classList.remove('on');
    setTimeout(function () { el.remove(); }, 300);
  }, 1900);
}
function fmtTime(ms) {
  var s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function allTags() {
  var set = {};
  DB.questions.forEach(function (q) { set[q.tag || '未分类'] = 1; });
  return Object.keys(set).sort();
}

/* =========================================================
   认证（用户名 + 密码）
   ========================================================= */
/** 按钮忙碌态，防止重复点击 */
function busy(btn, on, textWhenOn) {
  if (!btn) return;
  if (on) {
    btn.dataset.old = btn.textContent;
    btn.disabled = true;
    if (textWhenOn) btn.textContent = textWhenOn;
  } else {
    btn.disabled = false;
    if (btn.dataset.old) btn.textContent = btn.dataset.old;
  }
}
function errMsg(r) { return (r && r.error) || '操作失败，请稍后重试'; }

/* ---- 密码登录 ---- */
function doLogin(e) {
  e.preventDefault();
  var user = $('#lgUser').value.trim(), pass = $('#lgPass').value;
  if (!user) return toast('请输入用户名', 'no');
  if (!pass) return toast('请输入密码', 'no');
  var btn = $('#loginForm button[type=submit]');
  busy(btn, true, '登录中…');
  Store.signInPassword(user, pass).then(function (r) {
    busy(btn, false);
    if (r.ok === false) return toast(errMsg(r), 'no');
    return afterAuthIn();
  });
}

/* ---- 注册：用户名 + 密码（第一个注册者自动成为管理员） ---- */
function doRegister(e) {
  e.preventDefault();
  var user = $('#rgUser').value.trim();
  var pass = $('#rgPass').value;
  var nick = $('#rgNick').value.trim();
  if (!user) return toast('请输入用户名', 'no');
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/.test(user)) {
    return toast('用户名需 2-20 位，可用中文、字母、数字、下划线', 'no');
  }
  if (pass.length < 6) return toast('密码至少 6 位', 'no');
  var btn = $('#regForm button[type=submit]');
  busy(btn, true, '注册中…');
  Store.register(user, pass, nick).then(function (r) {
    busy(btn, false);
    if (r.ok === false) return toast(errMsg(r), 'no');
    if (r.data && r.data.isFirstAdmin) {
      toast('你是第一个注册的用户，已自动成为管理员', 'ok');
    }
    // 注册成功即登录（后端已下发会话 Cookie）
    return afterAuthIn({ isNew: true });
  });
}

/* ---- 登录成功后的统一收尾 ----
   1) 取当前用户档案（注册时后端已建好）
   2) 拉取题库 + 本人进度
   3) 进入主应用
   --------------------------------- */
function afterAuthIn(opts) {
  opts = opts || {};
  return Store.Profiles.me().then(function (r) {
    if (r.ok === false) throw new Error(errMsg(r));
    if (!r.data) throw new Error('未获取到账号信息，请重新登录');
    return r.data;
  }).then(function (profile) {
    ME = profile;
    return loadCloudData();
  }).then(function () {
    enterApp();
    if (opts.isNew) toast('注册成功，欢迎加入', 'ok');
  }).catch(function (e) {
    console.error('[auth]', e);
    toast('进入失败：' + (e.message || e), 'no');
    ME = null;
    showLogin();
  });
}

function logout() {
  Store.signOut().then(function () {
    ME = null; PROGRESS = {}; DB = null; LOG_MS = 0;
    S.built = false; S.queue = []; S.answered = {};
    closeModal();
    showLogin();
    toast('已退出登录', 'ok');
  });
}
function showLogin() {
  $('#app').classList.remove('on');
  $('#loginWrap').classList.add('on');
  if ($('#lgPass')) $('#lgPass').value = '';
  if ($('#rgPass')) $('#rgPass').value = '';
}
function enterApp() {
  $('#loginWrap').classList.remove('on');
  $('#app').classList.add('on');
  var nm = displayName();
  $('#avatarBtn').textContent = (nm[0] || 'U').toUpperCase();
  $('#avatarBtn').title = nm + '（' + (isAdmin() ? '管理员' : '普通用户') + '）';
  $('#navAdmin').style.display = isAdmin() ? '' : 'none';
  // 权限控制
  $('#btnAddQ').style.display = can('editBank') ? '' : 'none';
  $('#btnImport').style.display = can('editBank') ? '' : 'none';
  $('#btnExportJson').style.display = can('exportData') ? '' : 'none';
  $('#btnExportCsv').style.display = can('exportData') ? '' : 'none';
  $('#loginSub').textContent = 'B 班应知应会 · 智能刷题系统';
  S.built = false;
  refreshAll();
  startTimer();
}

/* =========================================================
   刷题引擎
   ========================================================= */
var S = {
  mode: 'seq', tag: '',
  queue: [], idx: 0, built: false,
  answered: {},        // 本次作答记录
  rightCount: 0, doneCount: 0,
  startAt: Date.now(),
  // 单题会话
  cur: null
};

function buildQueue() {
  var list = DB.questions.slice();
  if (S.mode === 'rand') list = shuffle(list);
  else if (S.mode === 'tag') list = list.filter(function (q) { return q.tag === S.tag; });
  else if (S.mode === 'wrong') {
    var p = myProgress();
    list = list.filter(function (q) { return p[q.id] && p[q.id].wrongFlag; });
  } else if (S.mode === 'fav') {
    var p2 = myProgress();
    list = list.filter(function (q) { return p2[q.id] && p2[q.id].fav; });
  } else if (S.mode === 'due') {
    var now = Date.now();
    var p3 = myProgress();
    list = list.filter(function (q) {
      var pr = p3[q.id];
      return pr && pr.nextAt && pr.nextAt <= now;
    }).sort(function (a, b) { return (p3[a.id].nextAt) - (p3[b.id].nextAt); });
  }
  S.queue = list;
  S.idx = 0;
  S.built = true;
}
function restartSession(keepQueue) {
  if (!keepQueue) buildQueue();
  S.answered = {}; S.rightCount = 0; S.doneCount = 0;
  S.startAt = Date.now();
  S.cur = null;
  renderPractice();
  renderStats();
}

function renderPractice() {
  // 首次进入（队列从未构建过）时自动构建
  if (!S.built) buildQueue();
  S.cur = null;
  var area = $('#qArea');
  var total = S.queue.length;

  // 顶部统计
  $('#sDone').textContent = S.doneCount;
  $('#sTotal').textContent = '共 ' + total + ' 题';
  $('#sAcc').textContent = S.doneCount ? Math.round(S.rightCount / S.doneCount * 100) + '%' : '—';
  $('#sRight').textContent = '正确 ' + S.rightCount + ' 题';
  $('#sDue').textContent = countDue();
  var pct = total ? Math.round(S.idx / total * 100) : 0;
  $('#pBar').style.width = pct + '%';
  $('#pText').textContent = Math.min(S.idx + (S.idx < total ? 1 : 0), total) + ' / ' + total;

  if (!total) {
    area.innerHTML = emptyBox(
      S.mode === 'wrong' ? '错题本是空的，说明你还没答错过题 🎉' :
      S.mode === 'fav' ? '还没有收藏任何题目' :
      S.mode === 'due' ? '暂无到期待复习的题目' :
      S.mode === 'tag' ? '该标签下暂无题目' : '题库为空，请先导入文档或添加题目'
    );
    return;
  }
  if (S.idx >= total) return renderSummary();

  var q = S.queue[S.idx];
  var rec = S.answered[q.id] || null;
  area.innerHTML = qCardHTML(q, rec, 'practice');
  bindQCard(q, rec);
}
function emptyBox(msg) {
  return '<div class="card empty"><div class="big">📭</div><div>' + esc(msg) + '</div></div>';
}

function qCardHTML(q, rec, scope) {
  var p = progOf(q.id);
  var lvl = masteryLevel(masteryOf(q.id));
  var lvlColor = lvl.cls === 'ok' ? 'var(--ok)' : lvl.cls === 'warn' ? 'var(--warn)' : lvl.cls === 'bad' ? 'var(--bad)' : 'var(--text-3)';
  var html = '<div class="card q-card" data-id="' + q.id + '" data-scope="' + scope + '">';
  html += '<div class="q-meta">';
  html += '<span class="badge ' + q.type + '">' + TYPE_LABEL[q.type] + '</span>';
  html += '<span class="tagchip">' + esc(q.tag) + '</span>';
  html += '<span class="muted" style="font-size:12.5px">掌握度 <b style="color:' + lvlColor + '">' + masteryOf(q.id) + '%</b></span>';
  html += '<span class="muted" style="font-size:12.5px">第 ' + (scope === 'practice' ? S.idx + 1 : '—') + ' 题</span>';
  if (q.source) html += '<span class="muted" style="font-size:12.5px">来源：' + esc(q.source) + '</span>';
  html += '</div>';
  html += '<div class="q-stem">' + esc(q.stem) + '</div>';

  if (q.type === 'single' || q.type === 'multi' || q.type === 'judge') {
    html += '<div class="opts">';
    q.options.forEach(function (o, i) {
      var cls = 'opt';
      if (rec) {
        var isAns = q.answer.indexOf(i) >= 0;
        var isSel = rec.picked.indexOf(i) >= 0;
        if (isAns) cls += ' correct';
        else if (isSel) cls += ' wrong';
      } else if (rec === null && S.cur && S.cur[q.id] && S.cur[q.id].indexOf(i) >= 0) {
        cls += ' sel';
      }
      html += '<div class="' + cls + '" data-i="' + i + '">' +
        '<div class="key">' + String.fromCharCode(65 + i) + '</div>' +
        '<div class="txt">' + esc(o) + '</div></div>';
    });
    html += '</div>';
  } else {
    // 填空
    html += '<div class="blank-wrap">';
    if (rec) {
      html += '<div style="width:100%"><b>你的答案：</b><span style="color:' + (rec.right ? 'var(--ok)' : 'var(--bad)') + '">' +
        (rec.pickedText ? esc(rec.pickedText) : '（未作答）') + '</span></div>';
    } else {
      html += '<input class="blank-line" id="fillInput" placeholder="在此输入答案…" style="flex:1;min-width:200px">';
    }
    html += '</div>';
  }

  if (rec) {
    html += '<div class="fb ' + (rec.right ? 'ok' : 'no') + '">';
    html += '<div class="hd">' + (rec.right ? '✅ 回答正确' : '❌ 回答错误') + '</div>';
    var ansTxt = q.type === 'fill'
      ? q.answer.join(' / ')
      : q.answer.map(function (i) { return String.fromCharCode(65 + i) + '. ' + q.options[i]; }).join('；');
    html += '<div><b>正确答案：</b>' + esc(ansTxt) + '</div>';
    if (q.explain) html += '<div style="margin-top:6px"><b>解析：</b>' + esc(q.explain) + '</div>';
    html += '</div>';
  }

  html += '<div class="actions">';
  if (!rec) {
    html += '<button class="btn btn-primary" data-act="submit" style="min-width:110px">提交答案</button>';
    if (q.type === 'multi' || q.type === 'single' || q.type === 'judge')
      html += '<span class="muted" style="font-size:12.5px">' + (q.type === 'multi' ? '可多选，选好后点提交' : '选择一个选项') + '</span>';
    else html += '<span class="muted" style="font-size:12.5px">答案支持多个写法，用「/」分隔</span>';
  } else {
    if (S.idx < S.queue.length - 1)
      html += '<button class="btn btn-primary" data-act="next" style="min-width:110px">下一题 →</button>';
    else
      html += '<button class="btn btn-primary" data-act="next" style="min-width:110px">查看本场总结 →</button>';
    if (S.idx > 0) html += '<button class="btn" data-act="prev">← 上一题</button>';
  }
  html += '<span class="spacer"></span>';
  html += '<button class="icon-btn ' + (p.fav ? 'on' : '') + '" data-act="fav" title="收藏">' + (p.fav ? '★' : '☆') + '</button>';
  html += '<button class="btn btn-sm" data-act="edit" title="编辑此题">编辑</button>';
  html += '</div></div>';
  return html;
}

function bindQCard(q, rec) {
  var card = $('#qArea .q-card');
  if (!card) return;
  var picked = [];

  // 选项点击
  $$('.opt', card).forEach(function (el) {
    el.addEventListener('click', function () {
      if (rec) return;
      var i = +el.dataset.i;
      if (q.type === 'multi') {
        var k = picked.indexOf(i);
        if (k >= 0) picked.splice(k, 1); else picked.push(i);
      } else {
        picked = [i];
      }
      $$('.opt', card).forEach(function (o) {
        o.classList.toggle('sel', picked.indexOf(+o.dataset.i) >= 0);
      });
    });
  });

  $$('[data-act]', card).forEach(function (btn) {
    btn.addEventListener('click', function () {
      var act = btn.dataset.act;
      if (act === 'submit') {
        var fi = $('#fillInput', card);
        return submitAnswer(q, picked, fi ? fi.value : '');
      }
      if (act === 'next') { S.idx++; renderPractice(); return; }
      if (act === 'prev') { S.idx = Math.max(0, S.idx - 1); renderPractice(); return; }
      if (act === 'fav') {
        var p = progOf(q.id);
        p.fav = !p.fav; persistProg(q.id);
        btn.classList.toggle('on', p.fav);
        btn.textContent = p.fav ? '★' : '☆';
        toast(p.fav ? '已加入收藏' : '已取消收藏', 'ok');
        renderFav(); updateBankRow(q.id);
        return;
      }
      if (act === 'edit') return openQuestionEditor(q);
    });
  });

  // 填空回车提交
  var fi = $('#fillInput', card);
  if (fi) fi.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submitAnswer(q, [], fi.value); }
  });
}

function normalizeFill(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[\s，。；、,.\-—＝=（）()：:]/g, '')
    .replace(/／/g, '/');
}
function checkFill(q, text) {
  var got = normalizeFill(text);
  if (!got) return false;
  return q.answer.some(function (a) {
    var t = normalizeFill(a);
    if (!t) return false;
    return got === t || got.indexOf(t) >= 0 || t.indexOf(got) >= 0;
  });
}
function sameSet(a, b) {
  if (a.length !== b.length) return false;
  return a.every(function (x) { return b.indexOf(x) >= 0; });
}

function submitAnswer(q, picked, fillText) {
  var isRight;
  if (q.type === 'fill') {
    isRight = checkFill(q, fillText);
    if (!fillText || !String(fillText).trim()) return toast('请先填写答案', 'no');
    picked = [];
  } else {
    if (!picked.length) return toast('请先选择答案', 'no');
    picked = picked.slice().sort(function (a, b) { return a - b; });
    isRight = sameSet(picked, q.answer.slice().sort(function (a, b) { return a - b; }));
  }

  var p = progOf(q.id);
  if (isRight) {
    p.right++; p.streak++; p.wrongFlag = false;
    // 间隔重复：答对推进一级
    var step = Math.min(p.streak, SRS_STEPS.length) - 1;
    if (step < 0) step = 0;
    p.nextAt = Date.now() + SRS_STEPS[step] * DAY;
  } else {
    p.wrong++; p.streak = 0; p.wrongFlag = true;
    p.nextAt = Date.now() + DAY * 0.5; // 半天后复习
  }
  p.lastAt = Date.now();
  p.mastery = masteryOf(q.id);

  S.answered[q.id] = { picked: picked, pickedText: fillText || '', right: isRight };
  S.doneCount++;
  if (isRight) { S.rightCount++; toast('回答正确 ✅', 'ok'); }
  else toast('回答错误，已记入错题本', 'no');

  logAnswer(isRight, 0);
  persistProg(q.id);
  renderPractice();
  renderWrong(); renderFav(); updateBankRow(q.id);
  updateStreakPill(); renderStats();
}

function renderSummary() {
  var total = S.doneCount;
  var acc = total ? Math.round(S.rightCount / total * 100) : 0;
  var wrongIds = Object.keys(S.answered).filter(function (id) { return !S.answered[id].right; });
  var html = '<div class="card q-card" style="text-align:center;padding:40px 24px">';
  html += '<div style="font-size:52px;margin-bottom:8px">' + (acc >= 80 ? '🎉' : acc >= 60 ? '💪' : '📖') + '</div>';
  html += '<h2 style="margin:0 0 6px;font-size:23px">本场练习完成</h2>';
  html += '<div class="muted" style="margin-bottom:22px">用时 ' + fmtTime(Date.now() - S.startAt) + '</div>';
  html += '<div class="stat-grid" style="max-width:560px;margin:0 auto 22px">';
  html += '<div class="card stat"><div class="k">答题数</div><div class="v">' + total + '</div></div>';
  html += '<div class="card stat"><div class="k">正确率</div><div class="v" style="color:' + (acc >= 80 ? 'var(--ok)' : acc >= 60 ? 'var(--warn)' : 'var(--bad)') + '">' + acc + '<small>%</small></div></div>';
  html += '<div class="card stat"><div class="k">答对</div><div class="v">' + S.rightCount + '</div></div>';
  html += '<div class="card stat"><div class="k">答错</div><div class="v">' + (total - S.rightCount) + '</div></div>';
  html += '</div>';
  html += '<div class="actions" style="justify-content:center">';
  if (wrongIds.length) html += '<button class="btn btn-primary" id="sumRedo" data-ids="' + wrongIds.join(',') + '">重练本场错题（' + wrongIds.length + '）</button>';
  html += '<button class="btn" id="sumRestart">再来一轮</button>';
  html += '<button class="btn" id="sumDone">返回</button>';
  html += '</div></div>';
  $('#qArea').innerHTML = html;
  $('#pBar').style.width = '100%';
  $('#pText').textContent = total + ' / ' + total;

  var r = $('#sumRedo');
  if (r) r.addEventListener('click', function () {
    var ids = r.dataset.ids.split(',');
    S.queue = DB.questions.filter(function (x) { return ids.indexOf(x.id) >= 0; });
    S.mode = 'wrong'; S.idx = 0; S.answered = {}; S.rightCount = 0; S.doneCount = 0; S.startAt = Date.now();
    $$('#modeSeg button').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === 'wrong'); });
    renderPractice();
  });
  $('#sumRestart').addEventListener('click', function () { restartSession(false); });
  $('#sumDone').addEventListener('click', function () { restartSession(false); });
}

function startTimer() {
  if (startTimer._t) return;
  startTimer._t = setInterval(function () {
    if (!ME) return;
    if ($('#page-practice').classList.contains('on')) {
      $('#sTime').textContent = fmtTime(Date.now() - S.startAt);
    }
  }, 1000);
}
function countDue() {
  var now = Date.now(), p = myProgress(), n = 0;
  DB.questions.forEach(function (q) {
    var pr = p[q.id];
    if (pr && pr.nextAt && pr.nextAt <= now) n++;
  });
  return n;
}
function updateStreakPill() {
  $('#streakNum').textContent = ME ? streakDays() : 0;
}

/* =========================================================
   错题本 / 收藏
   ========================================================= */
function renderWrong() {
  var p = myProgress();
  var list = DB.questions.filter(function (q) { return p[q.id] && p[q.id].wrongFlag; })
    .sort(function (a, b) { return (p[b.id].lastAt || 0) - (p[a.id].lastAt || 0); });
  $('#wrongSub').textContent = '共 ' + list.length + ' 题 · 连续答对 2 次自动移出';
  var box = $('#wrongList');
  if (!list.length) return box.innerHTML = '<div class="card empty"><div class="big">🎯</div><div>错题本是空的，说明你还没答错过题</div></div>';
  box.innerHTML = list.map(function (q) {
    var pr = p[q.id];
    return '<div class="card q-item" data-id="' + q.id + '"><div class="body">' +
      '<div class="stem">' + esc(q.stem) + '</div>' +
      '<div class="meta"><span class="badge ' + q.type + '">' + TYPE_LABEL[q.type] + '</span>' +
      '<span class="tagchip">' + esc(q.tag) + '</span>' +
      '<span style="color:var(--bad)">错 ' + pr.wrong + ' 次</span>' +
      '<span style="color:var(--ok)">连对 ' + pr.streak + ' / 2</span></div>' +
      '</div><div class="ops"><button class="icon-btn" data-o="view" title="查看解析">👁</button>' +
      '<button class="icon-btn" data-o="del" title="移出错题本">✓</button></div></div>';
  }).join('');
  bindListItem(box);
}
function renderFav() {
  var p = myProgress();
  var list = DB.questions.filter(function (q) { return p[q.id] && p[q.id].fav; });
  $('#favSub').textContent = '共 ' + list.length + ' 题';
  var box = $('#favList');
  if (!list.length) return box.innerHTML = '<div class="card empty"><div class="big">☆</div><div>还没有收藏任何题目</div></div>';
  box.innerHTML = list.map(function (q) {
    return '<div class="card q-item" data-id="' + q.id + '"><div class="body">' +
      '<div class="stem">' + esc(q.stem) + '</div>' +
      '<div class="meta"><span class="badge ' + q.type + '">' + TYPE_LABEL[q.type] + '</span>' +
      '<span class="tagchip">' + esc(q.tag) + '</span>' +
      '<span>掌握度 ' + masteryOf(q.id) + '%</span></div>' +
      '</div><div class="ops"><button class="icon-btn" data-o="view" title="查看">👁</button>' +
      '<button class="icon-btn on" data-o="unfav" title="取消收藏">★</button></div></div>';
  }).join('');
  bindListItem(box);
}
function bindListItem(box) {
  $$('.q-item', box).forEach(function (item) {
    var id = item.dataset.id;
    var q = DB.questions.filter(function (x) { return x.id === id; })[0];
    $$('[data-o]', item).forEach(function (b) {
      b.addEventListener('click', function () {
        var o = b.dataset.o;
        if (o === 'view') return showAnswerModal(q);
        var p = progOf(id);
        if (o === 'del') { p.wrongFlag = false; toast('已移出错题本', 'ok'); }
        if (o === 'unfav') { p.fav = false; toast('已取消收藏', 'ok'); }
        persistProg(id); renderWrong(); renderFav(); updateBankRow(id);
      });
    });
  });
}
function showAnswerModal(q) {
  var ansTxt = q.type === 'fill' ? q.answer.join(' / ')
    : q.answer.map(function (i) { return String.fromCharCode(65 + i) + '. ' + q.options[i]; }).join('；');
  openModal('题目详情', 
    '<div class="q-stem" style="font-size:16px">' + esc(q.stem) + '</div>' +
    (q.options.length ? '<div class="opts" style="margin-bottom:14px">' + q.options.map(function (o, i) {
      return '<div class="opt' + (q.answer.indexOf(i) >= 0 ? ' correct' : '') + '"><div class="key">' +
        String.fromCharCode(65 + i) + '</div><div class="txt">' + esc(o) + '</div></div>';
    }).join('') + '</div>' : '') +
    '<div class="fb ok"><div class="hd">正确答案</div><div>' + esc(ansTxt) + '</div>' +
    (q.explain ? '<div style="margin-top:8px"><b>解析：</b>' + esc(q.explain) + '</div>' : '') + '</div>',
    [{ label: '关闭', cls: 'btn' }]
  );
}

/* =========================================================
   卡片背诵
   ========================================================= */
var F = { list: [], i: 0, tag: '' };
function buildFlash() {
  var list = DB.questions.slice();
  if (F.tag) list = list.filter(function (q) { return q.tag === F.tag; });
  F.list = list; F.i = 0; renderFlash();
}
function renderFlash() {
  var q = F.list[F.i];
  $('#flipCard').classList.remove('flipped');
  if (!q) {
    $('#flashFront').textContent = '暂无卡片';
    $('#flashBack').textContent = '—';
    $('#flashPos').textContent = '0 / 0';
    return;
  }
  $('#flashFront').textContent = q.stem;
  var ansTxt = q.type === 'fill' ? q.answer.join(' / ')
    : q.answer.map(function (i) { return String.fromCharCode(65 + i) + '. ' + q.options[i]; }).join('\n');
  $('#flashBack').textContent = ansTxt + (q.explain ? '\n\n—— 解析 ——\n' + q.explain : '');
  $('#flashPos').textContent = (F.i + 1) + ' / ' + F.list.length;
}

/* =========================================================
   填空默写
   ========================================================= */
var D = { list: [], tag: '' };
function buildDictation() {
  var list = DB.questions.slice();
  if (D.tag) list = list.filter(function (q) { return q.tag === D.tag; });
  D.list = list;
  var box = $('#dictArea');
  if (!list.length) return box.innerHTML = emptyBox('该标签下暂无题目');
  box.innerHTML = list.map(function (q, n) {
    return '<div class="card q-item" data-id="' + q.id + '" style="flex-direction:column;align-items:stretch">' +
      '<div class="meta" style="margin-bottom:8px"><span class="tagchip">' + esc(q.tag) + '</span>' +
      '<span class="muted">第 ' + (n + 1) + ' 题</span></div>' +
      '<div class="stem" style="font-weight:600;margin-bottom:10px">' + esc(q.stem) + '</div>' +
      '<input class="input" placeholder="写下你的答案…" style="margin-bottom:8px">' +
      '<div class="actions" style="margin-top:4px">' +
      '<button class="btn btn-sm btn-primary" data-d="check">核对</button>' +
      '<button class="btn btn-sm" data-d="show">看答案</button></div>' +
      '<div class="fb" style="display:none;margin-top:12px"></div></div>';
  }).join('');

  $$('#dictArea .q-item').forEach(function (item) {
    var q = DB.questions.filter(function (x) { return x.id === item.dataset.id; })[0];
    var inp = $('input', item), fb = $('.fb', item);
    var ansTxt = q.type === 'fill' ? q.answer.join(' / ')
      : q.answer.map(function (i) { return String.fromCharCode(65 + i) + '. ' + q.options[i]; }).join('；');
    function reveal(ok) {
      fb.style.display = '';
      fb.className = 'fb ' + (ok === null ? '' : ok ? 'ok' : 'no');
      fb.style.borderLeftColor = ok === null ? 'var(--brand)' : ok ? 'var(--ok)' : 'var(--bad)';
      fb.style.background = ok === null ? 'var(--brand-soft)' : ok ? 'var(--ok-soft)' : 'var(--bad-soft)';
      fb.innerHTML = (ok === null ? '' : '<div class="hd">' + (ok ? '✅ 正确' : '❌ 有出入') + '</div>') +
        '<div><b>参考答案：</b>' + esc(ansTxt) + '</div>' +
        (q.explain ? '<div style="margin-top:6px"><b>解析：</b>' + esc(q.explain) + '</div>' : '');
    }
    $('[data-d="check"]', item).addEventListener('click', function () {
      if (!inp.value.trim()) return toast('请先写下答案', 'no');
      var ok = q.type === 'fill'
        ? checkFill(q, inp.value)
        : q.options.some(function (o, i) {
            return q.answer.indexOf(i) >= 0 && normalizeFill(o) === normalizeFill(inp.value);
          });
      reveal(ok);
      var p = progOf(q.id);
      if (ok) { p.right++; p.streak++; p.wrongFlag = p.streak >= 2 ? false : p.wrongFlag; }
      else { p.wrong++; p.streak = 0; p.wrongFlag = true; }
      p.lastAt = Date.now(); p.mastery = masteryOf(q.id);
      logAnswer(ok, 0); persistProg(q.id); updateStreakPill();
    });
    $('[data-d="show"]', item).addEventListener('click', function () { reveal(null); });
  });
}

/* =========================================================
   知识点速览
   ========================================================= */
function renderOverview(kw) {
  var map = {};
  DB.questions.forEach(function (q) {
    if (!q.explain) return;
    var k = q.tag || '未分类';
    (map[k] = map[k] || []).push(q);
  });
  var html = '';
  Object.keys(map).sort().forEach(function (tag) {
    var items = map[tag].filter(function (q) {
      if (!kw) return true;
      return (q.stem + q.explain + tag).toLowerCase().indexOf(kw.toLowerCase()) >= 0;
    });
    if (!items.length) return;
    html += '<div class="card kb-card"><h4>' + esc(tag) + ' <span class="muted" style="font-weight:400;font-size:12px">' + items.length + ' 条</span></h4>';
    items.forEach(function (q) {
      html += '<p><b>' + esc(q.stem.replace(/[？?]$/, '')) + '</b><br>' + esc(q.explain) + '</p>';
    });
    html += '</div>';
  });
  $('#kbGrid').innerHTML = html || '<div class="card empty"><div class="big">🔍</div><div>没有匹配的知识点</div></div>';
}

/* =========================================================
   题库管理
   ========================================================= */
var BK = { page: 1, size: 30, kw: '', tag: '', type: '' };
function filteredQuestions() {
  var kw = BK.kw.toLowerCase();
  return DB.questions.filter(function (q) {
    if (BK.tag && q.tag !== BK.tag) return false;
    if (BK.type && q.type !== BK.type) return false;
    if (kw) {
      var hay = (q.stem + ' ' + (q.options || []).join(' ') + ' ' + (q.answer || []).join(' ') + ' ' + q.tag + ' ' + q.explain).toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  });
}
function renderBank() {
  var list = filteredQuestions();
  $('#bankSub').textContent = '共 ' + DB.questions.length + ' 题' + (list.length !== DB.questions.length ? '（筛选出 ' + list.length + ' 题）' : '');
  var show = list.slice(0, BK.page * BK.size);
  var box = $('#bankList');
  if (!show.length) {
    box.innerHTML = emptyBox('没有符合条件的题目');
    $('#bankMore').style.display = 'none';
    return;
  }
  var p = myProgress();
  box.innerHTML = show.map(function (q) {
    var pr = p[q.id] || {};
    return '<div class="card q-item" data-id="' + q.id + '"><div class="body">' +
      '<div class="stem">' + esc(q.stem) + '</div>' +
      '<div class="meta"><span class="badge ' + q.type + '">' + TYPE_LABEL[q.type] + '</span>' +
      '<span class="tagchip">' + esc(q.tag) + '</span>' +
      '<span>掌握度 ' + masteryOf(q.id) + '%</span>' +
      (pr.right || pr.wrong ? '<span>对 ' + (pr.right || 0) + ' / 错 ' + (pr.wrong || 0) + '</span>' : '<span class="muted">未练习</span>') +
      (q.source ? '<span class="muted">' + esc(q.source) + '</span>' : '') + '</div></div>' +
      '<div class="ops"><button class="icon-btn" data-o="view" title="预览">👁</button>' +
      (can('editBank') ? '<button class="icon-btn" data-o="edit" title="编辑">✎</button>' +
        '<button class="icon-btn" data-o="del" title="删除">🗑</button>' : '') +
      '</div></div>';
  }).join('');
  $('#bankMore').style.display = show.length < list.length ? '' : 'none';

  $$('#bankList .q-item').forEach(function (item) {
    var id = item.dataset.id;
    var q = DB.questions.filter(function (x) { return x.id === id; })[0];
    $$('[data-o]', item).forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.o === 'view') return showAnswerModal(q);
        if (b.dataset.o === 'edit') return openQuestionEditor(q);
        if (b.dataset.o === 'del') {
          if (!confirm('确定删除此题？\n\n' + q.stem.slice(0, 60) + '…')) return;
          Store.Bank.remove(id).then(function (r) {
            if (r.ok === false) return toast('删除失败：' + r.error, 'no');
            DB.questions = DB.questions.filter(function (x) { return x.id !== id; });
            delete PROGRESS[id];
            renderBank(); refreshAll(); toast('已删除', 'ok');
          });
        }
      });
    });
  });
}
function updateBankRow() { /* 简单起见，整表刷新由调用处触发 */ }

/* ---------------- 题目编辑器 ---------------- */
function openQuestionEditor(q) {
  if (!can('editBank')) return toast('你没有题库编辑权限', 'no');
  var isNew = !q;
  q = q || { type: 'single', stem: '', options: ['', '', '', ''], answer: [], explain: '', tag: '' };
  var tags = allTags();
  var body =
    '<label class="fld"><span>题型</span><select class="select" id="edType">' +
    ['single', 'multi', 'judge', 'fill'].map(function (t) {
      return '<option value="' + t + '"' + (q.type === t ? ' selected' : '') + '>' + TYPE_LABEL[t] + '</option>';
    }).join('') + '</select></label>' +
    '<label class="fld"><span>知识点 / 标签</span><input class="input" id="edTag" list="tagList" value="' + esc(q.tag) + '" placeholder="如：电气基础">' +
    '<datalist id="tagList">' + tags.map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist></label>' +
    '<label class="fld"><span>题干</span><textarea class="textarea" id="edStem" placeholder="请输入题干">' + esc(q.stem) + '</textarea></label>' +
    '<div id="edOptWrap" style="display:' + (q.type === 'fill' ? 'none' : '') + '">' +
    '<div style="font-size:13px;font-weight:600;color:var(--text-2);margin-bottom:6px">选项（勾选正确答案）</div>' +
    '<div id="edOpts"></div>' +
    '<button class="btn btn-sm" id="edAddOpt" style="margin-top:6px">＋ 添加选项</button>' +
    '<p class="muted" style="margin:8px 0 0;font-size:12.5px">判断题固定为「对 / 错」两个选项。</p></div>' +
    '<label class="fld" style="margin-top:14px"><span>填空答案（多个答案用「/」分隔）</span>' +
    '<input class="input" id="edFill" value="' + esc(q.type === 'fill' ? q.answer.join('/') : '') + '" placeholder="如：250 / 二百五"></label>' +
    '<label class="fld"><span>解析</span><textarea class="textarea" id="edExp" placeholder="答题解析（会展示给答题者）">' + esc(q.explain) + '</textarea></label>';

  openModal(isNew ? '添加题目' : '编辑题目', body, [
    { label: '取消', cls: 'btn' },
    { label: '保存', cls: 'btn btn-primary', keep: true, onClick: function () { doSaveQuestion(q, isNew); } }
  ]);

  function drawOpts() {
    var type = $('#edType').value;
    if (type === 'judge') {
      $('#edOpts').innerHTML = ['对', '错'].map(function (t, i) {
        return optRow(t, i, q.answer.indexOf(i) >= 0);
      }).join('');
      $('#edAddOpt').style.display = 'none';
    } else {
      $('#edOpts').innerHTML = q.options.map(function (o, i) { return optRow(o, i, q.answer.indexOf(i) >= 0); }).join('');
      $('#edAddOpt').style.display = '';
    }
    bindOpts();
  }
  function optRow(v, i, checked) {
    return '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px" data-row="' + i + '">' +
      '<input type="checkbox" class="edChk" ' + (checked ? 'checked' : '') + ' style="width:17px;height:17px;flex:none">' +
      '<input class="input edOptTxt" value="' + esc(v) + '" placeholder="选项 ' + String.fromCharCode(65 + i) + '">' +
      '<button class="icon-btn edDelOpt" style="flex:none" title="删除">✕</button></div>';
  }
  function bindOpts() {
    $$('.edDelOpt', $('#edOpts')).forEach(function (b) {
      b.addEventListener('click', function () {
        var i = +b.closest('[data-row]').dataset.row;
        syncFromUI(); q.options.splice(i, 1);
        q.answer = q.answer.filter(function (x) { return x !== i; })
          .map(function (x) { return x > i ? x - 1 : x; });
        drawOpts();
      });
    });
  }
  function syncFromUI() {
    if ($('#edType').value === 'fill') return;
    var rows = $$('[data-row]', $('#edOpts'));
    q.options = rows.map(function (r) { return $('.edOptTxt', r).value; });
    q.answer = [];
    rows.forEach(function (r, i) { if ($('.edChk', r).checked) q.answer.push(i); });
  }
  $('#edType').addEventListener('change', function () {
    syncFromUI();
    var t = $('#edType').value;
    if (t === 'judge') { q.options = ['对', '错']; q.answer = [0]; }
    else if (q.options.length < 2 || t === 'fill') { q.options = ['', '', '', '']; q.answer = []; }
    q.type = t;
    $('#edOptWrap').style.display = t === 'fill' ? 'none' : '';
    drawOpts();
  });
  $('#edAddOpt').addEventListener('click', function () {
    syncFromUI(); q.options.push(''); drawOpts();
  });
  drawOpts();
}
function doSaveQuestion(q, isNew) {
  var type = $('#edType').value;
  var stem = $('#edStem').value.trim();
  var tag = $('#edTag').value.trim() || '未分类';
  var explain = $('#edExp').value.trim();
  if (!stem) return toast('题干不能为空', 'no');

  var options = [], answer = [];
  if (type === 'fill') {
    answer = $('#edFill').value.split('/').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!answer.length) return toast('请至少填写一个填空答案', 'no');
  } else {
    var rows = $$('[data-row]', $('#edOpts'));
    options = rows.map(function (r) { return $('.edOptTxt', r).value.trim(); });
    rows.forEach(function (r, i) { if ($('.edChk', r).checked) answer.push(i); });
    if (options.filter(Boolean).length < 2) return toast('至少需要 2 个有效选项', 'no');
    if (!answer.length) return toast('请勾选正确答案', 'no');
    if (type === 'single' && answer.length > 1) return toast('单选题只能有一个正确答案', 'no');
    if (type === 'judge') { options = ['对', '错']; }
  }

  if (isNew) {
    var nq = {
      id: newQid(), type: type, stem: stem, options: options, answer: answer,
      explain: explain, tag: tag, source: '手动添加', createdAt: Date.now()
    };
    Store.Bank.insert([nq]).then(function (r) {
      if (r.ok === false) return toast('添加失败：' + r.error, 'no');
      DB.questions.unshift(nq);
      toast('题目已添加', 'ok');
      closeModal(); refreshAfterBankChange();
    });
  } else {
    var patch = { type: type, stem: stem, options: options, answer: answer, explain: explain, tag: tag };
    Store.Bank.update(q.id, patch).then(function (r) {
      if (r.ok === false) return toast('保存失败：' + r.error, 'no');
      for (var k in patch) q[k] = patch[k];
      toast('已保存', 'ok');
      closeModal(); refreshAfterBankChange();
    });
  }
}
function refreshAfterBankChange() {
  renderBank(); renderWrong(); renderFav(); renderOverview($('#ovSearch').value);
  fillTagSelects(); buildFlash(); buildDictation(); renderStats();
}

/* =========================================================
   导入 / 导出
   ========================================================= */
function openImport() {
  if (!can('editBank')) return toast('你没有题库编辑权限', 'no');
  var body =
    '<p class="muted" style="margin:0 0 12px;line-height:1.8">' +
    '支持 <b>txt / md / csv / json</b> 直接解析；<b>pdf / docx</b> 会自动尝试提取文本（纯前端尽力而为，格式复杂时建议先复制为 txt）。<br>' +
    '解析后会按「问 / 答」结构自动生成题目，你也可以直接粘贴文本。</p>' +
    '<label class="fld"><span>上传文件</span><input type="file" class="input" id="impFile" accept=".txt,.md,.csv,.json,.pdf,.docx,.doc"></label>' +
    '<label class="fld"><span>或直接粘贴内容</span><textarea class="textarea" id="impText" style="min-height:160px" placeholder="每行一题，支持以下格式：&#10;1. 题干？ | 答案&#10;题干？&#10;答案：xxx&#10;Q: 题干&#10;A: 答案&#10;（也支持 CSV：题干,答案 / Markdown 表格）"></textarea></label>' +
    '<label class="fld"><span>统一标签（留空则自动识别）</span><input class="input" id="impTag" placeholder="如：电气基础"></label>' +
    '<div id="impPreview" class="muted" style="margin-top:8px"></div>';
  openModal('导入文档生成题目', body, [
    { label: '取消', cls: 'btn' },
    { label: '解析预览', cls: 'btn btn-primary', keep: true, onClick: doImportParse },
    { label: '确认导入', cls: 'btn btn-primary', keep: true, onClick: doImportCommit }
  ]);
  $('#impFile').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    readFileSmart(f).then(function (txt) {
      $('#impText').value = txt;
      toast('已读取 ' + f.name + '（' + txt.length + ' 字）', 'ok');
    }).catch(function (err) { toast(err.message || '读取失败', 'no'); });
  });
}
function readFileSmart(file) {
  return new Promise(function (resolve, reject) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'docx') return readDocx(file).then(resolve, reject);
    if (ext === 'pdf') return readPdf(file).then(resolve, reject);
    var fr = new FileReader();
    fr.onload = function () { resolve(String(fr.result)); };
    fr.onerror = function () { reject(new Error('文件读取失败')); };
    fr.readAsText(file, 'UTF-8');
  });
}
/* --- docx：解压 word/document.xml 提取 <w:t> --- */
function readDocx(file) {
  return new Promise(function (resolve, reject) {
    file.arrayBuffer().then(function (buf) {
      if (typeof DecompressionStream === 'undefined') {
        return reject(new Error('当前浏览器不支持解压 docx，请另存为 txt 后导入'));
      }
      // 在 zip 中定位 word/document.xml
      var bytes = new Uint8Array(buf);
      var name = new TextEncoder().encode('word/document.xml');
      var pos = indexOfBytes(bytes, name);
      if (pos < 0) return reject(new Error('未找到文档正文（docx 结构异常）'));
      // 从 local file header 解析压缩数据
      var lh = pos;
      while (lh >= 4 && !(bytes[lh - 4] === 0x50 && bytes[lh - 3] === 0x4b && bytes[lh - 2] === 0x03 && bytes[lh - 1] === 0x04)) lh--;
      if (lh < 4) return reject(new Error('docx 解析失败'));
      var start = lh - 4;
      var dv = new DataView(buf, start);
      var method = dv.getUint16(8, true);
      var compSize = dv.getUint32(18, true);
      var nameLen = dv.getUint16(26, true);
      var extraLen = dv.getUint16(28, true);
      var dataStart = start + 30 + nameLen + extraLen;
      if (!compSize) return reject(new Error('docx 压缩信息缺失，请另存为 txt'));
      var comp = bytes.slice(dataStart, dataStart + compSize);

      if (method === 0) return resolve(xmlToText(new TextDecoder().decode(comp)));

      var ds = new DecompressionStream('deflate-raw');
      var stream = new Blob([comp]).stream().pipeThrough(ds);
      new Response(stream).arrayBuffer().then(function (out) {
        resolve(xmlToText(new TextDecoder('utf-8').decode(out)));
      }).catch(function () { reject(new Error('docx 解压失败，请另存为 txt 后导入')); });
    }).catch(reject);
  });
}
function indexOfBytes(hay, needle) {
  outer: for (var i = 0; i <= hay.length - needle.length; i++) {
    for (var j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
function xmlToText(xml) {
  var out = [];
  // 段落按 </w:p> 切分
  var paras = xml.split(/<\/w:p>/);
  paras.forEach(function (p) {
    var txt = '';
    var re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g, m;
    while ((m = re.exec(p))) txt += m[1];
    // 表格单元格用制表符分隔
    if (/<w:tc[ >]/.test(p)) {
      txt = p.split(/<\/w:tc>/).map(function (c) {
        var t = '', r2 = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g, m2;
        while ((m2 = r2.exec(c))) t += m2[1];
        return t;
      }).join('\t');
    }
    txt = decodeXml(txt).trim();
    if (txt) out.push(txt);
  });
  return out.join('\n');
}
function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
/* --- pdf：抽取 ( ) 中的文本 --- */
function readPdf(file) {
  return new Promise(function (resolve, reject) {
    file.arrayBuffer().then(function (buf) {
      var raw = new Uint8Array(buf);
      var latin = '';
      for (var i = 0; i < raw.length; i++) latin += String.fromCharCode(raw[i]);
      var out = [];
      // 优先解析 PDF 文本流（未压缩的 Tj/TJ 运算符）
      var re = /\((?:\\.|[^\\()])*\)\s*Tj|\[(?:[^\]]*)\]\s*TJ/g, m;
      while ((m = re.exec(latin))) {
        var seg = m[0];
        var parts = seg.match(/\((?:\\.|[^\\()])*\)/g) || [];
        var line = parts.map(function (s) {
          return s.slice(1, -1).replace(/\\([()\\])/g, '$1').replace(/\\n/g, ' ');
        }).join('');
        if (line.trim()) out.push(line);
      }
      var text = out.join('\n').trim();
      if (text.length < 20) {
        return reject(new Error('该 PDF 可能是扫描件或已压缩，无法直接解析。请用「另存为文本」或复制内容后粘贴导入'));
      }
      resolve(text);
    }).catch(reject);
  });
}

/* --- 解析文本为题目 --- */
var lastParsed = [];
function parseTextToQuestions(text, tagHint) {
  var out = [];
  if (!text || !text.trim()) return out;
  var t = text.replace(/\r\n?/g, '\n');

  // JSON
  if (/^\s*[\[{]/.test(t)) {
    try {
      var j = JSON.parse(t);
      var arr = Array.isArray(j) ? j : (j.questions || []);
      arr.forEach(function (x) {
        if (!x || !(x.stem || x.question || x.q)) return;
        out.push(normalizeImported(x, tagHint));
      });
      if (out.length) return out;
    } catch (e) { /* 继续按文本解析 */ }
  }

  // 先按 2 列结构（表格 / CSV / 问答配对）识别
  var lines = t.split('\n');
  var pairs = [];

  // Markdown 表格
  if (/\|/.test(t) && /^\s*\|?[\s:-]+\|/m.test(t)) {
    lines.forEach(function (ln) {
      if (!/\|/.test(ln)) return;
      var cells = ln.split('|').map(function (c) { return c.trim(); }).filter(function (c, i, a) { return !(i === 0 && !c) && !(i === a.length - 1 && !c); });
      if (cells.length >= 2 && !/^[\s:-]*$/.test(cells[0])) pairs.push([cells[0], cells.slice(1).join(' ')]);
    });
  }
  // CSV / 制表符
  if (!pairs.length && (/[,\t]/.test(t))) {
    lines.forEach(function (ln) {
      var cells = ln.split(ln.indexOf('\t') >= 0 ? '\t' : ',').map(function (c) { return c.replace(/^"|"$/g, '').trim(); });
      if (cells.length >= 2 && cells[0] && cells[1] && !/^(问题|题干|question)$/i.test(cells[0])) pairs.push([cells[0], cells[1]]);
    });
  }
  // "Q:/A:" 与 "问/答" 结构
  if (!pairs.length) pairs = extractQAPairs(lines);
  // "n. 题干？ 答案" 单行结构
  if (!pairs.length) pairs = extractInline(lines);
  // "题干？\n答案xxx" 两行结构
  if (!pairs.length) pairs = extractTwoLine(lines);

  pairs.forEach(function (pr) {
    var q = pr[0], a = pr[1];
    if (!q || !a) return;
    q = q.replace(/^\s*(\d+[.、)]|[-*•])\s*/, '').trim();
    a = a.replace(/^\s*答[案:：]?\s*/, '').replace(/^[A-D][.、]\s*/, '').trim();
    if (q.length < 4 || a.length < 1) return;
    if (/^(问题|题干|答案|question|answer)$/i.test(q)) return;
    out.push(buildFromQA(q, a, tagHint));
  });
  return out;
}
function extractQAPairs(lines) {
  var pairs = [], cur = null;
  lines.forEach(function (ln) {
    var m1 = ln.match(/^\s*(?:Q|问)\s*[:：.]\s*(.+)$/i);
    var m2 = ln.match(/^\s*(?:A|答)\s*[:：.]\s*(.+)$/i);
    if (m1) { if (cur) pairs.push(cur); cur = [m1[1].trim(), '']; }
    else if (m2 && cur) { cur[1] = m2[1].trim(); pairs.push(cur); cur = null; }
    else if (cur && ln.trim() && !m2) { cur[0] += ' ' + ln.trim(); }
  });
  if (cur) pairs.push(cur);
  return pairs.filter(function (p) { return p[0] && p[1]; });
}
function extractInline(lines) {
  var pairs = [];
  lines.forEach(function (ln) {
    var s = ln.trim();
    if (s.length < 8) return;
    // n. 题干？ 答案
    var m = s.match(/^(?:\d+[.、)]|[-*•])?\s*(.{4,}?[？?])\s*[:：]?\s*(.{1,})$/)
      || s.match(/^(.{4,}?)\s*[|｜]\s*(.{1,})$/);
    if (m && m[2] && m[1] !== m[2]) pairs.push([m[1], m[2]]);
  });
  return pairs;
}
function extractTwoLine(lines) {
  var pairs = [];
  for (var i = 0; i < lines.length - 1; i++) {
    var a = lines[i].trim(), b = lines[i + 1].trim();
    if (a.length < 6 || !b) continue;
    if (/[？?]$/.test(a) && !/[？?]$/.test(b) && b.length > 1) {
      pairs.push([a, b]); i++;
    } else if (/^\s*(答[案:：]|A[:：])/i.test(b) && a.length > 4) {
      pairs.push([a, b.replace(/^\s*(答[案:：]|A[:：])\s*/i, '')]); i++;
    }
  }
  return pairs;
}
function buildFromQA(q, a, tagHint) {
  var tag = tagHint || guessTag(q + ' ' + a);
  // 短答案 + 可枚举 → 生成选择题；否则生成填空/判断题
  var items = a.split(/[、,，;；\/]/).map(function (s) { return s.trim(); }).filter(Boolean);
  var type = 'fill', options = [], answer = [];

  if (items.length >= 2 && items.length <= 6 && a.length <= 90) {
    // 多答案：多选
    options = items.slice(0, 4);
    // 补足干扰项
    var pool = ['无固定要求', '视现场情况而定', '由厂家决定', '以上都不是', '不需要', '不适用'];
    while (options.length < 3) options.push(pool.shift());
    answer = options.map(function (_, i) { return i; }).slice(0, Math.min(items.length, options.length));
    type = items.length >= 3 ? 'multi' : 'single';
    if (type === 'single') { answer = [0]; options = items.slice(0, 4); }
  } else if (/^(对|正确|是|可以|能|需要|应该)$/.test(a.trim())) {
    type = 'judge'; options = ['对', '错']; answer = [0];
  } else if (/^(错|错误|不对|不可以|不能|不需要|不应该|否)$/.test(a.trim())) {
    type = 'judge'; options = ['对', '错']; answer = [1];
  }

  return {
    type: type,
    stem: /[？?]\s*$/.test(q) ? q : q + '？',
    options: options, answer: answer,
    explain: '参考答案：' + a,
    tag: tag, source: '文档导入'
  };
}
function guessTag(text) {
  var rules = [
    [/变压器|SCB|DYN|绕组|绝缘等级/, '变压器'],
    [/UPS|逆变|后备时间|并机/, 'UPS'],
    [/电池|蓄电池|南都|双登|放电截止/, '蓄电池'],
    [/柴发|柴油|并机三要素|水套|油耗/, '柴发'],
    [/油罐|油箱|供油|液位|回油/, '供油系统'],
    [/暖通|冷冻|冷却|冷机|末端|空调|蓄冷|水泵|压差/, '暖通'],
    [/消防|IG541|火灾|喷水/, '消防'],
    [/欧姆|功率|焦耳|电流|电压|交流|直流|基尔霍夫|正弦/, '电气基础'],
    [/安全电压|安全电流|五防|停电检修/, '电气安全'],
    [/中压|10kV|PT柜|馈线柜|母联|消弧/, '中压设备'],
    [/低压|MNS|列头柜|PDU/, '低压设备'],
    [/互感器|PT|CT|变比/, '互感器'],
    [/断路器|隔离开关|负荷开关|灭弧/, '开关电器'],
    [/PUE|WUE|CUE|SLA|MOP|SOP|EOP/, '数据中心指标'],
    [/直流屏|合母|控母|硅链/, '直流屏'],
    [/无功|SVG|APF|TSC|谐波/, '无功补偿'],
    [/绝缘|接地电阻|MΩ/, '绝缘接地'],
    [/长延时|短延时|瞬时|三段保护|脱扣/, '低压保护']
  ];
  for (var i = 0; i < rules.length; i++) if (rules[i][0].test(text)) return rules[i][1];
  return '通用知识';
}
function normalizeImported(x, tagHint) {
  var type = x.type || 'single';
  var opts = x.options || x.opts || [];
  var ans = x.answer != null ? x.answer : (x.a != null ? x.a : []);
  if (!Array.isArray(ans)) ans = [ans];
  ans = ans.map(function (v) {
    if (typeof v === 'number') return v;
    var s = String(v).trim();
    var idx = opts.indexOf(s);
    if (idx >= 0) return idx;
    if (/^[A-Da-d]$/.test(s)) return s.toUpperCase().charCodeAt(0) - 65;
    return s;
  });
  if (type === 'single' || type === 'multi' || type === 'judge') {
    ans = ans.filter(function (v) { return typeof v === 'number' && v >= 0 && v < Math.max(opts.length, 2); });
  }
  return {
    type: type, stem: x.stem || x.question || x.q || '',
    options: opts.length ? opts : (type === 'judge' ? ['对', '错'] : []),
    answer: ans, explain: x.explain || x.analysis || x.explanation || '',
    tag: tagHint || x.tag || '通用知识', source: x.source || '导入'
  };
}

var pendingQuestions = [];
function doImportParse() {
  var text = $('#impText').value;
  var hint = $('#impTag').value.trim();
  if (!text.trim()) return toast('请先上传文件或粘贴内容', 'no');
  var list = parseTextToQuestions(text, hint);
  if (!list.length) {
    $('#impPreview').innerHTML = '<span style="color:var(--bad)">未识别到有效题目结构。请检查格式，推荐「题干？,答案」或「Q:/A:」结构。</span>';
    return toast('未解析到题目', 'no');
  }
  // 去重
  var seen = {}, dedup = [];
  list.forEach(function (q) {
    var k = q.stem;
    if (!seen[k]) { seen[k] = 1; dedup.push(q); }
  });
  pendingQuestions = dedup;
  $('#impPreview').innerHTML = '<b style="color:var(--ok)">✅ 识别到 ' + dedup.length + ' 道题</b>' +
    (dedup.length !== list.length ? '（去重 ' + (list.length - dedup.length) + ' 题）' : '') +
    '<div style="max-height:150px;overflow:auto;margin-top:8px;padding:8px;background:var(--panel-2);border-radius:8px;font-size:12.5px">' +
    dedup.slice(0, 12).map(function (q, i) {
      return '<div>' + (i + 1) + '. [' + TYPE_LABEL[q.type] + '] ' + esc(q.stem.slice(0, 46)) + '</div>';
    }).join('') + (dedup.length > 12 ? '<div class="muted">… 其余 ' + (dedup.length - 12) + ' 题</div>' : '') + '</div>';
  toast('解析完成：' + dedup.length + ' 题', 'ok');
}
function doImportCommit() {
  if (!pendingQuestions.length) {
    doImportParse();
    if (!pendingQuestions.length) return;
  }
  var batch = pendingQuestions.map(function (q) {
    return {
      id: newQid(), type: q.type, stem: q.stem, options: q.options, answer: q.answer,
      explain: q.explain, tag: q.tag, source: q.source || '文档导入', createdAt: Date.now()
    };
  });
  var btn = $('#modalFoot button:last-child');
  busy(btn, true, '导入中…');
  Store.Bank.insert(batch).then(function (r) {
    busy(btn, false);
    if (r.ok === false) return toast('导入失败：' + r.error, 'no');
    DB.questions = batch.concat(DB.questions);
    closeModal();
    var n = pendingQuestions.length;
    pendingQuestions = [];
    refreshAfterBankChange();
    toast('成功导入 ' + n + ' 道题', 'ok');
  });
}
function download(name, content, mime) {
  var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportJSON() {
  var data = {
    exportedAt: new Date().toISOString(), count: DB.questions.length,
    questions: DB.questions.map(function (q) {
      return { type: q.type, stem: q.stem, options: q.options, answer: q.answer, explain: q.explain, tag: q.tag, source: q.source };
    })
  };
  download('题库_' + todayStr() + '.json', JSON.stringify(data, null, 2), 'application/json');
  toast('已导出 ' + DB.questions.length + ' 题', 'ok');
}
function exportCSV() {
  var rows = [['题型', '标签', '题干', '选项', '答案', '解析', '来源']];
  DB.questions.forEach(function (q) {
    rows.push([
      TYPE_LABEL[q.type], q.tag, q.stem,
      (q.options || []).join(' | '),
      q.type === 'fill' ? q.answer.join(' / ')
        : q.answer.map(function (i) { return String.fromCharCode(65 + i); }).join(''),
      q.explain, q.source || ''
    ]);
  });
  var csv = rows.map(function (r) {
    return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\r\n');
  download('题库_' + todayStr() + '.csv', '\ufeff' + csv, 'text/csv;charset=utf-8');
  toast('已导出 CSV', 'ok');
}

/* =========================================================
   统计
   ========================================================= */
/** 由进度行的 lastAt 反推每日答题量，供统计页使用 */
function dailyCounts() {
  var map = {};
  DB.questions.forEach(function (q) {
    var pr = PROGRESS[q.id];
    if (!pr || !pr.lastAt) return;
    var k = todayStr(new Date(pr.lastAt));
    if (!map[k]) map[k] = { count: 0 };
    map[k].count += (pr.right + pr.wrong); // 近似：累计作答次数归到最近一次日期
  });
  return map;
}

function renderStats() {
  if (!ME) return;
  var p = myProgress();
  var total = 0, right = 0, seen = 0, masterSum = 0;
  DB.questions.forEach(function (q) {
    var pr = p[q.id];
    if (!pr) return;
    var c = pr.right + pr.wrong;
    if (!c) return;
    total += c; right += pr.right; seen++; masterSum += masteryOf(q.id);
  });

  $('#stTotal').textContent = total;
  $('#stAcc').textContent = total ? Math.round(right / total * 100) + '%' : '—';
  $('#stSeen').textContent = seen;
  $('#stSeenD').textContent = '/ ' + DB.questions.length + ' 题';
  $('#stMaster').textContent = seen ? Math.round(masterSum / seen) + '%' : '—';
  $('#stStreak').innerHTML = streakDays() + ' <small>天</small>';
  $('#stStreakD').textContent = '最长 ' + longestStreak() + ' 天';
  $('#stMin').innerHTML = Math.round(totalMs() / 60000) + ' <small>分</small>';

  drawDailyChart();
  drawMasterDist(p);
  drawTagAcc(p);
  $('#sDue').textContent = countDue();
}
function drawDailyChart() {
  var cv = $('#cvDaily');
  if (!cv || !cv.getContext) return;
  var g0 = null;
  try { g0 = cv.getContext('2d'); } catch (e) { g0 = null; }
  if (!g0) return;
  var logs = dailyCounts();
  var days = [], max = 1;
  for (var i = 13; i >= 0; i--) {
    var d = new Date(Date.now() - i * DAY);
    var k = todayStr(d), l = logs[k] || { count: 0 };
    days.push({ k: k, label: (d.getMonth() + 1) + '/' + d.getDate(), count: l.count });
    max = Math.max(max, l.count);
  }
  var W = cv.width, H = cv.height, padL = 40, padR = 16, padT = 18, padB = 30;
  var cw = W - padL - padR, ch = H - padT - padB;
  var css = getComputedStyle(document.body);
  var cLine = css.getPropertyValue('--line').trim() || '#e6e8ec';
  var cText3 = css.getPropertyValue('--text-3').trim() || '#8b949e';
  var cBrand = css.getPropertyValue('--brand').trim() || '#2563eb';
  var cOk = css.getPropertyValue('--ok').trim() || '#0f9d58';
  var g = g0;
  g.clearRect(0, 0, W, H);

  // 网格
  g.strokeStyle = cLine; g.lineWidth = 1;
  g.font = '12px ' + css.getPropertyValue('--sans');
  g.fillStyle = cText3; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (var i = 0; i <= 4; i++) {
    var y = padT + ch - ch * i / 4;
    g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke();
    g.fillText(String(Math.round(max * i / 4)), padL - 8, y);
  }
  var bw = cw / days.length;
  days.forEach(function (d, i) {
    var x = padL + i * bw + bw * 0.16, w = bw * 0.68;
    var h = d.count ? Math.max(3, ch * d.count / max) : 0;
    var y = padT + ch - h;
    if (h > 0) {
      var grad = g.createLinearGradient(0, y, 0, padT + ch);
      grad.addColorStop(0, cBrand); grad.addColorStop(1, cOk);
      g.fillStyle = grad;
      g.beginPath();
      var r = Math.min(4, w / 2);
      g.moveTo(x, padT + ch); g.lineTo(x, y + r);
      g.quadraticCurveTo(x, y, x + r, y);
      g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
      g.lineTo(x + w, padT + ch); g.closePath(); g.fill();
    } else {
      g.fillStyle = cLine;
      g.fillRect(x, padT + ch - 2, w, 2);
    }
    g.fillStyle = cText3; g.textAlign = 'center'; g.textBaseline = 'top';
    if (days.length <= 14 || i % 2 === 0) g.fillText(d.label, x + w / 2, padT + ch + 8);
  });
}
function drawMasterDist(p) {
  var buckets = [
    { label: '已掌握 (80%+)', min: 80, max: 101, color: 'var(--ok)' },
    { label: '较熟练 (55-79%)', min: 55, max: 80, color: '#4caf50' },
    { label: '模糊 (30-54%)', min: 30, max: 55, color: 'var(--warn)' },
    { label: '薄弱 (1-29%)', min: 1, max: 30, color: 'var(--bad)' },
    { label: '未练习', min: -1, max: 1, color: 'var(--text-3)' }
  ];
  var counts = buckets.map(function () { return 0; });
  DB.questions.forEach(function (q) {
    var pr = p[q.id];
    var m = (pr && (pr.right + pr.wrong)) ? masteryOf(q.id) : 0;
    for (var i = 0; i < buckets.length; i++) {
      if (m >= buckets[i].min && m < buckets[i].max) { counts[i]++; break; }
    }
  });
  var tot = DB.questions.length || 1;
  $('#masterDist').innerHTML = buckets.map(function (b, i) {
    var pct = Math.round(counts[i] / tot * 100);
    return '<div class="bar-row"><div class="lbl">' + b.label + '</div>' +
      '<div class="track"><div class="fill" style="width:' + (counts[i] ? Math.max(pct, 2) : 0) + '%;background:' + b.color + '"></div></div>' +
      '<div class="num">' + counts[i] + ' 题</div></div>';
  }).join('');
}
function drawTagAcc(p) {
  var map = {};
  DB.questions.forEach(function (q) {
    var k = q.tag || '未分类';
    if (!map[k]) map[k] = { right: 0, total: 0 };
    var pr = p[q.id];
    if (!pr) return;
    map[k].right += pr.right; map[k].total += pr.right + pr.wrong;
  });
  var arr = Object.keys(map).map(function (k) {
    return { tag: k, right: map[k].right, total: map[k].total, acc: map[k].total ? map[k].right / map[k].total : -1 };
  }).filter(function (x) { return x.total > 0; }).sort(function (a, b) { return b.acc - a.acc; });

  if (!arr.length) {
    $('#tagAcc').innerHTML = '<div class="muted" style="padding:16px 0">还没有答题记录，去刷几题吧</div>';
    return;
  }
  $('#tagAcc').innerHTML = arr.map(function (x) {
    var pct = Math.round(x.acc * 100);
    var color = x.acc >= 0.8 ? 'var(--ok)' : x.acc >= 0.6 ? 'var(--warn)' : 'var(--bad)';
    return '<div class="bar-row"><div class="lbl">' + esc(x.tag) + '</div>' +
      '<div class="track"><div class="fill" style="width:' + Math.max(pct, 2) + '%;background:' + color + '"></div></div>' +
      '<div class="num">' + pct + '% (' + x.right + '/' + x.total + ')</div></div>';
  }).join('');
}

/* =========================================================
   管理员（用户与权限）
   ---------------------------------------------------------
   边界：
   · 可以改「角色」与「权限」，这两项是本应用自己的数据。
   · 不能改别人的密码 —— 密码哈希只有本人通过「修改密码」可换；
     管理员也无权代改（后端会返回 403）。
   ========================================================= */
var ADMIN_USERS = [];
function roleLabel(role) { return role === 'admin' ? '管理员' : '普通用户'; }
function permList(perms) {
  var names = { practice: '刷题', editBank: '题库编辑', exportData: '导出数据', manageUsers: '用户管理' };
  var on = Object.keys(perms || {}).filter(function (k) { return perms[k]; });
  if (!on.length) return '<span class="muted">仅浏览</span>';
  return on.map(function (k) { return '<span class="tagchip">' + (names[k] || k) + '</span>'; }).join(' ');
}
function renderAdmin() {
  if (!isAdmin()) return;
  var tbody = $('#userTbody');
  tbody.innerHTML = '<tr><td colspan="6" class="muted" style="padding:18px">加载中…</td></tr>';
  Store.Profiles.list().then(function (r) {
    if (r.ok === false) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:18px;color:var(--bad)">加载失败：' + esc(r.error) + '</td></tr>';
      return;
    }
    ADMIN_USERS = r.data;
    if (!ADMIN_USERS.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted" style="padding:18px">暂无用户</td></tr>';
      return;
    }
    tbody.innerHTML = ADMIN_USERS.map(function (u) {
      var isMe = ME && u.id === ME.id;
      var name = u.nickname || u.username || ('用户 ' + u.id.slice(0, 6));
      return '<tr>' +
        '<td><b>' + esc(name) + '</b>' + (isMe ? ' <span class="muted">(我)</span>' : '') +
          (u.username && u.nickname ? '<br><span class="muted" style="font-size:12.5px">@' + esc(u.username) + '</span>' : '') + '</td>' +
        '<td>' + (u.role === 'admin' ? '<span class="badge single">管理员</span>' : '<span class="badge judge">普通用户</span>') + '</td>' +
        '<td>' + permList(u.perms) + '</td>' +
        '<td class="muted">' + (u.answered || 0) + ' 次' +
          (u.accuracy != null ? ' · ' + u.accuracy + '%' : '') + '</td>' +
        '<td class="muted">' + new Date(u.createdAt).toLocaleDateString('zh-CN') + '</td>' +
        '<td>' + (isMe ? '<span class="muted">—</span>'
          : '<button class="btn btn-sm" data-u="perm" data-id="' + u.id + '">权限</button> ' +
            '<button class="btn btn-sm" data-u="role" data-id="' + u.id + '">' +
            (u.role === 'admin' ? '降为用户' : '升为管理员') + '</button>') + '</td></tr>';
    }).join('');

    $$('[data-u]', tbody).forEach(function (b) {
      b.addEventListener('click', function () {
        var u = ADMIN_USERS.filter(function (x) { return x.id === b.dataset.id; })[0];
        if (!u) return;
        if (b.dataset.u === 'perm') return openPermEditor(u);
        if (b.dataset.u === 'role') return toggleRole(u);
      });
    });
  });
}
function toggleRole(u) {
  var next = u.role === 'admin' ? 'user' : 'admin';
  if (!confirm('确定把「' + (u.nickname || u.id.slice(0, 6)) + '」' +
    (next === 'admin' ? '设为管理员？将获得全部权限。' : '降为普通用户？将失去题库编辑与用户管理权限。'))) return;
  Store.Profiles.updateById(u.id, { role: next }).then(function (r) {
    if (r.ok === false) return toast('修改失败：' + r.error, 'no');
    toast('角色已更新', 'ok');
    renderAdmin();
  });
}
function openPermEditor(u) {
  var perms = [
    ['practice', '刷题练习', '练习、错题本、收藏、卡片背诵、填空默写、知识点速览'],
    ['editBank', '题库编辑', '添加 / 修改 / 删除题目，导入文档生成题目'],
    ['exportData', '导出数据', '导出题库为 JSON / CSV'],
    ['manageUsers', '用户管理', '查看全部用户、分配角色与权限']
  ];
  var cur = u.perms || {};
  var body = '<p class="muted" style="margin:0 0 14px">为「<b>' + esc(u.nickname || u.id.slice(0, 6)) + '</b>」分配权限：</p>' +
    perms.map(function (p) {
      return '<label style="display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;cursor:pointer">' +
        '<input type="checkbox" data-p="' + p[0] + '" ' + (cur[p[0]] ? 'checked' : '') + ' style="margin-top:3px;width:17px;height:17px">' +
        '<span><b>' + p[1] + '</b><br><span class="muted" style="font-size:12.5px">' + p[2] + '</span></span></label>';
    }).join('') +
    '<p class="muted" style="margin:12px 0 0;font-size:12.5px">提示：出于安全考虑，管理员无法代改他人密码；如需重置，请联系服务器管理员直接操作数据库。</p>';
  openModal('分配权限 · ' + (u.nickname || u.id.slice(0, 6)), body, [
    { label: '取消', cls: 'btn' },
    { label: '保存', cls: 'btn btn-primary', keep: true, onClick: function () {
        var next = {};
        $$('[data-p]').forEach(function (c) { next[c.dataset.p] = c.checked; });
        Store.Profiles.updateById(u.id, { perms: next }).then(function (r) {
          if (r.ok === false) return toast('保存失败：' + r.error, 'no');
          closeModal(); renderAdmin(); toast('权限已更新', 'ok');
        });
      } }
  ]);
}

/* ---------------- 数据备份 ---------------- */
function backupData() {
  var btn = $('#btnBackup');
  busy(btn, true, '导出中…');
  Store.Bank.all().then(function (r) {
    busy(btn, false);
    var qs = (r.ok === false) ? [] : r.data;
    var data = {
      app: '刷题记忆', version: 2, exportedAt: new Date().toISOString(),
      questions: qs,
      myProgress: PROGRESS
    };
    download('刷题记忆_备份_' + todayStr() + '.json', JSON.stringify(data, null, 2), 'application/json');
    toast('备份已下载（含 ' + qs.length + ' 题）', 'ok');
  });
}

/* =========================================================
   模态框
   ========================================================= */
var modalCbs = [];
function openModal(title, bodyHTML, buttons) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHTML;
  var ft = $('#modalFoot');
  ft.innerHTML = '';
  modalCbs = [];
  (buttons || []).forEach(function (b, i) {
    var el = document.createElement('button');
    el.className = b.cls || 'btn';
    el.textContent = b.label;
    el.addEventListener('click', function () {
      if (typeof modalCbs[i] === 'function') return modalCbs[i]();
      closeModal();
    });
    modalCbs[i] = b.onClick || null;
    ft.appendChild(el);
  });
  $('#modalMask').classList.add('on');
}
function closeModal() { $('#modalMask').classList.remove('on'); }

/* =========================================================
   标签下拉
   ========================================================= */
function fillTagSelects() {
  var tags = allTags();
  var opts = function (withAll, allLabel) {
    return (withAll ? '<option value="">' + allLabel + '</option>' : '') +
      tags.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
  };
  var ts = $('#tagSelect'); if (ts) ts.innerHTML = opts(true, '全部标签');
  var ft = $('#flashTag'); if (ft) ft.innerHTML = opts(true, '全部标签');
  var dt = $('#dictTag'); if (dt) dt.innerHTML = opts(true, '全部标签');
  var bt = $('#bankTag'); if (bt) bt.innerHTML = opts(true, '全部标签');
}

/* =========================================================
   主题
   ---------------------------------------------------------
   主题是「本机偏好」而非账号数据，存 localStorage 即可，
   不必往返服务端，换设备时各自保留自己的观感。
   ========================================================= */
var THEME_KEY = 'quiz.theme';
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  var tb = $('#themeBtn');
  if (tb) tb.textContent = t === 'dark' ? '☀️' : '🌙';
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* 隐私模式下忽略 */ }
  var ps = $('#page-stats');
  if (ps && ps.classList.contains('on')) renderStats();
}
function savedTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'light'; }
  catch (e) { return 'light'; }
}

/* =========================================================
   全局刷新
   ========================================================= */
function refreshAll() {
  // 每个面板独立执行：任一模块出错不影响其余模块
  [fillTagSelects, renderPractice, renderWrong, renderFav, renderBank,
   function () { renderOverview($('#ovSearch').value); },
   buildFlash, buildDictation, renderStats, renderAdmin, updateStreakPill
  ].forEach(function (fn) {
    try { fn(); } catch (e) { console.error('[refresh] ' + fn.name + ' 失败', e); }
  });
}

/* =========================================================
   事件绑定 & 启动
   ========================================================= */
/** 切换登录卡片里的两种表单：login / reg */
var LOGIN_FORMS = {
  login: { form: '#loginForm', tab: 'login', sub: 'B 班应知应会 · 智能刷题系统' },
  reg:   { form: '#regForm',   tab: 'reg',   sub: '注册新账号' }
};
function showLoginForm(key) {
  var target = LOGIN_FORMS[key] || LOGIN_FORMS.login;
  Object.keys(LOGIN_FORMS).forEach(function (k) {
    var el = $(LOGIN_FORMS[k].form);
    if (el) el.style.display = (k === key) ? '' : 'none';
  });
  $$('.login-tabs button').forEach(function (b) {
    b.classList.toggle('active', b.dataset.ltab === target.tab);
  });
  $('#loginSub').textContent = target.sub;
  var first = $(target.form + ' input');
  if (first) first.focus();
}

function bindEvents() {
  // 登录 / 注册 Tab
  $$('.login-tabs button').forEach(function (b) {
    b.addEventListener('click', function () { showLoginForm(b.dataset.ltab); });
  });
  // 卡片内的小链接（去注册 / 去登录）
  $$('[data-ltab2]').forEach(function (b) {
    b.addEventListener('click', function () { showLoginForm(b.dataset.ltab2); });
  });

  // 两个表单的提交
  $('#loginForm').addEventListener('submit', doLogin);
  $('#regForm').addEventListener('submit', doRegister);

  // 导航
  $$('#nav button').forEach(function (b) {
    b.addEventListener('click', function () {
      var p = b.dataset.page;
      $$('#nav button').forEach(function (x) { x.classList.toggle('active', x === b); });
      $$('.page').forEach(function (x) { x.classList.toggle('on', x.id === 'page-' + p); });
      if (p === 'stats') renderStats();
      if (p === 'admin') renderAdmin();
      if (p === 'wrong') renderWrong();
      if (p === 'fav') renderFav();
      if (p === 'bank') renderBank();
      if (p === 'practice') S.startAt = S.startAt || Date.now();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // 头像菜单
  $('#avatarBtn').addEventListener('click', function () {
    var nm = displayName();
    openModal('账号',
      '<div style="display:flex;gap:12px;align-items:center;margin-bottom:16px">' +
      '<div class="avatar" style="width:46px;height:46px;font-size:19px">' + esc((nm[0] || 'U').toUpperCase()) + '</div>' +
      '<div><b style="font-size:16px">' + esc(nm) + '</b><br><span class="muted">' +
      (isAdmin() ? '管理员 · 全部权限' : '普通用户') + '</span></div></div>' +
      '<div class="tbl-wrap" style="margin-bottom:14px"><table class="tbl"><tbody>' +
      '<tr><td>注册时间</td><td>' + (ME ? new Date(ME.createdAt).toLocaleString('zh-CN') : '—') + '</td></tr>' +
      '<tr><td>连续打卡</td><td>' + streakDays() + ' 天（最长 ' + longestStreak() + ' 天）</td></tr>' +
      '<tr><td>题库总量</td><td>' + DB.questions.length + ' 题</td></tr>' +
      '</tbody></table></div>' +
      '<div class="actions" style="gap:8px">' +
      '<button class="btn" style="flex:1" id="mChangePwd">修改密码</button>' +
      '<button class="btn btn-danger" style="flex:1" id="mLogout">退出登录</button>' +
      '</div>',
      [{ label: '关闭', cls: 'btn' }]);
    $('#mLogout').addEventListener('click', function () { closeModal(); logout(); });
    $('#mChangePwd').addEventListener('click', openChangePassword);
  });

  // 主题
  $('#themeBtn').addEventListener('click', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  // 刷题模式
  $$('#modeSeg button').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('#modeSeg button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      S.mode = b.dataset.mode;
      $('#tagSelect').style.display = S.mode === 'tag' ? '' : 'none';
      $('#practiceSub').textContent = ({ seq: '顺序练习', rand: '随机练习', tag: '按标签练习', wrong: '错题重练', fav: '收藏练习', due: '间隔重复复习' })[S.mode];
      restartSession(false);
    });
  });
  $('#tagSelect').addEventListener('change', function () {
    S.tag = this.value; restartSession(false);
  });
  $('#btnRestart').addEventListener('click', function () { restartSession(false); toast('已重新开始', 'ok'); });

  // 错题 / 收藏
  $('#btnRedoWrong').addEventListener('click', function () {
    S.mode = 'wrong'; S.tag = '';
    $$('#modeSeg button').forEach(function (x) { x.classList.toggle('active', x.dataset.mode === 'wrong'); });
    $('#practiceSub').textContent = '错题重练';
    $$('#nav button').forEach(function (x) { x.classList.toggle('active', x.dataset.page === 'practice'); });
    $$('.page').forEach(function (x) { x.classList.toggle('on', x.id === 'page-practice'); });
    restartSession(false);
  });
  $('#btnClearWrong').addEventListener('click', function () {
    if (!confirm('确定清空错题本？（题目本身不会被删除）')) return;
    var dirty = {};
    Object.keys(PROGRESS).forEach(function (k) {
      if (PROGRESS[k].wrongFlag) { PROGRESS[k].wrongFlag = false; dirty[k] = PROGRESS[k]; }
    });
    Store.Progress.save(dirty).then(function (r) {
      if (r && r.ok === false) return toast('保存失败：' + r.error, 'no');
      renderWrong(); toast('错题本已清空', 'ok');
    });
  });
  $('#btnPracticeFav').addEventListener('click', function () {
    S.mode = 'fav'; S.tag = '';
    $$('#modeSeg button').forEach(function (x) { x.classList.toggle('active', x.dataset.mode === 'fav'); });
    $('#practiceSub').textContent = '收藏练习';
    $$('#nav button').forEach(function (x) { x.classList.toggle('active', x.dataset.page === 'practice'); });
    $$('.page').forEach(function (x) { x.classList.toggle('on', x.id === 'page-practice'); });
    restartSession(false);
  });

  // 卡片
  $('#flipCard').addEventListener('click', function () { this.classList.toggle('flipped'); });
  $('#flashPrev').addEventListener('click', function () {
    if (!F.list.length) return; F.i = (F.i - 1 + F.list.length) % F.list.length; renderFlash();
  });
  $('#flashNext').addEventListener('click', function () {
    if (!F.list.length) return; F.i = (F.i + 1) % F.list.length; renderFlash();
  });
  $('#flashShuffle').addEventListener('click', function () {
    F.list = shuffle(F.list); F.i = 0; renderFlash(); toast('已打乱顺序', 'ok');
  });
  $('#flashTag').addEventListener('change', function () { F.tag = this.value; buildFlash(); });
  $('#flashKnow').addEventListener('click', function () {
    var q = F.list[F.i]; if (!q) return;
    var p = progOf(q.id); p.right++; p.streak++; p.lastAt = Date.now();
    p.nextAt = Date.now() + SRS_STEPS[Math.min(p.streak, SRS_STEPS.length) - 1] * DAY;
    p.mastery = masteryOf(q.id);
    logAnswer(true, 0); persistProg(q.id); updateStreakPill();
    toast('已标记为记住', 'ok');
    F.i = (F.i + 1) % F.list.length; renderFlash();
  });
  $('#flashDunno').addEventListener('click', function () {
    var q = F.list[F.i]; if (!q) return;
    F.dunno = F.dunno || [];
    F.dunno.push(q);
    logAnswer(false, 0); updateStreakPill();
    toast('已加入「稍后再看」', 'no');
    F.i = (F.i + 1) % F.list.length; renderFlash();
  });

  // 默写
  $('#dictTag').addEventListener('change', function () { D.tag = this.value; buildDictation(); });
  $('#dictRevealAll').addEventListener('click', function () {
    $$('#dictArea .q-item').forEach(function (item) {
      var b = $('[data-d="show"]', item); if (b) b.click();
    });
  });

  // 速览
  var ovT;
  $('#ovSearch').addEventListener('input', function () {
    clearTimeout(ovT);
    var v = this.value;
    ovT = setTimeout(function () { renderOverview(v); }, 200);
  });

  // 题库
  $('#bankSearch').addEventListener('input', function () { BK.kw = this.value; BK.page = 1; renderBank(); });
  $('#bankTag').addEventListener('change', function () { BK.tag = this.value; BK.page = 1; renderBank(); });
  $('#bankType').addEventListener('change', function () { BK.type = this.value; BK.page = 1; renderBank(); });
  $('#bankMore').addEventListener('click', function () { BK.page++; renderBank(); });
  $('#btnAddQ').addEventListener('click', function () { openQuestionEditor(null); });
  $('#btnImport').addEventListener('click', openImport);
  $('#btnExportJson').addEventListener('click', exportJSON);
  $('#btnExportCsv').addEventListener('click', exportCSV);

  // 管理
  $('#btnBackup').addEventListener('click', backupData);

  // 模态
  $('#modalX').addEventListener('click', closeModal);
  $('#modalMask').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModal();
  });
}

/** 已登录状态下修改自己的密码（服务端校验旧密码） */
function openChangePassword() {
  openModal('修改密码',
    '<div id="cpStep1">' +
    '<label class="fld"><span>当前密码</span><input class="input" id="cpOld" type="password" placeholder="请输入当前密码"></label>' +
    '<label class="fld"><span>新密码</span><input class="input" id="cpNew" type="password" placeholder="至少 6 位"></label>' +
    '<label class="fld"><span>确认新密码</span><input class="input" id="cpNew2" type="password" placeholder="再输一次"></label>' +
    '</div>',
    [{ label: '取消', cls: 'btn' },
     { label: '保存', cls: 'btn btn-primary', keep: true, onClick: function () {
        var oldP = $('#cpOld').value, newP = $('#cpNew').value, again = $('#cpNew2').value;
        if (!oldP) return toast('请输入当前密码', 'no');
        if (newP.length < 6) return toast('新密码至少 6 位', 'no');
        if (newP !== again) return toast('两次输入的新密码不一致', 'no');
        var btn = $('#modalFoot button:last-child');
        busy(btn, true, '保存中…');
        Store.changePassword(oldP, newP).then(function (r) {
          busy(btn, false);
          if (r.ok === false) return toast(errMsg(r), 'no');
          closeModal();
          toast('密码已修改', 'ok');
        });
      } }]);
}

/* ---------------- 启动 ---------------- */
function boot() {
  bindEvents();
  applyTheme(savedTheme());
  showLoginForm('login');
  $('#loginWrap').classList.add('on');

  // 会话存在服务端（HttpOnly Cookie），刷新页面后自动恢复登录态
  Store.session().then(function (session) {
    if (!session) return;            // 未登录，停留在登录页
    return afterAuthIn();
  }).catch(function (e) {
    console.error('[boot]', e);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
