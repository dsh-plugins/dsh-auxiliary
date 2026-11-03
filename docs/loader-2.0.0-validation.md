# dsh-loader 2.0.0 迁移验证

验证日期：2026-10-30。迁移范围：dsh-auxiliary、dsh-approve-for-me、dsh-thought-buddy；插件版本统一为 2.0.0。开发锁定已发布的 loader `2.0.0-dev.41037890182`，peer 接受 `^2.0.0-0`。

## 自动化

- auxiliary：58 项 Node 测试，覆盖版本边界、客户端产物 DOM/延迟写入、嵌套模板、图片转交、官方审批路由，以及翻译缓存/取消/卸载。
- approve-for-me：65 项测试，含配置入口更新策略作用域、卸载后执行代理停用及保留第三方包装器。
- thought-buddy：产物验证覆盖 SVG、动画、打字机、即时配置开关/模式切换与异步读取后卸载。
- 三个包均执行类型检查、构建、`npm ci --dry-run` 锁文件检查和 npm pack 发布文件检查。

## 真实 dsh 启动矩阵

每个版本均在独立 DSH_HOME/profile 中加载辅助模型与思考搭子；早于 `0.1.7-rc.2` 同时加载 approve-for-me，之后启用官方自动审查。从 `0.2.1-rc.1` 起再加载官方翻译 bundle。验证支持的模板注册、认证配置接口、保存后读回、独立磁盘文件、修订冲突、配置更新后进程存活和版本化客户端启动描述，并检查新版翻译补丁确实激活。没有调用外部付费模型。

| dsh 版本 | 结果 |
| --- | --- |
| `0.1.5-alpha.1` | 通过 |
| `0.1.5-alpha.2` | 通过 |
| `0.1.5-rc.1` | 通过 |
| `0.1.5-rc.2` | 通过 |
| `0.1.6-alpha.1` | 通过 |
| `0.1.6-alpha.2` | 通过 |
| `0.1.5-rc.3` | 通过 |
| `0.1.7-alpha.1` | 通过 |
| `0.1.7-alpha.2` | 通过 |
| `0.1.7-rc.1` | 通过 |
| `0.1.7-rc.2` | 通过 |
| `0.2.0-rc.1` | 通过 |
| `0.2.0-rc.2` | 通过 |
| `0.2.1-alpha.1` | 通过 |
| `0.2.1-alpha.2` | 通过 |
| `0.2.1-alpha.3` | 通过 |
| `0.2.1-alpha.4` | 通过 |
| `0.2.1-alpha.5` | 通过 |
| `0.2.1-rc.1` | 通过 |
| `0.2.1-rc.2` | 通过 |
| `0.2.1-rc.3` | 通过 |
| `0.2.1-rc.4` | 通过 |
| `0.2.2-alpha.2` | 通过 |
| `0.2.1-rc.5` | 通过 |

`0.1.6-alpha.1` 沿用前次运行环境的显式 override：将其间接 `dsh-app-boot` 固定到同版，避免上游依赖浮动导致的 `watchUserPatches` 启动失败。其他版本保留各自锁定的依赖解析。

复现（四个仓库及 network-settings 放在同级目录）：

```sh
node ../dsh-network-settings/scripts/prepare-launch.mjs --alpha1-app-boot-pin
node scripts/test-migrations.mjs
node scripts/test-migrations.mjs --version=0.2.2-alpha.2 --keep
```

先构建 loader 和三个插件。脚本复用 network-settings 缓存中的独立版本安装；版本清单读取 loader 仓库中冻结的 fixture。结果和服务日志在 `.cache/launch/`，浏览器测试服务使用 `.cache/browser-launch/`。测试配置不触碰个人 profile。

## 浏览器

使用 Computer Use 在真实浏览器验证 `0.1.5-alpha.1` 和 `0.2.2-alpha.2`：

- 旧版聚合页列出三个默认折叠卡片；保存 thought-buddy 尺寸后磁盘值为 24。
- 新版辅助模型详情页显示 config-api 原生槽位，保存输出上限后磁盘值为 4000。
- 辅助模型全部分组内可见 label 均实测为 112 px；fieldset 使用 10 px 圆角，legend 断开上边框。
- 两个页面未捕获到客户端 warn/error。截图保存在 `.cache/screenshots/`。

模型目录的两个断点另由客户端产物 DOM 回归验证：`0.1.7-rc.1` 起停用输入类型增强，`0.2.1-rc.1` 起停用推理等级增强，命名版本本身包含在断点内；同时验证模型重命名后的延迟写入只触及仍由插件负责的能力。

## 迁移注意

配置持久化与表单交给 loader；旧的 settings 命名空间与 localStorage 不自动导入。辅助模型的提供方/模型 ID 使用文本输入。跨字段路由完整性和压缩比例关系仍由宿主运行时验证，非法快照保留上次有效运行配置并记录错误。外部模型的真实推理、生图和审批请求需要使用者配置凭据后另行验收。

## 官方插件集成补充验证

- approve-for-me 的市场支持范围缩小为 `[0.1.5,0.1.7-rc.2)`，宿主和浏览器入口在上限版本起跳过旧逻辑。
- `approve` 在上限版本起识别官方 `REVIEW_POLICY` / `ENVIRONMENT` 审查请求，保留策略、消息、温度、信号和会话归属；不修改裁决。
- 翻译选择器展示宿主已配置的全部提供商与模型。官方 API 路由保留原生凭据和资格检查，第三方路由通过宿主 LLM 接口检查所选模型并调用，不依赖官方 API 凭据。旧配置省略提供商时保留 `deepseek-official`。
- 缓存查询与会话 request 记录包含所选提供商和模型，审计元数据保留实际 prepared call；不同提供商的同名模型分别缓存。第三方推理模型只保存最终翻译文本，超时、取消、非法响应和存储错误保留各自错误码。
- `node scripts/test-official-contracts.mjs --fixtures=<目录>` 验证六个真实 npm 翻译实现：`0.2.1-rc.1`、`rc.2`、`rc.3`、`rc.4`、`rc.5`、`0.2.2-alpha.2`。目录按 `<版本>/package.json` 安装对应翻译包及其 peer 依赖。测试通过公开构造函数创建真实 Cordis、翻译和 Session 服务，模型流与持久化接口使用内存数据，验证官方资格检查、第三方提供商、同名模型缓存、推理文本过滤、输入限制与卸载恢复。
- 浏览器验证继续使用隔离 profile，不输入模型凭据或执行付费翻译。

新增配置页已在 `0.2.2-alpha.2` 的真实浏览器验证：官方自动审查与翻译分组均显示，保存 `translation.model=deepseek-flash` 后按钮恢复禁用，profile 文件同步。新增最长 label 后全卡片 label 实测统一为 129 px，未捕获客户端 warn/error。截图为 `.cache/screenshots/official-models.jpg`。
