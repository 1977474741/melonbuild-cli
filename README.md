# MelonBuild CLI

获取 Figma 设计稿的结构化 AST，并将设计中的图片下载到本地，供 AI 编程工具、Skill 或自定义工作流使用。

- 使用 Figma 账号登录。
- 获取完整 AST 或设计摘要，输出为紧凑 JSON。
- 下载图片，并将 AST 中的图片引用改为本地路径。
- 独立重试图片下载，复用已下载的资源。

网站：[melonbuild.com](https://www.melonbuild.com)

## 从源码运行

需要 Node.js **22.15.0 或更高版本**，使用 pnpm 安装依赖。

```sh
git clone --branch dev-1.0 https://github.com/1977474741/melonbuild-cli.git
cd melonbuild-cli
corepack pnpm install --frozen-lockfile
corepack pnpm run build
node dist/cli.mjs --help
```

以下示例均在仓库目录内运行。登录和设计稿转换需要连接 MelonBuild 在线服务；服务未开放或不可用时，仍可对已有 AST 执行本地图片下载。

## Windows / PowerShell

PowerShell 中可使用以下单行命令，路径包含空格时用双引号包裹：

```powershell
node .\dist\cli.mjs login
node .\dist\cli.mjs node-ast "https://www.figma.com/design/FILEKEY?node-id=12-34" --output ".\design\ast.json" --image-dir ".\public\images"
node .\dist\cli.mjs whoami
```

下文多行示例中的 `\` 是 Bash 续行符，PowerShell 中请改为单行执行。若 PowerShell 的脚本策略阻止 Corepack，可用 `corepack.cmd pnpm ...` 执行相同操作。

Windows 凭据使用用户配置目录的系统权限；Unix 的 `0700` / `0600` 权限检查不适用于 Windows。

## 登录

```sh
node dist/cli.mjs login
node dist/cli.mjs whoami
```

登录时会打开浏览器。核对页面与终端中的登录码，使用 Figma 账号完成登录并确认。已经登录 MelonBuild 网站时，可直接确认 CLI 登录。

无法自动打开浏览器时：

```sh
node dist/cli.mjs login --no-browser
```

按终端提示手动打开链接。退出当前设备：

```sh
node dist/cli.mjs logout
```

如需撤销该账号全部设备上的 CLI 登录凭据：

```sh
node dist/cli.mjs logout --all
```

怀疑旧凭据泄漏时，可先重新登录，再执行此命令。它会使该账号所有 CLI 凭据失效，不退出网站登录。

## 获取设计 AST

在 Figma 中选中目标画板或节点，复制包含 `node-id` 的链接：

```sh
node dist/cli.mjs node-ast \
  'https://www.figma.com/design/FILEKEY?node-id=12-34' \
  --output ./design/ast.json
```

也可以分别传入文件 Key 和节点 ID：

```sh
node dist/cli.mjs node-ast FILEKEY 12:34 --output ./design/ast.json
```

输出固定为紧凑 JSON。目标可以是画板、分区、页面或组件；每次指定一个目标，其内部可以包含多个页面。暂不支持整文件根节点和逗号分隔的多个目标。

不传 `--output` 时，JSON 正文写入标准输出，进度和提示写入标准错误，便于脚本调用。

## 下载图片到本地

添加 `--image-dir`，指定图片保存目录：

```sh
node dist/cli.mjs node-ast FILEKEY 12:34 \
  --output ./design/ast.json \
  --image-dir ./public/images
```

CLI 下载 AST 中引用的图片，并将引用改成相对于 AST 输出文件的本地路径。图片目录与 AST 输出目录可分别指定；不传 `--output` 时，路径相对于当前工作目录。

不指定图片目录时，AST 保留原始图片链接。

### 重试图片下载

下载图片时会保留一份原始 AST。例如指定 `--output ./design/ast.json`，会生成：

| 文件 | 用途 |
| --- | --- |
| `ast.json` | 使用本地图片路径的结果 |
| `ast.json.remote.json` | 保留原始图片链接，供重试使用 |
| `ast.json.remote.json.assets.json` | 下载记录与失败详情 |

部分图片下载失败时，可使用原始 AST 重试：

```sh
node dist/cli.mjs download-images ./design/ast.json.remote.json \
  --image-dir ./public/images \
  --output ./design/ast.json \
  --overwrite
```

此命令无需登录，只读取本地文件并下载其中的图片，不重新生成 AST，也不消耗生成次数。已成功下载且校验通过的图片会被复用。失败的图片保留原始链接。

原始图片链接过期后，需要重新获取 AST。CLI 不会因图片下载失败而自动重新生成。

## 获取设计摘要

```sh
node dist/cli.mjs node-summary \
  'https://www.figma.com/design/FILEKEY?node-id=12-34' \
  --output ./design/summary.json
```

摘要用于浏览设计结构；需要详细节点、样式和图片信息时，使用 `node-ast`。

## 常用选项

| 选项 | 说明 |
| --- | --- |
| `-o, --output <file>` | 保存 JSON 到指定文件 |
| `--image-dir <dir>` | 下载图片到指定本地目录 |
| `--overwrite` | 允许覆盖已有输出文件 |
| `--force-refresh` | 获取最新设计，跳过有效结果缓存 |
| `--reuse <mode>` | 复用模式：`exact`、`none`、`params`、`slots`、`components`，默认 `exact` |
| `--reuse-meta` | 保留复用关系信息 |
| `--with-ids` | 在参数化复用模式中保留全部节点 ID |
| `--no-styles` | 不输出样式块 |
| `--json` | 以 JSON 输出账号信息或错误详情 |
| `--help` | 查看完整帮助 |

## 免费额度

每个账号与网站共用累计 **10 次**免费生成机会，不按月重置。

**前 10 次每次可获取不超过 100 KB（100,000 字节）的完整 AST。** 用完后，仍可免费获取不超过 **30 KB（30,000 字节）** 的完整 AST。大小按完整 AST 的紧凑 JSON UTF-8 字节数计算，包含图片链接，不包含图片文件。目标可以包含多个页面，始终需符合单次处理的体量限制。

- 前 10 次试用期间，成功生成新结果扣一次；有效结果缓存命中不扣。
- 试用用完后，获取不超过 30 KB 的 AST 不再扣次；超过上限会提示订阅。
- 生成失败、超时或 AST 超过当前阶段的大小限制不扣。
- 图片下载失败不撤销已成功生成的次数；独立补下载不再扣次。

运行 `whoami` 可查看账号和剩余次数。会员权限以账号状态为准；额度不足时，CLI 会显示原因和订阅入口。

## 脚本与 Skill 集成

JSON 正文输出到 stdout，进度、额度提示和错误输出到 stderr。账号查询支持：

```sh
node dist/cli.mjs whoami --json
```

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 参数、网络或其他错误 |
| `2` | 需要登录或重新连接 Figma |
| `3` | 免费次数或 AST 大小超限 |
| `4` | AST 已保存，部分图片下载失败 |
| `130` | 操作已取消 |

遇到限流时，按提示的可重试时间再次执行。节点数、Figma 原始输入数据、接口结果和 AST 文件的限制会分别说明；错误包含当前上限，能测量时也包含已读取量。处理提前停止时，“至少”表示尚未读完整个目标。免费账号触发限制时提供订阅入口，会员触发服务器技术保护时提示缩小范围。

## 配置

登录信息默认保存在以下位置：

| 系统 | 位置 |
| --- | --- |
| Linux / macOS | `$XDG_CONFIG_HOME/melonbuild`，默认 `~/.config/melonbuild` |
| Windows | `%LOCALAPPDATA%/melonbuild` |

可使用 `MELONBUILD_CONFIG_DIR` 自定义配置目录，或用 `MELONBUILD_API_URL` 指定 HTTPS 服务地址。不同服务地址的登录凭据相互独立。Unix 系统会检查凭据归属和权限：配置目录为 `0700`，凭据文件为 `0600`，不接受符号链接。

## 开发

```sh
corepack pnpm run build
corepack pnpm test
```

测试使用模拟接口和临时文件，无需 Figma 账号。CI 覆盖 Windows / macOS / Linux 和 Node.js 22.15 / 24；包含带中文、空格的路径和本地图片下载。Windows 上的 Unix 权限测试会跳过；文件符号链接测试需要系统允许创建符号链接，目录 junction 检查会单独执行。

## 许可证

[MIT](LICENSE)
