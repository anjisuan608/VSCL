# 第三方声明（Third-Party Notices）

VSCL 本体以 **AGPL-3.0-or-later** 授权（见 [LICENSE](./LICENSE)）。
本文件登记本项目**实际包含**的第三方代码与资源；仅作设计参考而未复制代码的项目列于第 3 节。

---

## 1. HMCL (Hello Minecraft! Launcher)

- **来源**：<https://github.com/HMCL-dev/HMCL>
- **授权**：GNU General Public License v3（附附加条款，见其仓库 README「开源协议」节）
- **版权**：HMCL 贡献者（2015 年至今，140+ 位贡献者）
- **移植操作规范**：见 [COMPLIANCE.md](./COMPLIANCE.md) 第 3 节（白名单 + SOP）

> **状态：当前版本不包含任何 HMCL 代码。**
> 每次按白名单流程移植后，在下表逐项登记（含上游 commit 与许可表述 only/or-later 的核对结果）。

| 文件/模块 | 上游路径 @ Commit | 用途 | 移植理由 | 上游许可表述 |
|---|---|---|---|---|
| —（暂无） | — | — | — | — |

## 2. XMCL / minecraft-launcher-core-node（MIT）

- **来源**：
  - <https://github.com/Voxelum/x-minecraft-launcher>
  - <https://github.com/Voxelum/minecraft-launcher-core-node>（npm：`@xmcl/core`、`@xmcl/installer` 等）
- **授权**：MIT
- **使用情况**：
  - `src/core/modloader/forgeInstaller.ts`（Forge/NeoForge 安装引擎）**流程与数据结构参考**其 `@xmcl/installer`（`forge.ts` / `profile.ts`）的公开实现——install_profile 解析、jar 内 maven 释放、BINPATCH 数据重写、processor 执行模型；为基于 VSCL 自有基建（minimalZip/downloader）的独立编写，非逐行复制
  - 未以 npm 依赖形式引入其代码

适用的 MIT 授权全文（亦见 [LICENSES/MIT.txt](./LICENSES/MIT.txt)）：

```text
MIT License

Copyright (c) 2023 ci010 (cijhn@hotmail.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. 仅作设计参考、未包含代码的项目

以下项目的**思想、设计与公开规范**不受其许可证约束（思想不受版权保护）；VSCL 对应实现均为独立编写的 TypeScript 代码：

- **HMCL**：功能设计与行为参考——配置模型（全局预设 + 实例覆盖）、Java 检测路径、下载镜像策略、崩溃分析思路、UI 信息架构等
- **Mojang/Microsoft 官方文档**：版本 JSON、启动协议、下载端点、Java runtime manifest
- **Minecraft Wiki**：数据格式（NBT、pack_format、协议版本）
- **Modrinth / CurseForge 公开 API 文档**

## 4. 许可证文本索引

| 许可证 | 位置 |
|---|---|
| AGPL-3.0（VSCL 本体） | [LICENSE](./LICENSE) |
| GPL v3（HMCL 移植代码适用） | [LICENSES/GPL-3.0.txt](./LICENSES/GPL-3.0.txt) |
| MIT（XMCL 等适用） | [LICENSES/MIT.txt](./LICENSES/MIT.txt) |
