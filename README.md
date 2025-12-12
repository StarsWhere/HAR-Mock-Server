# HAR Mock Server

基于 HAR (HTTP Archive) 录制数据的通用 HTTP Mock 服务。它会解析任意 HAR 文件中的请求与响应，并在运行时根据请求 URL 与负载的相似度返回最匹配的响应，适用于离线调试、接口契约验证或后端不可用场景下的回放。

## 功能亮点
- 🔁 **多 HAR 合并**：支持一次加载多个 HAR 文件，按 HTTP 方法 / URL / 请求体分桶，统一本地回放。
- 🎯 **三层匹配策略**：先匹配 URL+负载完全一致，其次匹配同一路径下最相似的负载，最后根据路径/查询相似度回退到最接近的 URL。
- ⚙️ **可配置权重**：通过环境变量调节 URL/path/payload 各环节的权重与阈值，适应不同接口的容错需求。
- 📦 **Docker & Compose**：提供 Dockerfile 与 docker-compose，`HAR_PATHS` 挂载后即可在容器内运行。
- 🪪 **调试标识**：响应头包含 `x-mock-*` 元信息（匹配方式、URL score、payload score、来源文件）方便排查。

## 环境要求
- Node.js 20+（本地运行）
- Docker / Docker Compose（容器化运行可选）

## 本地运行
```bash
npm install
cp .env.example .env   # 根据需要修改端口、HAR 列表、权重
npm start
```
默认监听 `http://localhost:3000`，可通过 `.env` 中的 `PORT` 覆盖。

## Docker
```bash
docker build -t history-mock .
docker run --rm -p 3000:3000 \
  -e PORT=3000 \
  -e HAR_PATHS=/app/history.har \
  -v $(pwd)/history.har:/app/history.har:ro \
  history-mock
```

## Docker Compose
`docker-compose.yml` 已联动 `.env`，默认映射 `3000:3000`：
```bash
cp .env.example .env
# 如需外部 8745 端口，可以在 compose 的 PORT 覆盖或在 .env 写 PORT=8745
docker compose up --build
```

## 配置说明
所有配置均可通过环境变量控制，详见 `.env.example`（中文注释）：

| 变量 | 说明 | 默认值 |
| ---- | ---- | ---- |
| `PORT` | Mock 服务监听端口 | `3000` |
| `HAR_PATHS` | 逗号分隔的 HAR 文件列表 | `history.har` |
| `MATCH_URL_PATH_WEIGHT` / `MATCH_URL_QUERY_WEIGHT` | URL 匹配路径 vs. 查询的权重 | `0.8 / 0.2` |
| `MATCH_PATH_PREFIX_WEIGHT` / `MATCH_PATH_DISTANCE_WEIGHT` | 路径前缀匹配 vs. 编辑距离 | `0.6 / 0.4` |
| `MATCH_STRUCTURED_KEY_WEIGHT` / `MATCH_STRUCTURED_ENTRY_WEIGHT` | 结构化请求体字段名 vs. 字段值组合 | `0.4 / 0.6` |
| `MATCH_PAYLOAD_MISMATCH_FLOOR` | 当载荷类型不一致时的相似度下限 | `0.1` |

> `HAR_PATHS` 支持相对路径，容器内会解析为 `/app/...`。若需要挂载目录，可将 `volumes` 改为目录映射并在 `.env` 中写入对应文件列表。

## 匹配算法
1. **精确匹配**：`method + canonical URL + payload fingerprint` 完全一致时直接返回录制响应。
2. **同 URL 相似负载**：在同一路径下，比较结构化请求体的字段集合与键值对，得分最高的响应命中。
3. **相似 URL 回退**：若未录制该 URL，则对所有路径按“前缀匹配 + 编辑距离 + 查询 key Jaccard”打分，择优后再执行步骤 2。

返回头部包含：
- `x-mock-match`: `exact` / `payload-similar` / `url-similar` / `url-similar-any-method`
- `x-mock-source-url`, `x-mock-source-file`
- `x-mock-url-score`, `x-mock-payload-score`

## 调试建议
- 使用 `HAR_PATHS` 同时加载多个录制，提高命中率。
- 如果某些接口匹配过于宽松/严格，可在 `.env` 中调整各权重后重启。
- 需要观测匹配详情时，可在控制台查看日志，或扩展 `src/server.js` 中的响应逻辑返回更多调试信息。

欢迎继续扩展：例如加入热更新 HAR、匹配统计 API、或代理模式下的自动录制等。PR / issue 均可。
