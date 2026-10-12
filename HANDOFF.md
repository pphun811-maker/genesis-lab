# HANDOFF · Genesis Lab 交接文档

> 最后全量重测于 2026-10-12 深夜（第四轮收工）。写给下一个接手的 agent（或未来的自己）。
> **原则：一切以实测为准。** 本文档每条结论都标注了来源：
> ✅ = 浏览器/测试实测过　📖 = 代码可查证　⚠️ = 未实测，不要当它是验证过的。

---

## 一、这是什么

**Genesis Lab（创世实验室）**：纯前端人工生命沙盘。用户用自然语言或参数面板定义一个世界，种子化引擎让生命在其中觅食、捕猎、繁殖、突变、灭绝、分化；用户观察（世界报告 + 物种传记 + 事件流 + 字幕条解说）、有限干预（规则热改、灾变开关），并从任意时刻分叉平行实验对比。定位是**做给自己玩的观察+有限干预**玩具——用户已明确否决挑战/过关与成就图鉴路线。

技术栈：React 18 + TypeScript(strict) + Vite 6 + Tailwind 4 + Zustand + ECharts + idb（IndexedDB）+ zod。模拟引擎是零依赖纯 TS，跑在 Web Worker 里。**无后端、无账号、本地优先。**

## 二、如何运行与验证

```bash
npm install       # 依赖（Node 24 / npm 11 通过）
npm run dev       # 开发服务器（本会话用 5175）
npm test          # vitest 全量（✅ 本轮 50 个全绿，10 个文件，~11s）
npm run build     # tsc -b && vite build（✅ 通过）
npm run preview   # 生产构建预览（✅ 已实测：4173 建世界跑通，Worker ES module 正常）
npx tsx bench/perf.bench.ts   # ✅ 本轮 0.851ms/tick @923 个体（P95 1.03ms，~1175 ticks/s）
```

**浏览器实测要点**（本项目在 ZCode IAB 里实测过，方法可复用）：

1. dev 模式观察舱向 `window.__genesis` 暴露 `{ cam, renderer, getClient }`（仅 `import.meta.env.DEV`），可直接读相机、帧、SimClient。
2. rAF 在标签页被判定遮挡时不触发——观察舱已用 rAF + 200ms 定时器双驱动兜底，别删 keeper。
3. 拖拽跟手定量复现：canvas 上派发 pointerdown + N 个 pointermove + pointerup，断言相机位移 ≈ `-D/scale`（本轮实测 60px/scale3.7 → 16.2 世界单位，零偏差）。
4. IAB `cua.move` 不触发 React onPointerMove（`cua.click` 可以）；验证悬停类交互用 evaluate 派发真实 `PointerEvent('pointermove', {bubbles:true})`；拖拽类必须 `cua.drag` 真实鼠标实测（合成事件会掩盖视觉方向问题）。
5. 页面上有多个「▶」按钮（指标折叠卡也叫 ▶）——定位播放条播放键用 `textContent.trim()==='▶'` 取最后一个。
6. React 受控 input 用原生 value setter + `dispatchEvent(new Event('input'))` 填值。

**陷阱（真实踩过）**：

- **HMR 缓存毒化**：同文件密集热更新后浏览器永久缓存 `?t=` 模块 → 换端口重启 dev server（`npx vite --port 5176 --strictPort`）。
- **IndexedDB 按 origin 隔离**：5173/5175/4173 数据互不相通（preview 测试要在新 origin 里自建世界）。
- React StrictMode 双挂载：只随首帧发送的数据必须持久在 SimClient 上（worldData 已如此）。
- IAB evaluate 不支持动态 `import()`；部分按钮 Playwright click actionability 超时，用 `evaluate((el)=>el.click())` 兜底。

## 三、当前状态（本轮全量实测矩阵）

### ✅ 自动化（本轮全绿）

- 50 个 vitest（10 文件）：确定性（同 seed 逐 tick 一致）、快照恢复一致性、能量守恒账本、5 预设生态存活、物种命名与事件叙事、死因账本与食物网、快照往返、LLM mock、IndexedDB round-trip、序列化 round-trip。
- 生产构建通过；`vite preview` 生产环境实测通过（含 Worker）。
- 性能：0.851ms/tick @923 个体（基准线 3.55ms 时代的 4 倍提速）；主线程渲染帧 P50 ≈6ms @2000 个体（精灵图集 + 批量矩形）。

### ✅ 浏览器全流程（本轮逐项走过，数据为实测值）

- **创建世界**：预设/种子/参数面板 → 创世进入观察舱 ✓
- **播放控制**：播放/暂停/100x（12s 跑 1.2 万 tick）/单步 ✓
- **画布**：拖拽平移 1:1 跟手（实测 60px→16.2 世界单位）、滚轮缩放（3.70→4.26）、悬停提示（「猎手#4959 能量 56% · 体型 1.8」）、点击选中切个体 tab ✓
- **世界报告**：总览格（含峰值/速率）、种群与资源、死因构成（堆叠条，实测捕食世界 91% 被捕杀）、势力格局（Top5 占比条+趋势箭头）、食物网（「猎手 捕食 食草者 ×954」「尖牙狼 捕食 猎手 ×528」）、基因漂变、物种兴衰、大事记 ✓
- **物种面板**：卡片（名/拉丁名/世系徽章/特征/生态位/趋势/迷你走势/灭绝沉底）；点击卡=画布高亮该物种（其余压暗）；「ⓘ 详情」物种传记下钻（数量史/全史死因/猎物与天敌/相关事件，实测「猎手」全史 2,873 例死因）✓
- **谱系树（系统发生树）**：新「谱系」tab——SVG 时间轴树（x=时间，行=DFS 分支展开），肘形边连父→子物种，存续种实心点+数量、灭绝种「×」+灰名+†，节点点击联动画布高亮；实测「猎手→尖牙虎†→尖牙狼→尖牙鼬」四代谱系正确渲染 ✓
- **热力叠加**：画布右下角 关/密度/死亡 三档——密度=青色聚集热（个体密度场衰减累积），死亡=红色热点（引擎死亡热区网格，随食物同频节流发送）；像素探针实测密度模式 933 像素全青、死亡模式红点铺开 ✓
- **有性繁殖**：`rules.sexualReproduction`（预设默认开启、旧快照缺省=无性、创建页可勾选、规则面板可热切）——求偶（感知内最近同类成熟个体，体能≥阈值 50%，双方 30 tick 不应期）→ 均匀交叉 → 突变；双亲各投 25% 体能，池子 84% 成幼体；实测新世界出生速率 1,022/千tick，能量账本恒等式测试通过 ✓
- **个体检查器**：基因组条 + 行为芯片（觅食/逃逸/追捕/归群/游荡，来自 `Agent.intent`）+ 物种特征 ✓
- **事件流**：分化（带拉丁名与特征）、灭绝讣告（存续 tick·巅峰数）、里程碑（繁荣/权力更迭/饥荒/纪录）、规则修改 ✓
- **规则热改**：突变率拉 45% → 应用 → 事件「实验者修改了规则：突变率 → 45.0%」✓；灾变开关/强度、繁殖方式可热切（实测瘟疫 32% 感染 814 死亡）✓
- **分叉 → 家族树 → 对比页**：分叉出快照副本（badge「↳ 母体名 @tick」）、对比页叠加曲线 ✓
- **导出**：⤓ 导出触发浏览器下载 ✓（导入按钮 ⚠️ 见下）
- **持久化**：刷新页面从快照恢复（恢复后强制暂停）✓
- **字幕条 + 军师**：模板解说（事件即时插播 + 8s 轮换氛围句，引用真实物种名）✓；未配置 AI 时问军师提示「先在设置里配置 AI」✓。**用户已报问题：解说气泡 `max-w-[520px] truncate` 会把长句截断看不全（NarratorBar.tsx 胶囊行）——待修：允许换行至 2~3 行或点击展开全文。**
- **设置弹窗**：面板内拖动全选文本、松手落在蒙层不再误关弹窗（需按下+松开都在蒙层才关闭，实测拖出蒙层后弹窗保留、蒙层直点仍正常关闭）✓；「⚡ 测试连接」按钮用当前草稿发 max_tokens=1 的最小请求并显示 延迟/模型 或错误——成功与失败两条 UI 路径均已用 fetch 拦截实测（无真实网络）✓；厂商预设芯片一键填充（glm-4-flash-250414（免费）/ glm-5.3-flash → 智谱 v4；DeepSeek → api.deepseek.com + deepseek-flash，实测点击填充正确）✓；说明文案含智谱开放平台免费注册入口（open.bigmodel.cn，新标签）✓；默认模型 `glm-4-flash-250414`。注意：DeepSeek 预设模型名为用户指定，官方模型 ID 若不同（如 deepseek-chat）用户测试连接时需自行改模型框。
- **侧栏拖宽**：把手跟随鼠标（右拖变窄），300–720px，localStorage `gl-sidebar-width-v1` ✓
- **死因账本语义**：咬杀计入 `deaths` 且 `deathsByCause.predation`，五类之和恒等于 deaths（测试守护）✓

### ⚠️ 未实测（不要当作已验证）

- **AI 真实 API 调用**（说书人/军师/测试连接的真实请求）：代码只经审查 + fetch 拦截模拟（成功/失败 UI 路径、请求形状已验），**用户明确要求亲自测试**——自动循环默认关闭，不配置 API 完全不影响其他功能。用户测后关注：真实请求是否成功、解说质量、token 用量（摘要 ~1k token/次，测试连接仅 1 token）。
- **⤒ 导入按钮**的文件选择全链路（IAB 不支持 file chooser）。
- 长时挂机（小时级）内存与 metrics 抽稀（阈值 8000）；移动端/小窗口；多语言。

## 四、架构红线（改代码前必读，违反 = 破坏产品根基）

1. **确定性**：引擎（`src/engine/`）内只允许 IEEE 754 精确规定的 `+ − × ÷ √` 与整数位运算；**禁止** `Math.sin/cos/exp/log/pow/hypot`（高斯用 Irwin–Hall、方向用拒绝法、小角旋转线性近似）。所有随机走 `Rng`（mulberry32），快照保存 `rngState`。改动引擎必跑 `tests/engine/determinism.test.ts`。注意：AI/玩家的干预都是「外部输入」，在 tick 边界注入，不破坏两次干预之间的确定性。
2. **能量守恒账本**：进食/咬伤是转移；代谢（含衰老加成）、移动、攻击消耗、危险区、繁殖开销、瘟疫伤害、死亡遗能入 `dissipated`；尸体入 `corpseEnergy`（格子容量钳制）；饿死负余额冲减耗散。改能量学常量必须保持 `tests/engine/energy.test.ts` 恒等式。
3. **帧与 store 分离**：模拟状态归 Worker；渲染直接读 `SimClient.latestFrame`（stride=8 transferable）；store 只收 250ms 节流数据，且 **simManager 用累积缓冲**（samples/events 全量保留，只有帧状态取最新）——不要回退成覆盖式缓冲（那会丢事件），也不要把高频帧接进 React。
4. **`SimCounters.deathsByCause` 是嵌套对象**：`lastMetricCounters` 与快照必须用 `cloneCounters` 深拷贝，浅拷贝会让死因增量错乱。
5. **图表节流**：MetricCharts 每秒检查 metrics 长度、仅变化时 setOption；详情卡折叠状态存 localStorage `gl-charts-open-v1`（默认全开）。
6. **快照节奏**：simManager 运行中每 5s + 暂停瞬间；恢复的实验强制 `running: false`。
7. **物种命名/描述是纯函数**（`engine/naming.ts`）：改它不影响轨迹，但会影响新物种的名；旧快照物种缺特征由 worker `ensureDescription` 惰性补算。

### 已知语义怪癖（改前先问用户）

- **障碍物实际不阻挡个体**：`passable` 用浮点索引 TypedArray 得 undefined=可通行（历史行为）；moveAgent 的整数判定快路径**逐位保持**了这一语义。改 = 改生态（滑行/调头逻辑会突然生效），未获用户点头前别动。

## 五、文件地图

```
src/
├─ engine/            # 纯 TS 引擎（无 DOM）:
│  ├─ sim.ts          #   主循环+能量学+生态压力(拥挤应激/衰老/灾变)+里程碑+死因账本+killMatrix
│  │                  #   +有性繁殖(求偶/交叉/双亲付费)+死亡热区网格
│  ├─ world.ts        #   网格+噪声+食物再生(旱灾倍率)
│  ├─ genome.ts       #   基因+突变+遗传距离+crossoverGenome(均匀交叉)
│  ├─ behavior.ts(感知决策+intent+prey) / species.ts(聚类+事件)
│  ├─ naming.ts       #   物种命名器:中文俗名[形体][颜色][类群]+拉丁双名+标签+生态位(纯函数)
│  ├─ rng.ts / spatial.ts / presets.ts(normalizeSpec) / specSchema.ts(zod) / types.ts
├─ workers/sim.worker.ts    # 模拟 Worker:自调度 tick(16ms/预算12ms)、帧编码(含 deathHeat)、全量物种名单(含世代)
├─ client/            # protocol / simClient(含 InspectInfo) / simManager(累积缓冲!)
├─ render/            # renderer(360色相精灵图集+批量矩形+食物节流+热力叠加 setOverlay/updateDeathHeat) / camera
├─ llm/               # provider(OpenAI兼容+testConnection) / worldgen / rulesFallback
│  └─ observer.ts     # 世界摘要 buildWorldDigest + AI 说书人 requestNarration + 军师 requestAdvice
├─ persistence/       # db.ts IndexedDB / serialize.ts 导入导出
├─ store/             # experiments zustand / types(SpeciesMeta 带特征+世代) / persistence
├─ components/        # Chart / MetricCharts(折叠状态持久化) / WorldPulse(七节世界报告) /
│                     # panels(物种卡+传记下钻+检查器+事件流+规则面板) / NarratorBar(字幕条+军师) /
│                     # PhyloTree(谱系时间轴树) / PlaybackBar / GenomeBars /
│                     # SettingsModal(厂商预设芯片+免费注册入口+AI 观察员节+测试连接) / GuideOverlay
└─ views/             # Home(家族树) / Create / Observatory(画布交互+tooltip+高亮+侧栏拖宽+叠加切换) / Compare
tests/                # 55 个:engine(确定性/能量/生态/物种/命名/死因/有性) · llm · persistence
bench/perf.bench.ts   # 性能基准（tsx 运行）
```

## 六、路线图（用户拍板的方向：观察有意思 + 有限干预；已否决挑战/过关与成就图鉴）

0. **解说气泡截断修复（用户已报，小活）**：NarratorBar 胶囊 `max-w-[520px] truncate` 截断长解说句——允许换行至 2~3 行或点击展开全文；军师回答面板如有同样问题一并处理。
1. **AI 对手神（第二期，让 AI 真正影响世界）**：AI 定期读世界摘要 + 一个目标（『让疾羚称霸』/『最大化多样性』），返回结构化动作（撒食位置/天罚对象/规则调整），zod 校验+上限钳制后经引擎执行；与玩家的神迹三件套共用同一套动作空间——**依赖第 2 项神迹工具先落地**。频率/成本旋钮同说书人。
2. **导演模式**：镜头自动切到追捕/分化/灾变现场（事件已有，缺镜头调度）；随时手动接管。
3. **守护与神迹**：每世界限守护 2–3 个物种/王朝（大事提醒+曲线常驻）；神迹三件套（撒食/天罚/赐福，带冷却）+ 神迹簿日志。
4. **预言面板**：「猎物跌破 300,尖牙狼氏预计两千 tick 内闹饥荒」——基于承载力的简单推算。
5. 有性繁殖物种的拉丁名可能撞名（如尖牙虎/尖牙狼同为 Panthera ferox）——命名器种加词空间小，可考虑按色相/体型微调种加词。
6. 神经网络大脑（`behavior.ts` 决策函数是唯一接入点）：**已评估，本轮未做**——工作量不在代码而在①基因结构大改（9 基因→上百权重，schema/突变/距离全动）②全部预设行为调优失效 ③物种卡可读叙事失效。若做：做成「可选大脑」而非替换，单独开轮。
7. 分享实验链接 / WebGL 渲染（个体 >5k 再说）。

## 七、环境快照（交接时刻）

- **GitHub**：https://github.com/pphun811-maker/genesis-lab （**public 开源**，main 分支，最新 `0a42659`；改动后 `git add -A && git commit && git push` 即可同步）。`.gitignore` 排除 node_modules/dist/tsconfig.tsbuildinfo/.zcode。
- dev server 在 **5175**（后台任务,会话结束即停）；4173 preview 已停。接手自己 `npm run dev`。
- 5175 origin IndexedDB 有多个实验（含用户亲手创建的「突变沸腾」~2.9k 个体 29 物种,以及本轮测试的猎食军备竞赛及分叉）；4173 有一个 preview 测试用的和平花园。
- `tsconfig.tsbuildinfo` 是 build 缓存产物,已进 .gitignore,别删。
- 用户原则：**一切以实测为准**（本文档所有 ✅ 均为本轮实测）。
