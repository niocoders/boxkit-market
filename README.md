# BoxKit Market

`niocoders/boxkit-market` 是 BoxKit 的独立公开插件仓，也是市场的唯一插件源码来源。主仓不再作为公开市场源码或发布中转站；插件作者直接向本仓的 `plugins/` 提交变更，GitHub Actions 会校验、打包并部署 GitHub Pages。

市场地址：<https://niocoders.github.io/boxkit-market/>

## 目录

- `plugins/`：已发布插件源码，每个子目录必须包含 `plugin.json` 和入口文件。
- `template/`：可复制的最小插件模板。
- `tools/build-market.mjs`：独立、零依赖的校验和构建脚本。
- `site/`：Pages 部署目录。`site/manifest.json`、`site/plugins/*.bkx` 和 `site/logo/*` 由构建生成，不把源码目录直接作为 Pages 内容。

## 本地命令

要求：Node.js 20 或更高版本；安装 pnpm 10（或使用兼容的 pnpm 版本）。

```bash
pnpm install
pnpm market
# 等价命令：pnpm build
```

也可以不安装依赖直接运行：

```bash
node tools/build-market.mjs
```

构建会读取 `plugins/`，完整校验 `plugin.json` 与资源路径，并生成 `site/manifest.json`、`site/plugins/*.bkx` 和 `site/logo/*`。`.bkx` 是 ZIP 格式的 BoxKit 插件包，构建使用固定时间戳，重复构建得到相同的包内容和 SHA-256。提交源码即可触发 workflow，通常不需要提交生成的 `site` 产物。

## 插件清单与兼容性

插件清单遵循 BoxKit 的 `features`、`cmds`、`main`、`preload` 约定，必须有合法的 `name`（2-64 位小写字母/数字/中划线）、`displayName`、三段式 `version`、至少一个 feature 和有效入口。支持 BoxKit 权限：`clipboard`、`db`、`notify`、`network`、`shell`、`screen`、`window`。

同时兼容常见的 legacy format 清单写法：

- 可以保留 legacy format 的 `pluginName`；构建清单会把它稳定归一化为市场 `pluginId` 和显示名，压缩包内的 `plugin.json` 原样保留。
- 正则命令可以使用 legacy format 的 `minNum`，构建清单会按 `minLength` 语义归一化。
- BoxKit 提供与 legacy format 对应的运行时 API，但具体 API、权限和 Node 能力取决于 BoxKit 宿主版本；安装来自不可信来源的插件等同于授予其插件运行权限。

`.bkx` 是本市场和 BoxKit 使用的插件包扩展名；`.upx` 是 legacy format 生态的原生分发扩展名，不能直接当作本仓的 `.bkx` 发布物。需要发布 `.upx` 时，请遵循 legacy format 官方工具链，并同时确认插件能在目标宿主中运行。

## 发布方式

1. 从 `template/` 复制一个插件目录，或将现有插件放入 `plugins/<directory>/`。
2. 确保目录含 `plugin.json`、`main` 指向的入口以及可选 `preload`/`logo` 文件。
3. 提交并推送到 `main`。
4. `Publish market` workflow 在 Ubuntu 上运行 `node tools/build-market.mjs`，上传 `site/` artifact，并由 GitHub Pages 部署。

门户和客户端使用同一份 `site/manifest.json`。清单中的 `fileUrl`、`logoUrl` 是相对于清单的路径；客户端会下载 `.bkx` 并校验 `sha256` 后再进入标准安装流程。
