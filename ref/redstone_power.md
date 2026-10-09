# 红石充能与传导（1.21.11 反编译实锤）

来源：`duollectis/minecraft-decompiled-1.21.11`（GitHub API contents 端点拉取，`ref=main`）。
拉取命令模板：
```
curl -s -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/duollectis/minecraft-decompiled-1.21.11/contents/<path>?ref=main"
```
（`raw.githubusercontent.com` 直连会 exit 56；`minecraft.wiki` 403 bot 拦截；GitHub API contents 端点可用。）

本文件只记**从源码逐条核实**的红石事实，供「音量还原 Z 偏移」功能与布局设计引用。

## 1. 功率范围
- `net/minecraft/RedstoneSignalRange.java`：`RANGE_START=0`、`RANGE_END=15`、`CHANNEL_MIN=4`、`CHANNEL_MAX=15`。
  → 红石功率 **0~15，15 = 满**。

## 2. 红石粉功率计算（逐格 −1）
- `RedstoneController.calculateWirePowerAt`（`world/RedstoneController.java` L47-69）：
  某粉格功率 = `max(相邻粉功率) − 1`（`Math.max(0, maxPower - 1)`）。
  → **每经过一个粉 −1**；只统计 `getWirePowerAt` 认可的邻居。
- `getWirePowerAt`（L34-36）：`state.isOf(wire) ? state.get(POWER) : 0`
  → **粉链只通过「粉↔粉」传播**；非粉方块（含音符盒）对粉链贡献恒 0。
  → **粉不能穿过非粉导体（如音符盒）**：`粉—盒—粉` 结构中，盒收能发声但**截断粉链**，远盒/远粉收不到能。
- `DefaultRedstoneController.calculateTotalPowerAt`（L54-57）：
  `strongPower==15 ? 15 : max(strongPower, wirePower)`
  → 粉被强充能 15 时取 15，否则取 max(强充能, 线功率)。

## 3. 强充能 / 弱充能
- 强充能（strong）：中继器输出端、红石块等**直接**向相邻给 15（`getStrongPower` 查 `world.getReceivedRedstonePower`，`RedstoneWireBlock` L339-344）。
- 弱充能（weak）：导体（粉/盒/火把）从相邻源收能并向相邻传导。
- `RedstoneWireBlock.getWeakRedstonePower`（L429-448）：
  粉向相邻导体弱充能 = **粉自身 `POWER` 值**（条件：`direction != DOWN` 且该方向有连接）。
  → 一个 power=15 的粉，向相邻导体弱充能 15；下游粉 `−1` → 14，逐格衰减。

## 4. 音符盒 = 导体终端
- `NoteBlock`（`block/NoteBlock.java`）：有 `POWERED` 状态；`neighborUpdate`（L108-124）收能当 tick `playNote`（发声 + 触发相邻更新）。
- 盒是**导体**：收能发声，且**弱充能相邻块**（现有 slot1/slot2 = 主盒被强充能后激活 zc±1 的盒，即此机制）。
- 但盒**不向粉链回传**（粉链传播只认 `isOf(wire)`，见 §2）：
  → 盒可作分支**源**（弱充能首段粉）或分支**末端**（由相邻粉供电），但**不能处于粉链中间**（`粉—盒—粉` 中盒截断粉链，远端收不到能）。
  → 音量还原 ≤2 盒/tick（主盒 + 偏移盒）可行：主盒在 zc（被中继器强充能=15），偏移盒在 zc+Δz（纯粉分支末端），分支路径全粉（无中间盒）→ 同 tick 触发（与 slot1/2 同机制）。
- **盒上方遮挡 = 完全静音**（`playNote` L126-131）：
  `if (state.get(INSTRUMENT).isNotBaseBlock() || world.getBlockState(pos.up()).isAir())` 才发 `BlockEvent`
  → 任何非空气盖在盒正上方 = 不发声（连粒子无）。本项目产物必须保证每个盒 `pos.up()` 为空气（validate `badTop` + README 清单双护栏）。

## 5. 对「音量还原 Z 偏移」的直接影响
1. **分支可达距离**：主位（被中继器强充能 = 15）→ 分支粉沿 Z 逐格 −1 → 盒只需邻格功率 ≥1
   → 盒到主位曼哈顿距离 **|Δz| ≤ 15**（纯 Z 分支，盒在分支末端）。
2. **分支必须走纯粉链**（§2 粉不穿盒）→ 分支路径上不能有其他盒；每音 1 盒。
3. **同 x 列分支 Z 跨度 ±15** → 多轨**同 y 层**时，两条轨的 zc 需**间隔 ≥ 30** 否则分支/盒在同 x 列的 Z 上撞格（同一 `(x,ySig,z)` 不能放两个粉/盒）。
4. **多轨全覆盖需 y 层堆叠**：N 条复制轨要 zc 集中（都在远端 33~48，见 volume_restore 分析）时，同 y 层必撞 → 必须垂直错 N 层（yb~yb+N−1），分支不同 y 不撞。
5. **上方空气**：分支粉/盒都在信号层 `yb+1`，其 `pos.up()`=`yb+2` 无物（轨道 0 导轨/ CB 在 yb+2 但避开盒列）→ 满足 §4 遮挡约束。

## 6. 已拉取源码文件清单（$TMPDIR 本地缓存，可复查）
- `RedstoneWireBlock.java`（20754 B）— 粉状态/弱功率/连接
- `RedstoneController.java`（2619 B）— 功率计算基类
- `DefaultRedstoneController.java`（1675 B）— 默认控制器（−1 衰减）
- `RedstoneSignalRange.java`（560 B）— 功率范围常量
- `NoteBlock.java`（230 行）— 盒发声/遮挡/乐器判定（前序会话已拉）
- `Level.java` 404（本仓无此文件；充能逻辑在 `world/RedstoneController*` 与 `block/RedstoneWireBlock`）
