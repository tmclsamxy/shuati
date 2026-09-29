# 刷题记忆 · 应知应会

一个**多人共用**的刷题记忆应用。题库集中存放在你自己的服务器上，所有人共享同一份；每个人的学习进度各自独立、互不干扰。

> 题库已内置 **138 道题**，全部由你提供的 `B班应知应会-126a5298.docx` 自动解析生成，覆盖 **22 个知识点**：电气基础、电气安全、中压设备、低压设备、变压器、UPS、蓄电池、柴发、供油系统、暖通、消防、直流屏、互感器、开关电器、低压保护、无功补偿、数据中心指标、绝缘接地、仪表信号、高压系统、机房容量、设备参数。

**作者：任雯柽**

---

## 一、架构总览

本应用**自带后端**，前后端一起部署在你自己的服务器上，不依赖任何第三方云服务。

```
浏览器 ──HTTPS──▶ 1Panel 反向代理 ──▶ Node.js 服务（:3000）
                                            │
                                            ├─ 静态文件：index.html / app.js / store.js ...
                                            └─ /api/* 接口
                                                   │
                                                   └─ SQLite（server/data/quiz.sqlite）
```

| 项 | 选型 | 说明 |
|---|---|---|
| **后端** | Node.js 原生 `http` 模块 | 零 npm 依赖，`npm install` 都不需要 |
| **数据库** | SQLite（Node 22 内置 `node:sqlite`） | 单文件，免安装、免编译、免运维 |
| **密码** | `node:crypto` 的 scrypt | 免编译，自带盐值 + 恒定时间比对 |
| **会话** | HttpOnly Cookie | 前端接触不到令牌，防 XSS 窃取 |
| **最低 Node 版本** | **22.5** | `node:sqlite` 需要；推荐 22 LTS 或更高 |

> 💡 **为什么刻意做到零依赖？**
> Docker 里编译 `better-sqlite3` 需要 `python3` + `make` + `g++`，在精简镜像上经常失败。改用 Node 内置模块后，**整条链路无原生编译**，任何环境都能一次跑起来，也不存在依赖供应链风险。

---

## 二、快速上手（本地预览）

### 1. 启动服务

```bash
cd server
node index.js
```

看到下面的输出即成功：

```
  刷题记忆 · 后端服务已启动
  ────────────────────────────────────────
  地址      http://localhost:3000
  数据库    .../server/data/quiz.sqlite
  静态目录  ...（项目根目录）
  题目数量  138
  用户数量  0
  ────────────────────────────────────────
  提示：还没有任何账号，第一个注册的用户会自动成为管理员。
```

然后浏览器访问 **http://localhost:3000**

> ⚠️ 必须通过这个服务访问，**不能**直接双击 `index.html`。因为页面要调用 `/api/` 接口，`file://` 协议下同源请求无法工作。

### 2. 首次导入题库（新数据库时）

如果提示「题目数量 0」，执行一次：

```bash
cd server
node scripts/seed.js
```

输出会列出导入题数与题型分布。

### 3. 注册与登录

本应用**不预置任何默认账号**，也不在任何位置显示账号密码。

| 操作 | 说明 |
|---|---|
| **登录** | 用户名 + 密码 |
| **注册** | 用户名（2-20 位，中文/字母/数字/下划线）+ 密码（≥6 位）+ 可选昵称 |

> **👑 第一个注册的人会自动成为管理员**，拥有全部权限（题库编辑、导出、用户管理）。请务必由你本人先完成注册。

---

## 三、部署到你自己的服务器（1Panel）

### 方式 A：Docker Compose（推荐）

1Panel 内置 Docker 与 Compose，这是最省事的方式。

**① 上传项目**

把整个项目目录上传到服务器，例如 `/mrcheng/shuati`：

```
/mrcheng/shuati/
├── index.html          styles.css
├── app.js              store.js
├── config.js           seed-data.js
├── docker-compose.yml  .env.example
└── server/
    ├── index.js  db.js  auth.js  package.json
    ├── Dockerfile  docker-entrypoint.sh  .dockerignore  quiz-memory.service
    ├── data/           ← SQLite 数据（需持久化）
    └── scripts/
        ├── init-db.js  seed.js  smoke.js
```

**② 修好数据目录属主（关键，跳过这步必然报错）**

Docker 会把宿主机的 `server/data` 挂进容器。如果这个目录属于 `root`，
而容器内的服务用户是 uid 1000，SQLite 就没法在里面建库，会报：

```
Error: unable to open database file
code: 'ERR_SQLITE_ERROR', errcode: 14
```

所以先执行：

```bash
cd /mrcheng/shuati
mkdir -p server/data
sudo chown -R 1000:1000 server/data
```

> 如果你在 compose 里把 `PUID`/`PGID` 改成了别的值，这里要改成对应的 uid/gid。
> 查当前登录用户：`id -u` 和 `id -g`。

**③ 构建并启动**

在 1Panel 的「容器 → 编排」里新建编排（指向 `docker-compose.yml`），或在服务器终端执行：

```bash
cd /mrcheng/shuati
docker compose up -d --build
```

**④ 首次导入题库**

```bash
docker compose exec quiz node server/scripts/seed.js
```

正常会看到：

```
  题库文件  /app/web/seed-data.js

  题库导入完成
  ────────────────────────────
  导入前  0 题
  导入后  138 题
  本次写入 138 题
  题型分布
    填空  21
    判断  7
    多选  12
    单选  98
  知识点  22 个
```

> 💡 脚本会自动在几个位置里找 `seed-data.js`（`STATIC_DIR`、项目根、`/app/web`、以及逐级向上查找）。
> 万一你的目录结构特殊导致找不到，可以显式指定：
>
> ```bash
> docker compose exec -e SEED_FILE=/app/web/seed-data.js quiz node server/scripts/seed.js
> ```

**⑤ 查看状态**

```bash
docker compose ps
docker compose logs -f --tail=50
```

服务只监听 `127.0.0.1:3300`，外部必须经反向代理访问。

**⑥ 配置反向代理与 HTTPS**

1Panel → 「网站 → 反向代理」：
- **主域名**：填你的域名，如 `quiz.example.com`
- **代理地址**：`http://127.0.0.1:3300`
- 保存后，在「HTTPS」里申请 Let's Encrypt 证书并开启强制跳转

> 若 1Panel 的反向代理跑在 Docker 网络里，把 compose 里的端口映射改成 `"3300:3000"`，代理地址填 `http://quiz-memory:3300`。

---

### 方式 B：systemd 直接跑 Node 进程

不想用 Docker 时更轻量。

**① 装 Node 22+**

1Panel →「主机 → 运行环境」安装 Node.js，或：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v   # 应 ≥ v22.5
```

**② 上传项目到 `/opt/quiz-memory`，并建数据目录**

```bash
mkdir -p /opt/quiz-memory/server/data
chown -R www-data:www-data /opt/quiz-memory
```

> ⚠️ 这步的 `chown` 不能省。服务以 `www-data` 身份运行，
> 而 `server/data` 是 SQLite 的落盘位置；属主不对就会报
> `unable to open database file`。若你改用别的用户，
> 记得同时改 `quiz-memory.service` 里的 `User=` / `Group=`。

**③ 安装服务**

```bash
cp /opt/quiz-memory/server/quiz-memory.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now quiz-memory
systemctl status quiz-memory
```

> 若 `which node` 不是 `/usr/bin/node`，改一下 service 文件里的 `ExecStart` 路径。

**④ 导入题库**

```bash
cd /opt/quiz-memory && sudo -u www-data node server/scripts/seed.js
```

**⑤ 反向代理**：同方式 A 的第 ⑥ 步。

常用运维命令：

```bash
systemctl restart quiz-memory     # 重启
journalctl -u quiz-memory -f      # 看日志
journalctl -u quiz-memory -n 100  # 看最近 100 行
```

---

## 四、环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `DB_PATH` | `server/data/quiz.sqlite` | SQLite 文件路径 |
| `STATIC_DIR` | 项目根目录 | 前端静态文件目录 |
| `SESSION_DAYS` | `30` | 登录会话有效天数 |

Docker 部署见 `docker-compose.yml`；systemd 部署见 `quiz-memory.service`。参考样例在 `.env.example`。

---

## 五、功能总览

### 1. 刷题
- **6 种练习模式**：顺序 / 随机 / 按标签 / 错题重练 / 收藏练习 / 到期待复习
- **4 种题型**：单选、多选、判断、填空
- 提交后**立即判定对错**，并展示正确答案 + 详细解析
- 顶部实时显示：本次已答、正确率、用时、待复习数
- 每场结束有**成绩总结页**，可一键重练本场错题

### 2. 记忆强化（3 个进阶功能）
| 功能 | 说明 |
|---|---|
| 🃏 **卡片翻转背诵** | 先看题干自测，点击翻面查看答案与解析；可「记住了」（推进复习周期）或「不熟，稍后再看」 |
| ✍️ **填空默写** | 所有题目以简答形式呈现，自己手写答案后点「核对」，系统做模糊匹配（忽略空格、标点、大小写）并给出参考答案 |
| 📖 **知识点速览** | 按知识点分组的浓缩卡片，每张卡直接展示题干要点 + 解析，适合考前 10 分钟快速过一遍，支持搜索 |

### 3. 间隔重复（SRS）
答对后自动安排下次复习时间，间隔按 `1 → 2 → 4 → 7 → 15 → 30 → 60` 天递增；
答错则**半天后**重新出现，并进入错题本。首页「待复习」卡片显示当前到期的题目数量。

### 4. 错题本与收藏
- 答错的题自动进入**错题本**，连续答对 **2 次**自动移出
- 收藏（☆）的题目可单独练习
- 支持「查看解析」和手动移出

### 5. 题库管理
- **增删改查**：完整的新增/编辑/删除题目（需 `题库编辑` 权限）
- **搜索**：按题干、选项、答案、标签、解析全文搜索
- **筛选**：按标签 + 按题型组合筛选
- **批量导入导出**：JSON / CSV 双向
- **导入文档自动出题**：见第七节

### 6. 统计面板
- 总答题次数、总正确率、已练习题目数、题目掌握度
- **连续打卡天数**（含历史最长纪录）、累计学习时长
- **每日学习曲线**：近 14 天答题量柱状图
- **掌握度分布**：已掌握 / 较熟练 / 模糊 / 薄弱 / 未练习 五档
- **各知识点正确率**：横向条形图，一眼看出薄弱环节

### 7. 用户与权限（管理员）
- 管理员拥有**全部权限**，可给其他用户**逐项分配权限**，也可一键**升降角色**：
  - `刷题练习` — 练习、错题、收藏、背诵、默写、速览
  - `题库编辑` — 增删改题目、导入文档
  - `导出数据` — 导出 JSON / CSV
  - `用户管理` — 查看全部用户、查看作答统计、分配角色与权限
- **备份题库**：一键导出全部题目（含本人进度）为 JSON

> ⚠️ **密码不归管理员管**。密码哈希只有本人能通过「修改密码」更换，管理员也无法代改（后端直接返回 403）。确实需要重置时，只能由服务器管理员操作数据库（见第十节）。

---

## 六、多人共用的数据规则

| 数据 | 归属 | 说明 |
|---|---|---|
| **题库** | 🌍 全局共享 | 所有人看到同一份题目；只有管理员或有 `题库编辑` 权限的人能增删改 |
| **学习进度** | 👤 各自独立 | 对错次数、掌握度、错题本、收藏、打卡天数都只属于你 |
| **用户档案** | 👤 各自独立 | 用户名、昵称、角色、权限 |

也就是说：你编辑了题目，所有人立刻能看到；但你在某题上答对了几次，别人看不到，也不会互相覆盖。

**进度隔离是在服务端强制的**：写进度的接口永远只写「当前登录用户」的行，前端连别人的 `user_id` 都拿不到。

---

## 七、导入文档生成题目

进入「题库」页 → 点 **📥 导入文档**（需 `题库编辑` 权限）。

### 支持的格式
| 格式 | 解析方式 |
|---|---|
| `.txt` `.md` | 直接读取，自动识别问答结构 |
| `.csv` | 按「题干,答案」两列解析 |
| `.json` | 读取 `questions` 数组（也兼容 `stem`/`question`/`q` 字段名） |
| `.docx` | **前端直接解压** `word/document.xml` 提取文本（含表格，单元格以制表符分隔） |
| `.pdf` | 尝试提取文本流中的文字 |

> 💡 **PDF 提示**：如果 PDF 是扫描件或使用了压缩流，前端无法解析。此时请用阅读器「另存为文本」后粘贴，或直接复制内容粘贴到输入框。
> 💡 **docx 提示**：需要浏览器支持 `DecompressionStream`（Chrome 80+ / Edge 80+ / Firefox 113+ / Safari 16.4+ 均支持）。不支持时请另存为 txt。

### 自动识别的问答结构
解析器会依次尝试以下模式，命中即用：

```
# 模式 1：Q/A 标记
Q: 中压柜型号
A: ZS1、PIX

# 模式 2：问/答 中文标记
问：安全电压是多少？
答：36V以下

# 模式 3：单行「题干,答案」或「题干|答案」
变压器型号？,SCB14-2500/10
变压器型号？| SCB14-2500/10

# 模式 4：Markdown 表格 / 两列表格（自动跳过表头行）
| 问题 | 答案 |
|---|---|
| 冷机喘震原因？ | 蒸发压力过低或冷凝压力过高 |

# 模式 5：题干独占一行，下一行为答案
柴发并机三要素是什么？
同电压、同频率、同相位
```

### 自动出题逻辑
- 答案含 **2-6 个短项**（用「、」「,」「/」分隔）→ 生成**多选/单选**题，自动补足干扰项
- 答案为「对/是/可以」类 → 生成**判断题**（答案：对）
- 答案为「错/不对/不能」类 → 生成**判断题**（答案：错）
- 其他情况 → 生成**填空题**，解析中给出完整参考答案

### 自动打标签
根据题干和答案中的关键词自动归入 22 个知识点之一（如出现「变压器/SCB/DYN」→ 归入「变压器」）。也可以在导入时手动指定**统一标签**覆盖自动识别。

### 导入流程
1. 上传文件 **或** 直接粘贴文本
2. 点 **「解析预览」** 查看识别结果（会自动去重）
3. 确认无误后点 **「确认导入」**

---

## 八、文件说明

```
刷题记忆/
├── index.html               页面结构（单页应用）
├── styles.css               样式（含亮/暗主题、桌面/手机响应式）
├── config.js                前端配置（后端地址，同源部署时留空即可）
├── store.js                 数据层：题库 / 进度 / 档案 / 认证，走 /api 接口
├── seed-data.js             内置题库源数据（138 题，首次入库时使用）
├── app.js                   全部应用逻辑
├── 使用说明.md               本文件
├── docker-compose.yml       Docker 编排（1Panel 可直接识别）
├── .env.example             环境变量示例
└── server/                  ── 后端 ──
    ├── index.js              HTTP 服务 + 路由 + 静态文件
    ├── db.js                 SQLite 数据层（建表与全部读写函数）
    ├── auth.js               密码哈希（scrypt）与会话令牌
    ├── package.json          零第三方依赖
    ├── Dockerfile            镜像构建
    ├── .dockerignore         构建排除项
    ├── quiz-memory.service   systemd 服务单元
    ├── data/                 数据库文件所在（务必持久化/备份）
    │   └── quiz.sqlite
    └── scripts/
        ├── init-db.js        只建表，不改数据
        ├── seed.js           把 seed-data.js 导入题库
        └── smoke.js          端到端接口自测（71 项断言）
```

> `seed-data.js` 是题库的**源数据备份**。题目已在 SQLite 里，页面运行时从数据库读取；这个文件保留是为了将来需要重建题库时可用。

---

## 九、数据安全设计

### 权限校验在服务端
所有 `/api/` 接口都会先确认登录身份，再逐项检查权限。前端的按钮隐藏**只是视觉优化**，真正拦截一律由服务端完成 —— 即使有人手动构造请求，也会被 401 / 403 挡下。

### 密码存储
```
scrypt$16384$8$1$<盐值Base64>$<哈希Base64>
```
- 算法：`scrypt`（N=16384, r=8, p=1，输出 64 字节）
- 每个密码使用独立随机盐（16 字节）
- 校验用 `crypto.timingSafeEqual` 做**恒定时间比对**，防时序攻击
- 登录时即使账号不存在，也会**照常跑一遍哈希**，避免通过响应时间探测账号是否存在

### 会话
- 令牌为 `randomBytes(32)` 的 base64url，存在 `sessions` 表，带过期时间
- 通过 **HttpOnly Cookie** 下发（`quiz_token`，`SameSite=Lax`），**前端 JavaScript 完全接触不到**
- 修改密码后，自动清掉**其他设备**的会话，仅保留当前这条

### 管理员保护
- 管理员**不能撤销自己的管理员身份**（避免把自己锁在外面）
- 系统**至少保留一名管理员**
- 管理员**不能代改他人密码**（接口直接 403）

### 其他
- 静态文件服务做了**目录穿越防护**（`path.resolve` 后校验前缀）
- 请求体限制 4 MB，防大包攻击
- SQLite 开启 `WAL` 模式 + `busy_timeout`，读写并发更稳、断电更安全

### 建议你再加一层
在 1Panel 反向代理上开启：
- **HTTPS 强制跳转**（浏览器才会正常接受 `HttpOnly` Cookie）
- 可选的 **IP 访问频率限制**，防止暴力破解登录

---

## 十、运维与备份

### 备份（重要）

整个应用的数据就是**一个文件**：`server/data/quiz.sqlite`。

```bash
# Docker 部署
docker compose stop quiz
cp server/data/quiz.sqlite ~/backup/quiz-$(date +%F).sqlite
docker compose start quiz

# systemd 部署
systemctl stop quiz-memory
cp /opt/quiz-memory/server/data/quiz.sqlite ~/backup/quiz-$(date +%F).sqlite
systemctl start quiz-memory
```

> WAL 模式下还有 `quiz.sqlite-wal` / `quiz.sqlite-shm` 两个文件，**停服务后**它们的内容已合并进主文件，正常备份主文件即可。
> 建议在 1Panel 里给 `server/data/` 加一条**定时备份**任务。

### 恢复

```bash
systemctl stop quiz-memory
cp ~/backup/quiz-2026-09-29.sqlite /opt/quiz-memory/server/data/quiz.sqlite
systemctl start quiz-memory
```

### 重置某人的密码

服务端没有提供改密接口给管理员（安全设计），需要时直接改库：

```bash
cd /opt/quiz-memory/server
node -e "
import('./auth.js').then(async (a) => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('./data/quiz.sqlite');
  const hash = a.hashPassword('新密码123456');
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, '要改的用户名');
  // 顺带清掉该用户所有会话，强制重新登录
  db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run('要改的用户名');
  console.log('已重置');
});
"
```

### 自测

部署后可以跑一次端到端自检，确认接口都正常：

```bash
cd server
node scripts/smoke.js
```

它会临时启一个服务、在独立数据库上跑 71 项断言（注册 / 登录 / 权限 / 进度隔离 / 改密 / 防穿越等），**不会动你的正式数据**。

### 重建数据库

```bash
cd server
node scripts/init-db.js   # 建表
node scripts/seed.js      # 重新导入 138 题
```

---

## 十一、快捷键与交互细节

| 操作 | 效果 |
|---|---|
| 填空题输入框内按 `Enter` | 直接提交 |
| 点击卡片 | 翻转背诵卡 |
| `Esc` | 关闭弹窗 |
| 右上角 🌙 / ☀️ | 切换亮色 / 暗色主题（偏好记在本机） |
| 右上角头像 | 查看账号信息、修改密码、退出登录 |

---

## 十二、常见问题

**Q：第一次打开没有默认账号，怎么用？**
A：本应用不预置任何账号。请点「注册」创建账号 —— **第一个注册的人就是管理员**。

**Q：忘记密码了怎么办？**
A：本方案出于安全考虑没有做邮箱找回（那需要额外接邮件服务）。请让服务器管理员按第十节的方法在数据库里重置。

**Q：管理员能帮我改密码吗？**
A：在应用界面里不能，这是刻意的安全设计。只有服务器管理员能操作数据库改。

**Q：我改了题目，同事那边看不到？**
A：刷新一下页面即可。题库是共享的，改动会立即写入数据库。

**Q：换电脑/换浏览器，我的进度还在吗？**
A：还在。进度存在服务器数据库里，用同一账号登录就能看到。只有**主题偏好**记在本机。

**Q：能同时多人在线用吗？**
A：可以，这正是当前架构的设计目标。各自的进度互不干扰，题库共享。

**Q：Docker 构建失败怎么办？**
A：本项目**零 npm 依赖、零原生编译**，正常不会失败。若报网络错误，多半是拉取 `node:22-alpine` 基础镜像时网络受限，给 Docker 配个国内镜像加速即可。

**Q：报错 `unable to open database file`（ERR_SQLITE_ERROR, errcode 14）？**
A：数据目录权限问题 —— Docker 最常踩的坑。宿主机 `./server/data` 属于 `root`，
而容器内的服务用户是 uid 1000，写不进去。在宿主机项目目录下执行：

```bash
sudo chown -R 1000:1000 server/data
```

如果你把 compose 里的 `PUID`/`PGID` 改成了别的值，这里要对应用那个值
（`id -u` / `id -g` 查当前用户）。

改完直接重试即可，**不用重建镜像**：

```bash
docker compose exec quiz node server/scripts/seed.js
```

> 服务启动时会自动把数据目录 chown 给运行用户（见 `docker-entrypoint.sh`），
> 但 `docker compose exec` 不经过 entrypoint，所以手动执行命令前仍需先修好宿主目录属主。

**Q：导入题库时报「找不到题库文件 seed-data.js」？**
A：早期版本有这个 bug（只按相对路径找，Docker 里路径不对），**已修复**。现在的脚本会依次尝试
`SEED_FILE` 环境变量 → 项目根 → `STATIC_DIR` → `/app/web` → 逐级向上查找。

如果仍报错，按提示用绝对路径显式指定即可：

```bash
docker compose exec -e SEED_FILE=/app/web/seed-data.js quiz node server/scripts/seed.js
```

先确认文件确实在容器里：

```bash
docker compose exec quiz ls -l /app/web/seed-data.js
```

**Q：启动时报 `node:sqlite` 相关错误？**
A：Node 版本太低。`node:sqlite` 需要 **Node 22.5+**，`node -v` 确认一下，升级到 22 LTS 或更高。

**Q：启动时有个 `ExperimentalWarning: SQLite` 警告？**
A：这是 Node 对 `node:sqlite` 的提示，功能完全正常，可以忽略。想去掉的话启动时加 `--no-warnings`。

**Q：手机能用吗？**
A：可以，界面已做移动端适配。部署后直接访问同一个地址即可。

**Q：能改端口吗？**
A：可以，改 `PORT` 环境变量，同时记得同步改反向代理的目标端口。

**Q：前端想放 CDN、后端放另一台机器？**
A：改 `config.js` 的 `base` 为后端地址。但此时浏览器会按跨域处理，需要后端返回相应的 CORS 头、并把 Cookie 改成 `SameSite=None; Secure`。**同源部署没有这些问题，建议保持同源。**
