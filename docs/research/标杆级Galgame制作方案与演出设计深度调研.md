# 标杆级 Galgame 制作方案与演出设计深度调研报告

> **调研目的**：深入解构日本顶级商业 Galgame 厂商（Type-Moon、Key 社、Leaf/Aquaplus、Frontwing、柚子社）及 Steam 全球现象级视觉小说（DDLC、Slay the Princess、ATRI、NEEDY STREAMER OVERLOAD）的**工业化制作管线、角色塑造方法、镜头语言与舞台演出编排技术**，为《All Novel Can Be Galgame》从小说文本到自动化生成高质量视觉小说提供顶层算法设计与工程化规则映射。

---

## 目录

1. [日本顶级商业 Galgame 厂商核心技术与演出风格解构](#一日本顶级商业-galgame-厂商核心技术与演出风格解构)
   - 1.1 [Type-Moon（型月）：2D 电影化动态拼合的天花板](#11-type-moon型月2d-电影化动态拼合的天花板)
   - 1.2 [Key 社（Visual Arts）：“泣系”情感呼吸感与视听节拍](#12-key-社visual-arts泣系情感呼吸感与视听节拍)
   - 1.3 [Leaf / Aquaplus（丸户史明）：“现实主义空间感”与三角心理站位](#13-leaf--aquaplus丸户史明现实主义空间感与三角心理站位)
   - 1.4 [Frontwing & 枕社：宽画幅电影感与 Material Separation 分层](#14-frontwing--枕社宽画幅电影感与-material-separation-分层)
   - 1.5 [柚子社（Yuzusoft）：商业萌系标准 3 锚点与 Q 版差分流水线](#15-柚子社yuzusoft商业萌系标准-3-锚点与-q-版差分流水线)
2. [Steam 全球现象级视觉小说创新技法](#二steam-全球现象级视觉小说创新技法)
   - 2.1 [《Doki Doki Literature Club!》(DDLC)：Ren'Py 边界突破与心理演出](#21-doki-doki-literature-club-ddlcrenpy-边界突破与心理演出)
   - 2.2 [《Slay the Princess》：手绘极端推镜与视差分支](#22-slay-the-princess手绘极端推镜与视差分支)
   - 2.3 [《ATRI -My Dear Moments-》：光影粒子与情绪特写插画 (Cut-in)](#23-atri--my-dear-moments-光影粒子与情绪特写插画-cut-in)
   - 2.4 [《主播女孩重度依赖》(NEEDY STREAMER OVERLOAD)：视窗化多重交互](#24-主播女孩重度依赖needy-streamer-overload视窗化多重交互)
3. [商业级 Galgame 核心制作规范与通用参数矩阵](#三商业级-galgame-核心制作规范与通用参数矩阵)
   - 3.1 [景别五级矩阵 (Shot Size Standard)](#31-景别五级矩阵-shot-size-standard)
   - 3.2 [表情与姿态分层体系 (Layered Expression Matrix)](#32-表情与姿态分层体系-layered-expression-matrix)
   - 3.3 [舞台站位与 180 度轴线调度法则 (Blocking & Staging Rules)](#33-舞台站位与-180-度轴线调度法则-blocking--staging-rules)
   - 3.4 [镜头运动与特效语法 (Cinematographic Motion)](#34-镜头运动与特效语法-cinematographic-motion)
4. [对《All Novel Can Be Galgame》AI 管线的工程化落地指导](#四对-all-novel-can-be-galgame-ai-管线的工程化落地指导)
   - 4.1 [小说文本情感强度分类器 (Text Emotion & Tension Classifier)](#41-小说文本情感强度分类器-text-emotion--tension-classifier)
   - 4.2 [VN Mapping 智能舞台导演算法 (Smart Directing Algorithm)](#42-vn-mapping-智能舞台导演算法-smart-directing-algorithm)
   - 4.3 [Visual Prompt 景别与表情解耦提取器](#43-visual-prompt-景别与表情解耦提取器)
   - 4.4 [Asset 管线 Alpha 抠图与 Ren'Py ATL 代码生成](#44-asset-管线-alpha-抠图与-renpy-atl-代码生成)

---

## 一、日本顶级商业 Galgame 厂商核心技术与演出风格解构

```
+---------------------------------------------------------------------------------------+
| 厂商/作品               | 引擎/核心技术          | 演出设计流派       | 最具代表性的工业手法      |
+---------------------------------------------------------------------------------------+
| Type-Moon《魔法使之夜》  | KiriKiri 2 (深度定制)  | 2D 动态电影拼合派  | 极端多图层拼合、视差平移、毫秒级运镜快切 |
| Key 社《CLANNAD》       | RealLive / SiglusEngine| 情感呼吸感渲染派   | 腰部中景基准、视听节拍同步、环境四季渲染 |
| Leaf《白色相簿 2》       | 私有引擎               | 现实主义戏剧派     | 严格三角站位距离博弈、微表情迟滞、冷暖调 |
| Frontwing《灰色三部曲》  | KiriKiri / Live2D      | 好莱坞宽画幅动作派 | 21:9 宽屏构图、身体分层联动、特写 Cut-in |
| 柚子社《千恋＊万花》      | YUZU 专用引擎          | 工业化萌系标杆     | 3 锚点严密站位、表情差分矩阵、Q 版插图切换 |
+---------------------------------------------------------------------------------------+
```

### 1.1 Type-Moon（型月）：2D 电影化动态拼合的天花板

以《魔法使之夜》（*Mahoutsukai no Yoru*）为代表，型月证明了**文字游戏在纯 2D 素材下，通过演出编排能够达到超越普通 TV 动画的视听张力**。

#### 核心技术手段：
1. **纯 2D 素材的“拟 3D 视差（2.5D Parallax）”**：
   - 场景并非一张死板背景，而是被拆解为 **前景（如树枝/栏杆）+ 中景（角色立绘）+ 背景（建筑物）+ 远景（天空/月亮）**。
   - 当镜头横向摇移（Pan）时，前景快速移动、角色中速移动、背景慢速移动，产生强烈的空间立体感。
2. **多机位快速分镜切换（Cinematic Multi-Angle Cuts）**：
   - 在高潮动作或激烈对质中，放弃传统单机位对话，在 3~5 秒内连续切换 4~6 个不同景别（全景站位 → 眼神特写 → 脚步后撤特写 → 仰视半身像）。
3. **“堆料式”特殊情境专有分镜（One-off Cut-ins）**：
   - 关键情节不使用通用立绘，而是为特定动作单独绘制定制构图（如久远寺有珠指尖点茶、苍崎青子拉开抽屉的瞬间）。

---

### 1.2 Key 社（Visual Arts）：“泣系”情感呼吸感与视听节拍

以《CLANNAD》、《AIR》、《Kanon》、《Summer Pockets》为代表，Key 社代表了 Galgame 在**长篇叙事中把握读者心理与情感共鸣的最高水平**。

#### 核心技术手段：
1. **“日常闲谈”到“情感爆发”的呼吸感控制（Pacing & Tension Rhythm）**：
   - **日常社交（60%）**：采用 **Waist-Up（腰部中景）**，视线平视，对白节奏舒缓（Text Pause 0.3s~0.5s），配合轻快 BGM 与角色诙谐表情（汗颜、叉腰）；
   - **转折与高潮（20%）**：对白骤然紧凑，立绘推近至 **Bust-Up（胸像近景）**，背景音乐切入钢琴/弦乐泪点旋律，立绘表情切换为微垂眸（`sad`）或含泪（`crying`）。
2. **环境天气与人物心境的通感（Atmospheric Sympathy）**：
   - 角色遭遇重大挫折时，场景无缝切换为雨景（叠加透明雨丝粒子），色调降低饱和度 20%；
   - 角色释怀时，切换为樱花飘落或黄昏暖阳。

---

### 1.3 Leaf / Aquaplus（丸户史明）：“现实主义空间感”与三角心理站位

以《WHITE ALBUM 2》（白色相簿 2）为代表，丸户史明操刀的剧本与演出展示了**如何仅凭静态立绘与站位距离，展现窒息般的三角情感纠葛**。

#### 核心技术手段：
1. **空间距离表达心理距离（Proxemics & Blocking）**：
   - 亲密信任时：两角色分别位于 `left` 与 `center`（间距仅 20% 屏幕宽度），说话者立绘轻微放大 5%；
   - 猜疑与隔阂时：一角色退至 `left_far`（15% 处），另一角色立在 `right_far`（85% 处），形成横跨整个屏幕的冷淡距离；
   - 偷看与背叛时：第三者立绘以半透明或小比例置于背景深处（`scale: 0.7, alpha: 0.6`），形成“过肩窥视”效果。
2. **微表情迟滞与沉默演出（Micro-Expressions & Dramatic Silence）**：
   - 遇到重大质问时，不立即出对白，先下发指令：`expression: shocked -> expression: looking_away -> pause 1.2s -> say: "……对不起"`。

---

### 1.4 Frontwing & 枕社：宽画幅电影感与 Material Separation 分层

以《灰色三部曲》（*Grisaia* 系列）、《ATRI -My Dear Moments-》为代表，Frontwing 将好莱坞电影分镜与现代化 2D 分层动画工业化结合。

#### 核心技术手段：
1. **21:9 宽画幅构图（Cinemascope Aspect Ratio）**：
   - 模拟电影宽银幕，左右视野开阔，同屏可自然容纳 4~5 人而互不遮挡。
2. **素材分层（Material Separation & LayeredImage）**：
   - 头部、头发、五官（眼/眉/嘴）、躯干、手臂单独分层；
   - 对话时嘴部微动（Lip-sync），眼神在说话时与玩家对视、思考时向上微偏。

---

### 1.5 柚子社（Yuzusoft）：商业萌系标准 3 锚点与 Q 版差分流水线

以《千恋＊万花》、《RIDDLE JOKER》、《天使☆嚣嚣》为代表，柚子社是商业萌系 Galgame 工业化流水线最稳定、最高效的代表。

#### 核心技术手段：
1. **严格的三锚点站位标准**：
   - 任何场景严格遵循 `Left (30%)`, `Center (50%)`, `Right (70%)` 绝对物理坐标；
   - 说话者：亮度 100%，不说话者：亮度降低 15%（Dimming）并轻微缩小 2%，保证视觉焦点绝对唯一。
2. **严肃与搞笑的 Q 版立绘快速切入（SD Chibi Inserts）**：
   - 角色吃瘪或被调侃时，0.1 秒内将标准立绘替换为 Q 版大头立绘（伴随轻微弹性缩放动画），瞬间调和剧情节奏。

---

## 二、Steam 全球现象级视觉小说创新技法

```
+---------------------------------------------------------------------------------------+
| 游戏名称                  | 引擎           | 核心创新点                               |
+---------------------------------------------------------------------------------------+
| 《Doki Doki Literature Club!》| Ren'Py 原生    | 破坏第四面墙、立绘异常缩放错位、Glitch 故障演出 |
| 《Slay the Princess》      | Ren'Py 原生    | 纯手绘极端特写、分支摄像机多层视差推拉    |
| 《ATRI -My Dear Moments-》 | 特制商业引擎   | 氛围光影粒子叠加、全屏动态立绘与情感特写  |
| 《主播女孩重度依赖》      | Unity          | 桌面 UI 视窗化、多通道信息弹窗沉浸感      |
+---------------------------------------------------------------------------------------+
```

### 2.1 《Doki Doki Literature Club!》(DDLC)：Ren'Py 边界突破与心理演出
- **Ren'Py ATL 的极限操控**：Team Salvato 通过 Ren'Py 的 `transform` 与 `renpy.random` 实现了角色立绘在屏幕边缘突然闪现、立绘瞳孔单独缩放、画面突发撕裂等心理恐怖演出。
- **冲击力镜头**：角色自白时，立绘瞬间由正常半身像放大至 2.0 倍面部特写，完全覆盖文本框，制造强烈的压迫感。

### 2.2 《Slay the Princess》：手绘极端推镜与视差分支
- **黑白素描风格与镜头推拉**：利用 Ren'Py 的 3D Stage（`camera: perspective True`），在关键抉择时刻，摄像机由远景林中小屋一路平滑推近至公主眼前的刀刃，景深缩放比例高达 300%，展现了极强的分镜张力。

### 2.3 《ATRI -My Dear Moments-》：光影粒子与情绪特写插画 (Cut-in)
- **动态光影滤镜**：水下世界与夕阳下，画面上层叠加半透明水波反光、漂浮尘埃粒子（Particle Overlay）；
- **特写插画切入 (Cut-in)**：在关键台词时，屏幕右侧或中央滑入带倾斜角度的角色半身特写框，主背景虚化。

---

## 三、商业级 Galgame 核心制作规范与通用参数矩阵

基于上述标杆案例调研，总结出适用于工业化代码生成的**黄金参数矩阵**：

### 3.1 景别五级矩阵 (Shot Size Standard)

```
[Full-Body 全身] (登场展示/0.8x)
        │
        ▼
[Waist-Up 半身] (日常社交基准/1.0x)  <-- 60% 日常对白必须默认采用
        │
        ▼
[Bust-Up 胸像] (情绪聚焦/1.2x)       <-- 30% 深入对话/关键心声
        │
        ▼
[Close-Up 特写] (重大爆发/1.5x)      <-- 10% 冲突/告白/惊吓
```

| 景别标识 | 截取范围 | 缩放系数 (`scale`) | 画面垂直对齐 | 适用剧情分类 |
| :--- | :--- | :---: | :---: | :--- |
| **`closeup`** | 头顶至下巴/锁骨 | `1.45 ~ 1.60` | `yalign: 0.85` | 极致震惊、深情告白、心理恐惧、耳语 |
| **`bust`** | 头顶至胸口下方 | `1.15 ~ 1.25` | `yalign: 1.00` | 深度交谈、情感交锋、秘密倾诉 |
| **`waist`** | 头顶至大腿中上部 | `1.00` (基准) | `yalign: 1.00` | **标准社交对话、日常闲聊（默认基准）** |
| **`thigh`** | 头顶至膝盖 | `0.90` | `yalign: 1.00` | 展现全身肢体动作、3~4人多角色同屏 |
| **`full_body`**| 头顶至脚底完整 | `0.80 ~ 0.82` | `yalign: 1.00` | 角色初次登场亮相、大厅/广场广角远景 |

---

### 3.2 表情与姿态分层体系 (Layered Expression Matrix)

Prompt 生成必须精准映射至以下 5 大类别：

```
                    ┌── smile (温和微笑) / happy (开朗欢笑)
     ┌── 1. Joy ────┼── blushing (害羞脸红)
     │              └── smug (得意调侃)
     │
     │              ┌── annoyed (不悦皱眉) / angry (生气怒视)
     ├── 2. Anger ──┴── furious (暴怒咬牙)
     │
     │              ┌── troubled (困扰为难) / sad (伤心低落)
表情 ┼── 3. Sadness ┴── crying (落泪/眼眶含泪)
     │
     │              ┌── surprised (微惊)
     ├── 4. Surprise┴── shocked (极度震惊呆滞)
     │
     │              ┌── neutral (常态淡定) / composed (冷静从容)
     └── 5. Neutral ┼── cold (冷淡轻蔑)
                    └── thinking (沉思垂首)
```

---

### 3.3 舞台站位与 180 度轴线调度法则 (Blocking & Staging Rules)

屏幕水平宽度（0% ~ 100%）划分为 5 个黄金锚点：

```
   15%              30%               50%               70%              85%
[left_far]        [left]            [center]          [right]        [right_far]
 次要旁观者        对话主要方A        单人独白/核心主角    对话主要方B     次要旁观者
(远端/准备退场)   (Z-index: 10)     (Z-index: 10)     (Z-index: 10)   (远端/准备退场)
```

#### 智能调度规则（Smart Blocking Rules）：
1. **单人场景**：角色居中 `position: "center"`，景别根据对白内容在 `waist` 与 `bust` 切换。
2. **双人常规对话**：
   - 角色 A 在 `left`，角色 B 在 `right`，**绝不可重叠在 center**；
   - 说话者：应用 `sprite_focus`（微向前放大 2%，亮度正常）；
   - 倾听者：应用 `sprite_dim`（亮度降低 15%，保持倾听表情）。
3. **多人争辩/旁观**：
   - 争论核心双方在 `left` 与 `right`；
   - 插话者或劝阻者在 `left_far` 或 `right_far`，说话时滑动至 `center`。
4. **进出场轨迹**：
   - 登场：从屏幕外向目标位置滑动渐入（`slide_left` / `slide_right` 0.4s）；
   - 退场：向屏幕外滑动渐出并执行 `hide`。

---

### 3.4 镜头运动与特效语法 (Cinematographic Motion)

在剧本中根据对白情感烈度触发镜头特效：

| 特效指令 (`cameraEffect`) | 技术实现 (Ren'Py / Web) | 触发情境规则 |
| :--- | :--- | :--- |
| **`shake_heavy`** | Ren'Py: `with vpunch`<br>Web: `animate-shake-v` | 拍桌子、摔门、倒地、受到严重物理/言语打击 |
| **`shake_light`** | Ren'Py: `with hpunch`<br>Web: `animate-shake-h` | 慌乱摇头、心头一紧、突发声响 |
| **`zoom_in_slow`** | Ren'Py: `camera: ease 2.0 zoom 1.25`<br>Web: `scale-120 duration-1500` | 酝酿表白、内心沉思独白、压迫感步步逼近 |
| **`zoom_punch`** | Ren'Py: `camera: ease 0.15 zoom 1.45`<br>Web: `scale-145 duration-150` | 秘密被揭穿瞬间、猛然抬头、突发警报 |
| **`flash_white`** | Ren'Py: `with Fade(0.1, 0.0, 0.2, color="#fff")`<br>Web: `animate-flash` | 雷电、枪声、眩晕、回忆瞬间闪回 |
| **`reset`** | Ren'Py: `camera: ease 0.8 zoom 1.0`<br>Web: `scale-100` | 情绪平复、新场景开始 |

---

## 四、对《All Novel Can Be Galgame》AI 管线的工程化落地指导

要将上述标杆经验转化为全自动 AI 转译流水线，需在现有 7-Agent 系统中注入以下核心改造：

```
[小说文本]
   │
   ├─► [1. 情感烈度与叙事单元分析 (Narrative Parsing)]
   │     ├─► 标记单元情感烈度: Normal (日常) | Tense (紧张) | Climax (高潮) | Secret (心声)
   │
   ├─► [2. 智能舞台导演 (VN Mapping Agent 升级)]
   │     ├─► 双人自动分列 left / right，杜绝全员 center
   │     ├─► 映射五级景别 shotType (waist, bust, closeup, full_body)
   │     ├─► 识别动作与冲击，下发 cameraEffect (shake_heavy, zoom_in_slow, flash_white)
   │
   ├─► [3. 视觉提示词解耦 (Visual Prompt Agent 升级)]
   │     ├─► 角色 Prompt: 强制锁定 waist-up portrait / bust-up portrait，废除全身硬编码
   │     ├─► 纯色白底约束: solid pure white background, clean lineart (为 Alpha 抠图准备)
   │     ├─► 背景 Prompt: 多样化室内中景/窗边特写，去除单一 wide angle shot
   │
   ├─► [4. 资产透明通道引擎 (Asset Pipeline 升级)]
   │     ├─► 纯白底自动转 32-bit RGBA Transparent PNG (Alpha Cutout)
   │
   └─► [5. 双端呈现引擎 (Runtime & Ren'Py Export 升级)]
         ├─► Ren'Py 导出: 注入标准 ATL 库 (sprite_waist, sprite_bust, vpunch, camera zoom)
         └─► Web 播放器: 实现多景别 CSS Transform 缩放、说话人高亮、震屏动画
```

本调研报告确立了本项目视觉小说生成系统的终极品质标准与算法实现规则。
