# melonbuild-cli

面向用户的 MelonBuild 轻量客户端。安装后可以由 Skill 或终端调用。设计稿解析和账号额度校验在服务端；图片直接从 AST 中的 Figma 链接下载到用户本机。客户端不包含 Figma 解析核心，不保存 Figma Token。

需要 Node.js >=22.15.0。包名 `melonbuild-cli`，命令 `melonbuild`，同时提供 `melonbuild-cli` 别名。

## 安装与登录

公共 npm 发布后：

```sh
npm install -g melonbuild-cli
melonbuild login
melonbuild whoami
```

当前仓库尚未执行公共 npm 发布。登录会打开 `https://www.melonbuild.com/api/cli/authorize`：核对终端登录码，使用现有 Figma 登录，再确认登录此 CLI。浏览器已登录本站时直接确认，无需再次向 Figma 授权。无浏览器或 SSH 环境使用 `melonbuild login --no-browser`，在其他浏览器打开显示的链接。

Figma 唯一用户 ID 关联同一本站账号；网站、CLI 共用会员和累计免费次数。Figma 的 access/refresh token 留在服务端，本机仅保存平台凭据。平台凭据有效期 30 天，到期重新登录；`melonbuild logout` 撤销本设备凭据并清理本地配置，不退出其他设备或网站。

## 获取 AST 和摘要

```sh
melonbuild node-ast 'https://www.figma.com/design/FILEKEY?node-id=12-34' --output ./design/ast.json
melonbuild node-ast FILEKEY 12:34 --output ./design/ast.json --image-dir ./public/images
melonbuild node-summary 'https://www.figma.com/design/FILEKEY?node-id=12-34' --output ./design/summary.json
```

固定输出完整的紧凑 JSON，不提供 XML。链接必须有单个 `node-id`；目标可以是 FRAME、SECTION、CANVAS、组件等，内部可以包含多页面。整文件根节点及逗号批量节点暂不支持，仍受服务端节点数、输入体量、执行时间等技术保护。

不指定 `--image-dir` 时保留远端图片链接。指定后在本机下载，并把节点、模板参数和背景样式里的图片引用替换为相对 AST 输出文件的本地路径；省略 `--output` 时路径相对当前工作目录。下载目录和 AST 文件目录可独立指定。`--image-local-path` 是 `--image-dir` 的别名。

`--reuse exact|none|params|slots|components` 选择复用模式；默认 `exact`。另有 `--reuse-meta`、`--with-ids`、`--no-styles`。需要获取最新设计时用 `--force-refresh`。已有输出文件需要显式 `--overwrite`，客户端会先检查输出目录可写，避免在明确无法落盘时请求生成。

## 图片失败后的独立重试

下载前保留原始远端 AST。例如输出 `./design/ast.json` 时，原文件保存在 `./design/ast.json.remote.json`，下载清单为其后的 `.assets.json` 文件。省略 `--output` 时，原始 AST 保存到图片目录下的 `melonbuild.remote.json`。

```sh
melonbuild download-images ./design/ast.json.remote.json \
  --image-dir ./public/images --output ./design/ast.json --overwrite
```

此命令仅读取本地 AST 并访问其中的图片链接，不需要登录，不调用 AST 接口，不扣生成次数。下载按 URL 去重，以内容校验复用已成功的文件；失败项保留远端链接，记录在下载清单，退出码为 4。原始 JSON 保持远端链接，不要把本地化结果当作重试源。

图片使用 Figma HTTPS 图片地址，请求不携带平台或 Figma 登录凭据；重定向也校验目标。文件名由 URL 摘要生成，避免设计稿名称形成路径穿越或覆盖同名文件。默认最多并行 4 个下载、单图 64 MiB、本次总图像 512 MiB。过期的签名 URL 无法通过本地重试恢复，需要重新获取有效 AST；CLI 不会为此自动重新生成或自动扣次数。

## 免费额度

与网站共用每个 Figma 账号累计 10 次，不按月重置。成功生成新结果扣一次，有效服务端结果缓存命中不扣；失败、超时、超出免费 AST 大小不扣。图片下载失败发生在服务端生成成功之后，生成次数已经扣除；补下载不会再扣。

免费 AST 上限 **30,000 字节（30 KB）**，按服务端完整 AST 的紧凑 JSON UTF-8 大小计算，包含图片链接，不包含图片二进制或 HTTP 响应包装。这取代单页面限制，不限制产物内的页面数。本地图片路径改写不重新计算此产品额度。摘要沿用服务端技术大小上限。会员跳过累计免费次数和 30 KB 产品限制，保留服务端技术保护。

次数或 AST 大小超限时，显示原因和订阅入口 `https://www.melonbuild.com/subscribe`。该地址为预留路由，订阅页面及支付流程尚未开发。

## 自动化

AST/摘要正文单独写入 stdout，进度、额度和错误写 stderr；指定 `--output` 时正文写文件。`whoami --json` 返回账号 JSON，`--json` 使错误以 JSON 写 stderr。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 参数、网络或其他错误 |
| 2 | 需要登录或重新连接 Figma |
| 3 | 免费次数或 AST 大小超限 |
| 4 | AST 已保存，但部分图片下载失败 |
| 130 | 用户取消 |

服务端限流提示保留 `Retry-After`，不会为失败的生成请求自动重试，以免意外重复消耗次数。可通过请求编号排查问题。

配置默认在 Linux/macOS 的 `~/.config/melonbuild`（遵循 `XDG_CONFIG_HOME`），Windows 的 `%LOCALAPPDATA%/melonbuild`。Unix 凭据目录权限 0700，凭据文件 0600。`MELONBUILD_CONFIG_DIR` 可指定目录；`MELONBUILD_API_URL` 可指定 HTTPS 服务 origin，凭据绑定 origin，不能复用到其他服务地址。

## 开发与验证

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm test
node dist/cli.mjs --help
node dist/cli.mjs login
node dist/cli.mjs node-ast 'https://www.figma.com/design/FILEKEY?node-id=12-34' --output ./ast.json --image-dir ./images
```

纯 ESM，运行时只使用 Node 内置模块；esbuild 只用于开发打包。包产物只包含 `dist/` 和 README，不依赖相邻的内部 CLI 源码。测试使用模拟 Figma 响应与独立临时目录，不消耗真实 Figma 或本站用户次数。真实 Figma OAuth 仍受应用审核状态限制。
