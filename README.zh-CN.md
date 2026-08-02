[English](README.md) | 简体中文

# beacon

一个属于你的个人项目增长引擎——完全跑在 Cloudflare 免费档。beacon 会盯着每个项目的 GitHub 流量/star 走势和你在各处发过的帖子，告诉你还有哪些渠道没发过，并按一套面向公众的检查清单审计每个仓库的 README/topics/license，把缺的东西直接变成一条待办。

![beacon overview](docs/screenshot.png)
<!-- TODO: 部署上线后替换成 "/" 总览页的真实截图 -->

## 这是什么

beacon 是一个 **Cloudflare Worker + D1 数据库**，围绕三层结构组织：

- **Measure（度量）** —— 每日定时任务（`wrangler.toml` 里的 `0 1 * * *`，UTC）拉取每个被跟踪仓库的 GitHub 流量/clone/star 历史（`src/collect/github.ts`），刷新你在 V2EX / LinuxDO / Hacker News / Reddit 上登记过的每篇帖子的指标（`src/collect/posts.ts`），以及可选的 GoatCounter 站点每日 pageview（`src/collect/goatcounter.ts`）。
- **Discover（发现）** —— 仓库曝光审计引擎（`src/audit/checks.ts`）对每个被跟踪仓库跑 9 项检查（description 长度、≥3 个 topics、是否有 LICENSE、README 是否有英文简介、README 是否有截图/GIF、macOS 项目是否挂了 release 产物、README 有无断链、是否设置了自定义 social preview 图、homepage 是否与配置同步），渠道覆盖矩阵（`src/channels.ts`）则按标签重合度给每个项目和 17 个发布渠道（V2EX、LinuxDO、少数派、Show HN、r/SideProject、itch.io……）打分，让你一眼看出还没发过的渠道。
- **Act（行动）** —— 每一项审计失败和每一个高分未发渠道，都会变成 `todos` 表里的一行，展示在 dashboard 和 `/api/todos` 上——是一个具体的下一步动作，而不只是一份报告。

整个系统跑在一个 Worker 里：一个公开、无需鉴权的 SSR dashboard（`/`、`/p/:project`、`/matrix`、`/todos`、`/posts`），加一个用 Bearer token 保护的写入用 admin API（`/api/admin/*`）。

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
# star 历史回填（GitHub stargazers API）对公开仓库不需要额外权限——该接口本身无需鉴权即可读，
# 这里配 token 只是把你从更低的未鉴权速率限制里解放出来。
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

# 立即跑一次今天的 github/posts/goatcounter/audit 采集
# （从明天起每日定时任务会自动做同样的事）
curl -X POST https://beacon.<你的子域>.workers.dev/api/admin/collect \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

打开 `https://beacon.<你的子域>.workers.dev/`——总览页此时应该已经显示出 `src/config.ts` 里每个项目的 star/流量数据。

## GoatCounter（可选）

beacon 还可以把 [GoatCounter](https://www.goatcounter.com/) 站点每日的 pageview/访客数拉进同一个 dashboard（`src/collect/goatcounter.ts`）：

```bash
npx wrangler secret put GOATCOUNTER_SITE    # 你的 <site>.goatcounter.com 站点代号，例如 "defiabell"
npx wrangler secret put GOATCOUNTER_TOKEN   # GoatCounter → Settings → API → 生成一个 token
```

两个都不设置，每日采集里的 "goatcounter" 步骤就只会报告 `{ok: true, error: "not configured"}` 并跳过——beacon 其余功能不依赖它。

嵌入到你自己站点的埋点片段、以及如何验证它在发送数据，见 [`docs/goatcounter.md`](docs/goatcounter.md)。

## Admin API

所有 `/api/admin/*` 路由都需要 `Authorization: Bearer <ADMIN_TOKEN>`。

**登记一篇你发布的帖子** —— 会立即尝试拉取指标；如果对应平台一时抽风，帖子依然会被保存，下一次采集会自动补上：

```bash
curl -X POST https://beacon.<子域>.workers.dev/api/admin/posts \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://news.ycombinator.com/item?id=12345678", "project": "shotsync", "title": "Show HN: shotsync"}'
# -> 201 {"id": 7}
# 如果这次平台指标 API 恰好失败：
# -> 201 {"id": 7, "metrics": "deferred"}
```

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

```bash
curl -X POST https://beacon.<子域>.workers.dev/api/admin/collect \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> 200 [{"source":"github","ok":true}, {"source":"posts","ok":true}, ...]

curl -X POST https://beacon.<子域>.workers.dev/api/admin/backfill \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# -> 200 {"repos": 4, "failures": []}
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
