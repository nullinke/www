> **历史文档提示**：本文记录重构前的实现。当前工程约束、API 接入、存储与功能状态以根目录 README.md 和 REFACTOR_NOTES.md 为准；下文不再作为当前实现承诺。

# Echo 小手机 — 新窗口交接文档

> 最后更新：2026-11-10（第三版，全量功能补充 + 美化/设置重构）  
> 项目路径：`/sdcard/小手机/`  
> 访问入口：`http://127.0.0.1:8765/lock-screen.html`

---

## 一、项目目标

**玻璃拟态（Glassmorphism）风格的 AI 小手机 App UI**，运行在浏览器里，模拟 iOS 手机界面。

**技术栈**：原生 HTML + CSS + 原生 JS（ES Module）。无框架，无外部 UI 库。  
仅允许的外部资源：Font Awesome 6（图标）、MiSans / Cormorant Garamond / Liter（字体）。

---

## 二、开发环境

### HTTP Server 启动

每次重启 Operit 后需重启，使用带 `no-cache` 头的自定义 Server（防缓存干扰开发）：

```bash
# 启动（已写入 /tmp/nocache_server.py）
nohup python3 /tmp/nocache_server.py > /tmp/httpserver.log 2>&1 &

# 若 /tmp/nocache_server.py 丢失，重新创建：
cat > /tmp/nocache_server.py << 'EOF'
import http.server, os

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()
    def log_message(self, format, *args): pass

os.chdir('/sdcard/小手机')
http.server.test(HandlerClass=NoCacheHandler, port=8765, bind='127.0.0.1')
EOF
nohup python3 /tmp/nocache_server.py > /tmp/httpserver.log 2>&1 &
```

```bash
# 验证
curl -I http://127.0.0.1:8765/lock-screen.html | grep -i 'cache\|HTTP'
# 应返回 HTTP/1.0 200 + Cache-Control: no-store
```

### 强制刷新缓存（每次修改后执行）

```bash
TS=$(date +%s) && for f in /sdcard/小手机/*.html; do sed -i "s/?v=[0-9]*/?v=$TS/g" "$f"; done && echo "v=$TS"
```

### 语法检查

```bash
node --input-type=module < /sdcard/小手机/js/chat-app.js 2>&1 | grep -i syntaxerror
# 无输出即正常（ERR_MODULE_NOT_FOUND 是正常的，不是 SyntaxError）
```

---

## 三、文件结构

```
/sdcard/小手机/
├── js/
│   ├── chat-app.js        # 主逻辑入口（~3628行）所有页面 init 函数 + streamChat + buildMessages
│   ├── api.js             # 存档用，已内联进 chat-app.js，实际不被 import
│   ├── chat-state.js      # 会话/消息状态 CRUD（~237行）
│   ├── chat-router.js     # URL 路由参数解析/生成（~39行）
│   ├── settings-state.js  # 设置项持久化（~191行）含 saveThemeAsset/loadThemeAsset
│   ├── memory-state.js    # 记忆库 CRUD（~109行）
│   ├── moments-state.js   # 朋友圈动态 CRUD（~139行）
│   └── profile-state.js   # 用户资料持久化（~80行）
├── index.html             # 重定向 → lock-screen.html
├── lock-screen.html       # 锁屏（入口，内联 script 读 lockScreenWallpaper + lockAvatar）
├── home.html              # 主页（Tab:Home，功能卡片，图标/字体应用 CSS 变量）
├── chat-list.html         # 聊天列表（动态渲染，含「我的资料」弹层）
├── chat-room.html         # 聊天室（AI 流式回复，长按菜单，心声折叠，聊天背景层）
├── chat-settings.html     # 角色主页（单人编辑/删除；群聊成员/改名/解散）
├── chat-create.html       # 新建角色/群聊
├── settings.html          # 设置（API 配置、range 滑块生成参数、MCP 连接探测、颜色弹层）
├── other.html             # 其他功能入口（Tab:Other，图标/字体应用 CSS 变量）
├── archive.html           # 档案（「我」+ 角色，注入 system prompt）
├── memory.html            # 记忆库（搜索、筛选、删除）
├── moments.html           # 朋友圈（发帖、点赞）
├── couple-space.html      # 情侣空间（切换关联角色）
├── theme.html             # 美化（range 滑块、颜色弹层、自定义图标/字体/壁纸）
├── world.html             # 世界书（UI 静态，逻辑未接）
├── my-profile.html        # 我的资料（独立页，已被弹层替代，保留未删）
└── HANDOVER.md            # 本文件
```

---

## 四、localStorage 数据结构

| Key                                        | 内容                                                  |
| ------------------------------------------ | --------------------------------------------------- |
| `echo-chat-state-v1`                       | 会话列表、消息记录、草稿                                        |
| `echo-profile-v1`                          | 用户昵称/ID/签名/头像/朋友圈封面/archive 档案                      |
| `echo-settings-v1`                         | 模型配置、生成参数、主题（iconSize/fontSize/iconShape/fontColor） |
| `echo-memory-v1`                           | 记忆条目数组                                              |
| `echo-moments-v1`                          | 朋友圈动态数组                                             |
| `echo-couple-v1`                           | 情侣空间配置 `{ charId }`                                 |
| `echo-conv-avatar-v1.{convId}`             | 角色头像 base64（独立 key，防主 JSON 超限）                      |
| `echo-theme-assets-v1.lockAvatar`          | 锁屏圆环头像 base64                                       |
| `echo-theme-assets-v1.lockScreenWallpaper` | **锁屏专属壁纸** base64（仅 lock-screen.html 读）             |
| `echo-theme-assets-v1.wallpaper`           | **全局壁纸** base64（home/other 等页面，不含锁屏和聊天室）            |
| `echo-theme-assets-v1.chatBg`              | **聊天室专属背景** base64（仅 chat-room.html）                |
| `echo-theme-assets-v1.icon.{cardId}`       | 自定义图标图片 base64，cardId 为 home.html 的卡片 id            |
| `echo-theme-assets-v1.customFont`          | 自定义字体 base64（ttf/otf/woff/woff2）                    |
| `echo-theme-assets-v1.customFontName`      | 自定义字体文件名（字符串，非图片）                                   |

### ⚠️ localStorage 空间管理

- WebView localStorage 上限约 **5MB**，base64 图片极易撑满
- 所有图片上传统一经过 `resizeImage(file, maxSize, quality)`
- 角色头像独立 key：`echo-conv-avatar-v1.{id}`，不进主 JSON
- `saveChatState` 三级降级：① 直接写 → ② 迁出 avatarData 再写 → ③ 截断消息到最近 50 条

### settings.theme 字段说明

```js
{
  iconSize:   0~100,   // 图标芯片大小（0→30px, 50→38px, 100→46px）
  iconShape:  'round'|'square',  // 圆角13px / 方角10px
  fontSize:   0~100,   // 字体大小（0→12px, 45→14.25px, 100→17px）
  fontColor:  '#rrggbb',  // ⚠️ 新版存 hex 字符串；旧版为 'ink'|'gray'|'white'，已做兼容处理
}
```

---

## 五、CSS 变量体系

### 设计 Token（不可修改）

```css
--brand-blue: #9CC4E4       /* 品牌主蓝 */
--brand-blue-deep: #7FA8CC
--brand-ink: #4E6B80        /* 正文主色 */
--brand-deep: #5E7B90
--brand-muted: #9DB4C4
--glass-bg: rgba(255,255,255,0.55)
--glass-border: rgba(255,255,255,0.90)
--glass-blur: blur(12px) saturate(1.4)   /* 毛玻璃 */
--radius-card: 24px / 22px              /* 卡片圆角 */
--shadow-glass: 0 8px 20px rgba(143,186,217,0.18)
```

### 主题动态变量（由 `applyThemeTokens()` 注入 `document.documentElement.style`）

| 变量                   | 来源                               | 作用范围                |
| -------------------- | -------------------------------- | ------------------- |
| `--font-size-base`   | `settings.theme.fontSize`        | home/other 卡片标签字体大小 |
| `--font-color-base`  | `settings.theme.fontColor`（hex）  | home/other 卡片标签颜色   |
| `--icon-chip-size`   | `settings.theme.iconSize`        | 图标芯片宽高              |
| `--icon-chip-radius` | `settings.theme.iconShape`       | 图标芯片圆角              |
| `--icon-font-size`   | `settings.theme.iconSize` × 0.42 | 图标芯片内图标大小           |

**注入时机**：`init()` 最顶部，直接读 `localStorage.getItem('echo-settings-v1')` 绕开 volatile 缓存。

**实时刷新**：`initThemePage()` 内通过 `subscribeToSettings()` 订阅，拖动滑块即时更新当前页。

---

## 六、init() 启动流程

```
init()
  ├─ applyWallpaper()         全局壁纸（跳过 chat-room / lock-screen）
  ├─ applyChatBg()            聊天背景（仅 chat-room.html）
  ├─ applyThemeTokens()       注入字体/图标 CSS 变量（跳过 lock-screen）
  ├─ initMainNavigation()     Tab 栏高亮 + href 绑定
  ├─ initHomePage()           问候语 + 自定义图标加载 + 卡片路由
  ├─ (chat-list.html)         renderChatList() + subscribeToChatState + initChatListProfileSheet
  ├─ (chat-room.html)         initChatRoom()
  ├─ (chat-settings.html)     initChatSettings() + initCharProfilePage()
  ├─ (settings.html)          initSettingsPage()
  ├─ (memory.html)            initMemoryPage()
  ├─ (my-profile.html)        initProfilePage()
  ├─ (chat-create.html)       initChatCreatePage()
  ├─ (moments.html)           initMomentsPage()
  ├─ (archive.html)           initArchivePage()
  ├─ (theme.html)             initThemePage()
  └─ (couple-space.html)      initCoupleSpacePage()
```

**lock-screen.html 单独处理**：不加载 `chat-app.js`，用内联 `<script>` 读取 `lockScreenWallpaper` + `lockAvatar`，点击后淡出跳转 `home.html`。

---

## 七、壁纸三分离架构

```
lock-screen.html  →  读 echo-theme-assets-v1.lockScreenWallpaper
                      （内联 script，与 chat-app.js 无关）

home/other/etc   →  init() → applyWallpaper()
                      读 echo-theme-assets-v1.wallpaper
                      插入 position:fixed z-index:-1 壁纸层（id=__wallpaper_layer__）
                      .phone 背景改为半透明渐变让壁纸透出

chat-room.html   →  init() → applyChatBg()
                      读 echo-theme-assets-v1.chatBg
                      显示 #__chatbg_layer__（position:absolute opacity:0.55）
                      ⚠️ applyWallpaper() 在 chat-room 里被跳过
```

**theme.html 设置入口**：锁屏壁纸 / 全局壁纸 / 聊天背景 三行独立卡片，各自上传、各自存独立 key。

---

## 八、已完成功能清单

### 导航与路由

- [x] 锁屏 → 淡出 → 主页淡入（0.9s）
- [x] 底部 Tab 栏（Home / Chat / Settings / Other）
- [x] URL 路由参数（`nav=tab|list`、`from=home|other|chat-list`、`conversationId`）
- [x] 从主页卡片进入：无 Tab 栏 + 有返回键；从 Tab 进入：有 Tab 栏

### 聊天功能

- [x] 会话列表全动态渲染（不依赖静态 HTML）
- [x] 流式 AI 回复（SSE，逐 token 更新气泡，实时过滤 `<think>` 标签防泄露）
- [x] 草稿持久化；未读标记；`记住：内容` 手动写记忆
- [x] 新建单人角色（含头像上传压缩）；新建群聊（选 2+ 角色，拼合头像预览）
- [x] 角色主页（编辑名字/备注/角色设定/头像/气泡颜色/绑定世界书/删除）
- [x] 群聊多角色串行回复（随机停顿 600~1400ms，出错继续下一个）
- [x] 长按消息菜单（编辑 / 删除 / 重新生成）
- [x] 心声折叠组件（`<think>` 解析，chevron 旋转展开）
- [x] 气泡颜色 per-conversation（我的 + 角色，保存到 conv 对象）
- [x] 聊天室专属背景图（独立于全局壁纸）

### AI API

- [x] OpenAI 兼容格式，任意中转站
- [x] `buildMessages`：角色 persona + 用户档案 + 角色档案 + 回复格式指令 + 历史消息
- [x] 口语换行分段 + 逐条 420ms 延迟分发（模拟打字节奏）
- [x] 超时中断（AbortController），可配置
- [x] 拉取 `/models` 接口（过滤 embedding/tts 等非对话模型）

### 自动记忆提取

- [x] 每轮对话结束后异步触发（temperature=0.3，20s 超时，不阻塞 UI）
- [x] 提取约定/承诺/羁绊/喜好，写入 `echo-memory-v1`

### 美化页（theme.html）

| 功能             | 存储 key                             | 状态       |
| -------------- | ---------------------------------- | -------- |
| 锁屏圆环头像         | `lockAvatar`                       | ✅        |
| 锁屏壁纸           | `lockScreenWallpaper`              | ✅        |
| 全局壁纸           | `wallpaper`                        | ✅        |
| 聊天背景           | `chatBg`                           | ✅        |
| 图标大小（原生 range） | `iconSize` → `--icon-chip-size`    | ✅        |
| 图标形状切换         | `iconShape` → `--icon-chip-radius` | ✅        |
| 自定义图标（6个，每个独立） | `icon.{cardId}`                    | ✅        |
| 字体大小（原生 range） | `fontSize` → `--font-size-base`    | ✅        |
| 字体颜色（玻璃弹层）     | `fontColor`（hex）                   | ✅        |
| 自定义字体上传        | `customFont` + `customFontName`    | ✅（当前页生效） |

### 设置页（settings.html）

- [x] 模型配置（URL + Key + 名称，密钥显示/隐藏，预设列表，拉取 /models）
- [x] 生成参数（原生 range 滑块：温度/TopP/上下文/频率惩罚/存在惩罚）
- [x] MCP 开关：开启时探测接口可达性，显示真实连接状态
- [x] 字体颜色色盘（同美化页，玻璃弹层）

### 个人与社交

- [x] 我的资料弹层（昵称/ID/签名/头像/朋友圈封面）
- [x] 情侣空间（关联角色切换）
- [x] 朋友圈（发帖/点赞）
- [x] 档案页（「我」+ 角色档案，注入 AI system prompt）
- [x] 记忆库（搜索/筛选/删除，实时监听更新）

---

## 九、核心约束（不可违反）

1. **不修改 CSS 设计 Token**：颜色（`#9CC4E4`、`#4E6B80` 等）、圆角（`24px/20px/999px`）、毛玻璃参数（`blur(12px) saturate(1.4)`）均不得改动
2. **不引入外部 UI 库**：只允许 Font Awesome、MiSans/Cormorant/Liter 三个已有外部资源
3. **不修改 HTML 布局结构**：只能加 `id/style/class`，不能改层级关系
4. **JS 新增逻辑只往 `chat-app.js` 追加**，不新建额外 JS 逻辑文件（`*-state.js` 为数据层可独立修改）
5. **localStorage 图片必须用独立 key**：角色头像 `echo-conv-avatar-v1.{id}`，主题资源 `echo-theme-assets-v1.{key}`，绝不塞进任何 JSON 对象
6. **所有图片上传必须经过 `resizeImage(file, maxSize, quality)`**


## 十一、已知问题

| 问题                     | 状态  | 说明                                                                        |
| ---------------------- | --- | ------------------------------------------------------------------------- |
| 自定义字体跨页不持久             | 待修复 | 仅 theme.html 上传时注入当前页，其他页面刷新后字体回默认；需在 `init()` 里增加读取注入                    |
| 自定义图标仅 home.html 的 6 个 | 待扩展 | other.html 卡片、couple-space 等页面的图标无法自定义                                    |
| 图标大小/字体变化跨页需刷新         | 已知  | CSS 变量在 `init()` 注入，修改后需进新页面才生效；theme.html 当前页通过 subscribeToSettings 实时刷新 |
| 世界书页面纯静态               | 待实现 | world.html 有 UI，无逻辑                                                       |
| 朋友圈评论                  | 待实现 | UI 按钮已有，逻辑未接                                                              |
| 气泡颜色保存后需重进才生效          | 已知  | CSS 变量在 `initChatRoom` 里读取，切换后不实时刷新                                       |
| localStorage 容量风险      | 运行期 | 三级降级保护，建议图片上传前裁剪                                                          |

---

## 十二、待实现任务（按优先级）

### P1 — 补完主题系统

- **自定义字体跨页生效**：在 `init()` 里补充读取 `loadThemeAsset('customFont')` 并注入 `@font-face`，参考 `initThemePage` 里的 `injectCustomFont()` 逻辑
- **other.html 图标自定义**：在 `ICON_DEFS` 数组中补充 other.html 的功能卡片 id，在 other.html 加载时读取应用（与 home.html 同样的 `loadThemeAsset` 遍历）

### P2 — 世界书功能

- `world.html` 接入：导入世界书 JSON、持久化 `echo-world-v1`、在 `chat-settings.html` 绑定弹层显示真实列表
- `buildMessages` 注入：绑定世界书内容追加到 system prompt

### P3 — 情侣空间完善

- **纪念日倒计时**：设置起始日期，首页/情侣空间显示「在一起 N 天」
- **专属背景**：独立背景图（存 `echo-theme-assets-v1.coupleBg`）

### P4 — 功能完善

- **朋友圈评论**：评论列表 + 发布逻辑
- **朋友圈发帖支持图片**：发布弹层加图片选择
- **消息搜索**：聊天室顶部搜索入口
- **壁纸/背景透明度滑块**：全局壁纸 0.72 硬编码，可加滑杆存 `settings.theme.wallpaperOpacity`

### P5 — 优化

- **localStorage 近满提示**：存储使用率 > 80% 时弹出提示
- **气泡颜色实时生效**：保存气泡颜色后直接更新 CSS 变量，无需重进聊天室

---

## 十三、页面导航关系图

```
index.html → lock-screen.html（内联 script，无 chat-app.js）
    └─ 点击 → home.html
               ├─ Tab: Chat → chat-room.html?nav=tab
               ├─ Tab: Settings → settings.html
               ├─ Tab: Other → other.html
               ├─ 卡片: 聊天/日记/邀约/行程/宠物 → chat-list.html?from=home
               └─ 卡片: 家园 → couple-space.html

chat-list.html
    ├─ 我的资料卡 → 底部弹层（原地编辑）
    ├─ 角色条目 → chat-room.html?nav=list&conversationId=xxx
    ├─ 朋友圈 → moments.html
    ├─ 情侣空间 → couple-space.html
    └─ + 按钮 → chat-create.html

chat-room.html → ··· → chat-settings.html?nav=xxx&conversationId=xxx

other.html
    ├─ 档案 → archive.html
    ├─ 世界 → world.html（静态，逻辑未接）
    ├─ 美化 → theme.html
    └─ 设置 → settings.html?from=other
```

---

## 十四、AI 回复完整流程

```
用户输入 → sendMessage()
  → appendMessage(mine)
  → appendMessage(peer, '…', { streamMsgId, replyCharId })
  → render()

streamChat({ conversation, historyMessages })
  → buildMessages():
      [system] 角色 persona
      [system] 用户档案（如有填写）
      [system] 角色档案（如有填写）
      [system] 回复格式指令（<think> 心声 + 口语换行分段）
      历史消息（过滤脏消息、合并同角色、首条必须是 user）
  → fetch SSE
    → onChunk: bubble.textContent = visibleText（实时过滤 <think> 标签）
    → onDone:
        解析 <think>…</think> → thinkContent
        正文按 \n 分段 → segments[]
        raw localStorage: placeholder.text = segments[0], .think = thinkContent
        render()
        setTimeout × (segments.length-1): 后续段逐条追加（间隔 420ms）
        extractMemories(charName, userText, textToSplit)  // 异步，不阻塞
    → onError: placeholder.text = '⚠ 错误信息'

群聊额外流程：
  replySequential(idx)
    → 随机等待 600~1400ms
    → appendMessage(peer, '…', { replyCharId: members[idx].id })
    → streamChat(members[idx])
      → onDone → raw 写入 + render() + replySequential(idx+1)
      → onError → render() + replySequential(idx+1)  // 出错也继续
    → idx >= members.length → 解锁输入栏
```

---

*此文档覆盖截至 2026-11-10 第三版的全部实现。后续每次功能变更请同步更新本文件。*
