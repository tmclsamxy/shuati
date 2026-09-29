/* =========================================================
   store.js —— 数据层（自建后端）
   ---------------------------------------------------------
   后端：server/ （Node.js + SQLite，零第三方依赖）
   通信：fetch + HttpOnly Cookie 会话，前端不接触任何令牌。

   数据模型：
     questions   题库（所有人可读，需 editBank 权限可写）
     progress    学习进度（每人只能读写自己的行）
     users       用户账号（昵称 + 角色 + 权限）

   接口契约与旧版云端版完全一致，
   因此 app.js 的业务逻辑无需改动。
   ========================================================= */
(function (global) {
'use strict';

/* ---------------- 基础请求 ----------------
   所有请求都带 credentials: 'same-origin'，
   浏览器自动携带 HttpOnly Cookie（登录态）。
   -------------------------------------------- */
var API_BASE = (global.API_CONFIG && global.API_CONFIG.base) || '';

function request(method, path, body) {
  var opts = {
    method: method,
    credentials: 'same-origin',
    headers: {}
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(API_BASE + path, opts).then(function (res) {
    return res.text().then(function (text) {
      var data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
      if (!data) {
        // 服务端返回了非 JSON（如网关错误页）
        if (res.ok) return { ok: true, data: null };
        throw new Error('HTTP ' + res.status);
      }
      if (data.ok === false) {
        var err = new Error(data.error || ('HTTP ' + res.status));
        err.status = res.status;
        throw err;
      }
      return { ok: true, data: data.data };
    });
  });
}
var get = function (p) { return request('GET', p); };
var post = function (p, b) { return request('POST', p, b); };
var put = function (p, b) { return request('PUT', p, b); };
var patch = function (p, b) { return request('PATCH', p, b); };
var del = function (p, b) { return request('DELETE', p, b); };

/** 统一把异常转成 { ok:false, error }，调用方无需写 catch */
function fail(e) {
  var msg = (e && (e.message || e.error)) || '网络异常，请检查服务是否已启动';
  return { ok: false, error: String(msg) };
}

/* ---------------- 题库 ---------------- */
var Bank = {
  /** 拉取全部题目 */
  all: function () {
    return get('/api/questions').then(function (r) {
      return { ok: true, data: (r.data || []).map(rowToQ) };
    }).catch(fail);
  },

  insert: function (list) {
    var rows = (list || []).map(function (q) {
      return {
        id: q.id, type: q.type, tag: q.tag || '未分类',
        stem: q.stem, options: q.options || [], answer: q.answer || [],
        explain: q.explain || '', source: q.source || ''
      };
    });
    if (!rows.length) return Promise.resolve({ ok: true, data: [] });
    return post('/api/questions', { questions: rows }).then(function (r) {
      return { ok: true, data: r.data };
    }).catch(fail);
  },

  update: function (qid, patchData) {
    var row = {};
    ['type', 'tag', 'stem', 'options', 'answer', 'explain', 'source'].forEach(function (k) {
      if (patchData[k] !== undefined) row[k] = patchData[k];
    });
    return put('/api/questions/' + encodeURIComponent(qid), row).then(function (r) {
      return { ok: true, data: r.data };
    }).catch(fail);
  },

  remove: function (qid) {
    return del('/api/questions/' + encodeURIComponent(qid)).then(function (r) {
      return { ok: true, data: r.data };
    }).catch(fail);
  },

  /** 清空题库（仅管理员；用于「用导入内容整体替换」场景） */
  removeAll: function () {
    return get('/api/questions').then(function (r) {
      var list = r.data || [];
      // 逐个删除：后端没有批量删除接口，避免引入一个危险的全清空接口
      return list.reduce(function (chain, q) {
        return chain.then(function () {
          return del('/api/questions/' + encodeURIComponent(q.id)).catch(function () { /* 忽略单条失败 */ });
        });
      }, Promise.resolve());
    }).then(function () {
      return { ok: true };
    }).catch(fail);
  }
};

function rowToQ(r) {
  return {
    id: r.id,
    type: r.type,
    tag: r.tag,
    stem: r.stem,
    options: r.options || [],
    answer: r.answer || [],
    explain: r.explain || '',
    source: r.source || '',
    createdAt: r.createdAt || Date.now()
  };
}

/* ---------------- 学习进度（按用户隔离） ---------------- */
var Progress = {
  all: function () {
    return get('/api/progress').then(function (r) {
      return { ok: true, data: r.data || {} };
    }).catch(fail);
  },

  /** 整批写入（upsert），只提交发生变化的行 */
  save: function (map) {
    var keys = Object.keys(map || {});
    if (!keys.length) return Promise.resolve({ ok: true });
    var payload = {};
    keys.forEach(function (qid) {
      var p = map[qid] || {};
      payload[qid] = {
        right: p.right || 0, wrong: p.wrong || 0,
        streak: p.streak || 0, mastery: p.mastery || 0,
        lastAt: p.lastAt || 0, nextAt: p.nextAt || 0,
        fav: !!p.fav, wrongFlag: !!p.wrongFlag
      };
    });
    return post('/api/progress', { progress: payload }).then(function (r) {
      return { ok: true, data: r.data };
    }).catch(fail);
  },

  saveOne: function (qid, p) {
    var one = {};
    one[qid] = p;
    return Progress.save(one);
  },

  removeAll: function () {
    return del('/api/progress').then(function (r) {
      return { ok: true, data: r.data };
    }).catch(fail);
  }
};

/* ---------------- 用户档案 ---------------- */
var Profiles = {
  /** 取当前登录用户的档案（无则返回 null） */
  me: function () {
    return get('/api/auth/me').then(function (r) {
      return { ok: true, data: r.data ? rowToProfile(r.data) : null };
    }).catch(fail);
  },

  /**
   * 兼容旧接口：注册流程已由 Store.register 完成，
   * 这里只在「已登录但档案缺失」时兜底返回当前用户。
   */
  create: function (nickname) {
    return get('/api/auth/me').then(function (r) {
      if (!r.data) throw new Error('尚未登录');
      if (nickname && !r.data.nickname) {
        return patch('/api/users/' + r.data.id, { nickname: nickname }).then(function (p) {
          return { ok: true, data: rowToProfile(p.data), isFirst: false };
        });
      }
      return { ok: true, data: rowToProfile(r.data), isFirst: false };
    }).catch(fail);
  },

  updateMe: function (patchData) {
    var row = {};
    ['nickname', 'role', 'perms'].forEach(function (k) {
      if (patchData[k] !== undefined) row[k] = patchData[k];
    });
    return get('/api/auth/me').then(function (r) {
      if (!r.data) throw new Error('尚未登录');
      return patch('/api/users/' + r.data.id, row);
    }).then(function (r) {
      return { ok: true, data: rowToProfile(r.data) };
    }).catch(fail);
  },

  /** 管理员：列出全部用户 */
  list: function () {
    return get('/api/users').then(function (r) {
      return { ok: true, data: (r.data || []).map(rowToProfile) };
    }).catch(fail);
  },

  /** 管理员：修改指定用户 */
  updateById: function (userId, patchData) {
    var row = {};
    ['role', 'perms', 'nickname'].forEach(function (k) {
      if (patchData[k] !== undefined) row[k] = patchData[k];
    });
    return patch('/api/users/' + encodeURIComponent(userId), row).then(function (r) {
      return { ok: true, data: rowToProfile(r.data) };
    }).catch(fail);
  }
};

function rowToProfile(r) {
  return {
    id: String(r.id),
    username: r.username || '',
    nickname: r.nickname || '',
    role: r.role || 'user',
    perms: r.perms || {},
    createdAt: r.createdAt || Date.now(),
    lastLoginAt: r.lastLoginAt || null,
    // 管理员视图附加统计
    answered: r.answered,
    accuracy: r.accuracy,
    seen: r.seen
  };
}

/* ---------------- 对外接口 ---------------- */
global.Store = {
  /** 后端地址配置 */
  cfg: (global.API_CONFIG || {}),
  base: API_BASE,

  Bank: Bank,
  Progress: Progress,
  Profiles: Profiles,

  /* ---- 认证 ---- */

  /** 当前会话；未登录返回 null */
  session: function () {
    return get('/api/auth/me').then(function (r) {
      return r.data ? rowToProfile(r.data) : null;
    }).catch(function () { return null; });
  },

  /**
   * 兼容旧接口：本方案用 Cookie 会话，
   * 无跨标签页登录事件，返回一个空注销函数即可。
   */
  onAuthChange: function () {
    return function () {};
  },

  /** 用户名 + 密码登录 */
  signInPassword: function (username, password) {
    return post('/api/auth/login', { username: username, password: password })
      .then(function (r) {
        return { ok: true, data: { user: rowToProfile(r.data.user) } };
      })
      .catch(fail);
  },

  /** 用户名 + 密码注册。第一个注册者由后端自动设为管理员 */
  register: function (username, password, nickname) {
    return post('/api/auth/register', {
      username: username, password: password, nickname: nickname || ''
    }).then(function (r) {
      return {
        ok: true,
        data: {
          user: rowToProfile(r.data.user),
          isFirstAdmin: !!r.data.isFirstAdmin
        }
      };
    }).catch(fail);
  },

  /** 已登录状态下修改密码 */
  changePassword: function (oldPassword, newPassword) {
    return post('/api/auth/password', {
      oldPassword: oldPassword, newPassword: newPassword
    }).then(function (r) {
      return { ok: true, data: r.data };
    }).catch(fail);
  },

  signOut: function () {
    return post('/api/auth/logout').then(function () {
      return { ok: true };
    }).catch(function () { return { ok: true }; });
  }
};

})(window);
