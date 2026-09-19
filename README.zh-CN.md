[English](README.md) | 简体中文

# beacon

一个属于你的个人项目增长引擎——完全跑在 Cloudflare 免费档。beacon 会盯着每个项目的 GitHub 流量/star 走势和你在各处发过的帖子，告诉你还有哪些渠道没发过，并按一套面向公众的检查清单审计每个仓库的 README/topics/license，把缺的东西直接变成一条待办。

<!-- TODO: 部署上线且有真实数据后，在此加入 ![beacon overview](docs/screenshot.png) -->

## 这是什么

beacon 是一个 **Cloudflare Worker + D1 数据库**，围绕三层结构组织：

- **Measure（度量）** —— 每日定时任务（UTC 01:00 采 GitHub、01:10 采帖子、01:20 采网站统计，见 `wrangler.toml`）拉取每个被跟踪仓库的 GitHub 流量/clone/star 历史（`src/collect/github.ts`），刷新你在 V2EX / LinuxDO / Hacker News / Reddit 上登记过的每篇帖子的指标（`src/collect/posts.ts`），读取本 Cloudflare 账户下每个 Worker（`src/collect/cloudflare.ts`）和每个 Pages 项目 Functions（`src/collect/pages.ts`——单独一个 GraphQL 数据集加一次 REST 项目查询，因为 Pages Functions 的流量对 Worker 那个数据集完全不可见）各自的请求量，拉取 `src/config.ts` 里配置站点的 RUM 浏览量（`src/collect/rum.ts`），以及可选的 GoatCounter 站点每日 pageview（`src/collect/goatcounter.ts`）。
- **Discover（发现）** —— 仓库曝光审计引擎（`src/audit/checks.ts`）对每个被跟踪仓库跑 9 项检查（description 长度、≥3 个 topics、是否有 LICENSE、README 是否有英文简介、README 是否有截图/GIF、macOS 项目是否挂了 release 产物、README 有无断链、是否设置了自定义 social preview 图、homepage 是否与配置同步），渠道覆盖矩阵（`src/channels.ts`）则按标签重合度给每个项目和 17 个发布渠道（V2EX、LinuxDO、少数派、Show HN、r/SideProject、itch.io……）打分，让你一眼看出还没发过的渠道。
- **Act（行动）** —— 每一项审计失败和每一个高分未发渠道，都会变成 `todos` 表里的一行，展示在 dashboard 和 `/api/todos` 上——是一个具体的下一步动作，而不只是一份报告。

整个系统跑在一个 Worker 里：一个谁都能看的公开 SSR dashboard（`/`、`/p/:project`、`/matrix`、`/todos`、`/posts`），加同一套用 `ADMIN_TOKEN` 保护的写入路径的两种入口——给 curl/脚本用的 JSON admin API（`/api/admin/*`），以及在浏览器 `/login` 登录后，dashboard 页面本身出现的真实控件（复选框、每格状态选择器、登记帖子表单——见下方"浏览器登录"一节）。除 `/api/admin/*`、`/ui/*`、`/login` 外，所有 GET 响应都会经过 Workers Cache API——在自定义域名下（非裸 `workers.dev` 子域）会带来真正的边缘缓存，叠加在 `max-age=60` 的浏览器缓存之上；已登录的请求永远跳过这个缓存，拿到的是现算的私有渲染。

## 自己部署（约 5 分钟）

前置条件：一个 Cloudflare 账户、Node 18+。

```bash
git clone https://github.com/Defiabell/beacon
cd beacon
npm install
npx wrangler login

# 1. 建 D1 数据库（名字要和 wrangler.toml 里的 database_name = "beacon" 一致）
npx wrangler d1 create beacon
# 把返回的 `database_id` 填回 wrangler.toml 的 [[d1_databases]] 块 ——
# 它默认是 database_id = "placeholder-replace-after-d1-create"

# 2. 应用 schema
npx wrangler d1 migrations apply beacon --remote

# 3. 设置 GitHub token —— 一个只授权给你要跟踪的仓库的 fine-grained PAT：
#    - Administration: Read-only （traffic API 需要——GET /repos/{owner}/{repo}/traffic/*
#      只对拥有该仓库 push/admin 级别权限的 token 开放）
#    - Contents: Read-only       （README、releases——description/topics/license 这类基础仓库
#      元信息由每个 token 都自带、无法关闭的 Metadata:Read 权限覆盖）
# star 历史回填（POST /api/admin/backfill）是上面两个权限唯一覆盖不到的东西。对真实仓库
# 实测：stargazers 列表接口匿名访问返回 401（Requires authentication），只带上面两个权限的
# fine-grained token 返回 403（Resource not accessible by personal access token），
# 带 repo scope 的 classic token 返回 200。日常采集不受影响——它记录的 star 数取自仓库元信息
# 接口而不是 stargazers 列表——所以回填是可选项，等仓库真的有 star 需要追溯时再安排即可。
npx wrangler secret put GITHUB_TOKEN

# 4. 设置 admin token —— 任意长随机串；它保护所有 /api/admin/* 写操作
openssl rand -hex 24                  # 生成一个，复制下来
npx wrangler secret put ADMIN_TOKEN   # 提示时粘贴

# 5. 把 beacon 指向你自己的项目 —— 编辑 src/config.ts，
#    用你自己的 GitHub 仓库 + 标签替换示例条目

# 6. 部署
npm run deploy
```

你还需要一个 **workers.dev 子域名**（控制台 → Workers & Pages，一次性设置）或自定义域名。部署后会得到 `https://beacon.<你的子域>.workers.dev`。

最后，回填历史数据并跑一次首次采集：

```bash
# 从 GitHub stargazers API 回填每个项目的完整 star 历史
curl -X POST https://beacon.<你的子域>.workers.dev/api/admin/backfill \
  -H "Authorization: Bearer <ADMIN_TOKEN>"

# 每组单独请求；sources 不能省略或跨组混用。审计分片分别运行。
curl -X POST "https://beacon.<你的子域>.workers.dev/api/admin/collect?sources=github" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
curl -X POST "https://beacon.<你的子域>.workers.dev/api/admin/collect?sources=posts" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
curl -X POST "https://beacon.<你的子域>.workers.dev/api/admin/collect?sources=goatcounter,cloudflare,pages,rum" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
curl -X POST "https://beacon.<你的子域>.workers.dev/api/admin/collect?sources=audit&shard=0" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
curl -X POST "https://beacon.<你的子域>.workers.dev/api/admin/collect?sources=audit&shard=1" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

打开 `https://beacon.<你的子域>.workers.dev/`——总览页此时应该已经显示出 `src/config.ts` 里每个项目的 star/流量数据。

定时配置只占一条 cron：`0,10,20,30,40 1 * * *`。按计划触发时间（UTC）路由：01:00 采集 GitHub、01:10 采集帖子、01:20 采集分析数据，01:30／01:40 分别执行审计分片 0／1。配置传播期间仍兼容旧的三条表达式，但仅允许其原有时间。每组拥有独立请求预算。统计窗口使用最近 N 个完整 UTC 日，不含今天；Cloudflare 和 GoatCounter 每次重新采集最近三个完整日。没有记录的指标返回 `null`／显示缺失，不能当成零。成功采集确认的空日期才可记为零；部分覆盖和失败来源会明确标记。

## GoatCounter（可选）

beacon 还可以把 [GoatCounter](https://www.goatcounter.com/) 站点每日的 pageview/访客数拉进同一个 dashboard（`src/collect/goatcounter.ts`）：

```bash
npx wrangler secret put GOATCOUNTER_SITE    # 你的 <site>.goatcounter.com 站点代号，例如 "defiabell"
npx wrangler secret put GOATCOUNTER_TOKEN   # GoatCounter → Settings → API → 生成一个 token
```

两个都不设置，每日采集里的 "goatcounter" 步骤就只会报告 `{ok: true, error: "not configured"}` 并跳过——beacon 其余功能不依赖它。

嵌入到你自己站点的埋点片段、以及如何验证它在发送数据，见 [`docs/goatcounter.md`](docs/goatcounter.md)。

## 浏览器登录

`https://beacon.<你的子域>.workers.dev/login`——一个密码输入框。填入上面生成的**同一个 `ADMIN_TOKEN`**（只有这一个 token；它对 curl 的 `Authorization: Bearer` 头和浏览器的 cookie 是同一套验证逻辑）。令牌错误会在原页面重新渲染表单并返回 `401`；正确则会种下一个 `HttpOnly; Secure; SameSite=Strict` 的 cookie（`beacon_admin`，90 天有效期），并跳转回 `/`。

登录后，每个 dashboard 页面都会长出真正的写入控件——不需要跳去另一个后台页面：

- `/todos` —— 每一行一个真实的复选框（提交即在进行中/已完成之间切换）
- `/matrix` —— 每个格子变成一个小表单，用来设置已发布 / 计划中 / 不适用
- `/posts` —— 一个"＋ 登记帖子"折叠面板，用来登记新帖子（url、项目、可选的标题/发布时间）——走的是和 `POST /api/admin/posts` 完全一样的代码路径，包括它的 metrics-deferred 兜底逻辑

这些都是纯 `<form method="post">` 提交（项目里没有任何 JavaScript），分别打到 `POST /ui/todo`、`/ui/post`、`/ui/channel`——这几个薄封装要求和 `/api/admin/*` 完全一样的 `ADMIN_TOKEN`（header 或 cookie 均可），调用的也是同一批底层函数，处理完再跳转回你操作前所在的页面。登出状态下每个页面和上面描述的完全一样，只是页头多一个"登录"链接；登录后这个链接变成"登出"，点一下即 `POST /logout` 清掉 cookie。

## Admin API

所有 `/api/admin/*` 路由（以及上面浏览器控件背后的每个 `/ui/*` 路由）都需要 `Authorization: Bearer <ADMIN_TOKEN>`——`/ui/*` 也可以改用 `/login` 种下的 `beacon_admin` cookie，效果相同。

**登记一篇你发布的帖子** —— 会立即尝试拉取指标；如果对应平台一时抽风，帖子依然会被保存，下一次采集会自动补上：

```bash
curl -X POST https://beacon.<子域>.workers.dev/api/admin/posts \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://news.ycombinator.com/item?id=12345678", "project": "shotsync", "title": "Show HN: shotsync", "publishedAt": "2026-07-15T09:00:00Z"}'
# -> 201 {"id": 7}
# 如果这次平台指标 API 恰好失败：
# -> 201 {"id": 7, "metrics": "deferred"}
```

`publishedAt` 是可选字段（ISO 8601 字符串）——不传就和之前一样，帖子不带发布日期存下来。

**把某个渠道标记为已发布 / 计划中 / 不适用：**

```bash
curl -X PUT https://beacon.<子域>.workers.dev/api/admin/channels \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"project": "shotsync", "channelId": "show-hn", "status": "posted", "postId": 7}'
# -> 204 No Content
```

**关闭（或重新打开）一条待办：**

```bash
curl -X PUT https://beacon.<子域>.workers.dev/api/admin/todos \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": 3, "status": "done"}'
# -> 204 No Content
```

**手动触发一次采集或回填**（和上面部署步骤里用的是同一组路由）：

每次必须指定 `sources`：`github`、`posts`、`audit` 各自单独运行；`goatcounter,cloudflare,pages,rum` 可以选任意子集。省略、空值、未知来源或跨组组合返回 400，且不会启动采集。上面的部署步骤列出完整调用。审计响应中的 `auditShards` 是分片总数，按 `shard=0` 到 `auditShards - 1` 分别调用。

```bash
curl -X POST "https://beacon.<subdomain>.workers.dev/api/admin/collect?sources=pages,rum" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> 200 {"reports":[{"source":"pages","ok":true},{"source":"rum","ok":true}],"auditShards":2,"ranShard":0}

curl -X POST "https://beacon.<subdomain>.workers.dev/api/admin/collect?sources=audit&shard=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> 200 {"reports":[{"source":"audit","ok":true}],"auditShards":2,"ranShard":1}

curl -X POST https://beacon.<subdomain>.workers.dev/api/admin/backfill \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 只读接口

以下接口不需要 token，都是公开的：

- `GET /` `/p/:project` `/matrix` `/todos` `/posts` —— HTML dashboard
- `GET /api/overview` `/api/matrix` `/api/posts` `/api/health` `/api/todos?status=open|done` `/api/project/:name` —— 同样的数据，JSON 格式

## 开发

```bash
npm test          # vitest run —— 完整测试套件（Vitest + @cloudflare/vitest-pool-workers）
npm run typecheck  # tsc --noEmit（src）+ tsc -p test --noEmit
npm run dev        # wrangler dev —— 本地开发服务器
```

## License

[MIT](LICENSE)
