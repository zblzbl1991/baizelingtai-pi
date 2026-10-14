# guizang-ppt 与 SkillHub 接入核查

核查日期：2026-10-13。SkillHub 指讯飞开源项目 [iflytek/skillhub](https://github.com/iflytek/skillhub)，本文源码证据固定在 `a463efb5352ebf6eed79aba8c74e35556000c3dc`；站点接口结果是当日观察，不是内网部署验收。实例地址使用 `http://skillhub.example.com` 示例，白泽灵台配置使用 `PIVANE_SKILLHUB_URL`。

## guizang-ppt 的实际身份和能力

- 作者源仓库为 [op7418/guizang-ppt-skill](https://github.com/op7418/guizang-ppt-skill/tree/c91369c449d34755d320a8b81d0734000d99d1ab)。该版本 [SKILL.md](https://github.com/op7418/guizang-ppt-skill/blob/c91369c449d34755d320a8b81d0734000d99d1ab/SKILL.md) 的 frontmatter 精确为 `name: guizang-ppt-skill`，正文写明创建维护者为歸藏及规范来源。`guizang-ppt` 可作为展示名，不能冒充上游实际包名。
- 作者版生成单文件 HTML 横向翻页演示，提供电子杂志与瑞士风、演讲者模式和观众屏同步；[README](https://github.com/op7418/guizang-ppt-skill/blob/c91369c449d34755d320a8b81d0734000d99d1ab/README.md) 没有保证原生可编辑 `.pptx`。其 [LICENSE](https://github.com/op7418/guizang-ppt-skill/blob/c91369c449d34755d320a8b81d0734000d99d1ab/LICENSE) 是 GNU AGPL 第 3 版，导入镜像时应保留许可证和作者来源。
- 当日公开站 [搜索接口](https://skill.xfyun.cn/api/v1/search?q=guizang-ppt) 返回 `github--guizang-ppt-skill`、`special--guizang-ppt-skill` 和 `astroclaw--guizang-ppt-skill`。其中 [github 详情](https://skill.xfyun.cn/api/v1/skills/github--guizang-ppt-skill) 的版本为 `0.0.0-git.82fe5ae129e8`，摘要为 HTML；[special 详情](https://skill.xfyun.cn/api/v1/skills/special--guizang-ppt-skill) 的版本为 `20260716.071224`，摘要增加可编辑 `.pptx`。这些是不同来源、版本的包，摘要不能证明作者原版或内网镜像具备相同能力。裸 `guizang-ppt` 详情当日返回 404。
- [HTML 模板](https://github.com/op7418/guizang-ppt-skill/blob/c91369c449d34755d320a8b81d0734000d99d1ab/assets/template.html) 使用 Google Fonts、unpkg Lucide 和 jsDelivr Motion 外链。Skill 安装到内网不等于生成结果已离线可用；镜像或打包字体与脚本后还须验证。Node 校验脚本可用时运行，Playwright 渲染校验是额外能力。

## Agent 的官方接入方式

官方 Web 的 [Agent 安装按钮](https://github.com/iflytek/skillhub/blob/a463efb5352ebf6eed79aba8c74e35556000c3dc/web/src/features/skill/install-for-agent-button.tsx) 让 Agent 先读 `<registry>/registry/skill.md`。该指南对应仓库 [skillhub-cli/SKILL.md](https://github.com/iflytek/skillhub/blob/a463efb5352ebf6eed79aba8c74e35556000c3dc/builtin-skills/skills/skillhub-cli/SKILL.md)，要求使用第一方 npm 包 `@astron-team/skillhub`，保留用户选择的 registry，不以裸 HTTP 下载替代 CLI 校验。仓库指南可能先于 npm 发行，使用前应检查已安装 CLI 的 `help <command>` 和 `<command> --help`。

[CLI README](https://github.com/iflytek/skillhub/blob/a463efb5352ebf6eed79aba8c74e35556000c3dc/cli/README.md) 的 registry 优先级为 `--registry`、`SKILLHUB_REGISTRY`、`~/.skillhub/config.json`、默认 `https://skill.xfyun.cn`。Node 要求 18 或更新；纯内网须同时提供可用 npm 源或预装 CLI，registry 地址本身不会代理 npm。

白泽灵台采用独立 Agent 目录，应传入实际技能根目录，避免默认安装到运行用户的其他 Agent：

```text
skillhub search guizang-ppt --registry http://skillhub.example.com --json
skillhub install @global/guizang-ppt-skill --dir <当前Agent实际skills目录> --registry http://skillhub.example.com --json
```

`global` 是示例 namespace，内网管理员必须先发布或导入相应包，应用应允许配置 namespace。不能因公网存在 `github` 或 `special` 包就声称内网 `global/guizang-ppt-skill` 已存在。`--dir` 与 `--agent`、`--scope` 互斥；官方也支持 `--agent pi`，其用户级路径是 `~/.pi/agent/skills/`，项目级是 `.pi/skills/`。[install-service](https://github.com/iflytek/skillhub/blob/a463efb5352ebf6eed79aba8c74e35556000c3dc/cli/src/services/install-service.ts) 实际写入 `<skills根>/<slug>`，不会添加 `namespace--` 目录前缀。

安装后检查 `SKILL.md`、`.skillhub/metadata.json` 和当前 Agent 是否发现技能。安装成功与会话加载是两件事，使用 Pi 支持的资源重载机制验收，不能编造通用激活命令。连接指南推荐先安装 `@global/skillhub-cli`，若内网未提供该指南包，应明确报告该情况，仍可继续已授权、可安全完成的目标包安装。

## CLI API 与来源凭据

[CLI 客户端](https://github.com/iflytek/skillhub/blob/a463efb5352ebf6eed79aba8c74e35556000c3dc/cli/src/clients/skillhub-client.ts) 和 [服务端控制器](https://github.com/iflytek/skillhub/blob/a463efb5352ebf6eed79aba8c74e35556000c3dc/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/cli/CliSkillController.java) 定义：

| 操作 | HTTP 路径 |
|---|---|
| 搜索 | `/api/cli/v1/skills/search?q=<query>&limit=<n>` |
| 解析版本 | `/api/cli/v1/skills/<namespace>/<slug>/resolve?version=<version>` |
| 最新版下载 | `/api/cli/v1/skills/<namespace>/<slug>/download` |
| 指定版下载 | `/api/cli/v1/skills/<namespace>/<slug>/versions/<version>/download` |

解析结果包括 `namespace`、`slug`、`version`、`versionId`、`fingerprint` 和 `downloadUrl`。不要把 ClawHub 兼容层的 `/api/v1/skills` 列表当成官方 CLI 搜索；公开站当日忽略该列表请求中的 `keyword`。

官方 CLI 将 registry、namespace、slug、version、versionId、fingerprint、files、source、agent、installedAt 写入 `.skillhub/metadata.json`。它先暂存解包、校验解析版本的指纹，再持锁提交；`--force` 也只允许同一完整来源身份的受管安装，不覆盖其他来源或未知目录。来源匹配依据是 registry + namespace + slug。

[指纹实现](https://github.com/iflytek/skillhub/blob/a463efb5352ebf6eed79aba8c74e35556000c3dc/cli/src/services/skill-fingerprint.ts) 的 `files["SKILL.md"]` 是 SHA256 原始十六进制文本；总指纹是 `sha256:` 加十六进制。总指纹对排序后的文件记录 `path:fileHash\n` 计算，不是 ZIP 字节哈希。UI 可把官方 metadata 与文件哈希一致性作为来源证据，但 metadata 本身是本机文件，并不证明发布者身份或包安全性。

## 未完成的实机核验

尚未验证用户内网实例能访问、对应包已导入、鉴权策略、已发行 CLI 是否包含仓库的最新选项，以及纯内网生成/演示是否无需外网。本次没有安装 Skill、发布到 SkillHub、改变已有 Agent 目录或运行服务。Bing preset 因当前 Python 缺少 `playwright` 失败，未改用其他通用搜索；随后读取的是用户明确指定的项目源码、该项目公开注册表 API 和 API 返回的作者源仓库。
