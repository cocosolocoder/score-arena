# ScoreArena

桌面规则游戏与赛事管理。

需要Go 1.22 或更新版本。

查看命令帮助：

```sh
go run . --help
```

启动本地服务：

```sh
go run . serve --host 127.0.0.1 --port 8080 --data-dir data
```

打开 http://127.0.0.1:8080 查看首页。Ctrl+C 停止服务。`--data-dir` 指定本地业务数据目录，重启时继续使用同一目录，房间编号与配置保持不变。

首页可以创建公开房间：填写房间名称、选择游戏规则（五子棋 / 飞行棋）、人数上限与每步时间限制后提交；创建成功后同一页立即展示新房间，失败时保留已填内容并提示原因。房间列表展示编号、名称、规则、人数上限、时间限制（0 显示为“不限时”）、状态（waiting 显示为“未开始”）和创建时间；没有房间时显示空列表提示。

接口：

- `GET /health` 返回服务状态和产品名称。
- `GET /api/rooms` 返回房间列表，外层为 `{"rooms": [...]}`，首次启动时为空。
- `POST /api/rooms` 创建公开房间。请求体必须是单个 JSON 对象，字段为 `name`、`game`、`capacity`、`turnSeconds`，全部必填：
  - `name`：字符串，去掉首尾空白后为 1 至 40 个 Unicode 码点，内部空格保留。
  - `game`：`gomoku`（五子棋）或 `ludo`（飞行棋）。
  - `capacity`：整数。五子棋固定为 `2`；飞行棋为 `2` 至 `4`。
  - `turnSeconds`：整数秒，`0` 表示不限时，其余只允许 `10` 至 `600`。
  - 成功返回 `201` 和 room 对象：服务生成的非空且不重复 `id`、固定 `status: "waiting"`、固定 `visibility: "public"` 以及创建时刻 `createdAt`。
  - 请求体不是单个 JSON 对象、字段缺失、类型不符、规则未知、人数/时间含小数或超出范围时返回 `400` 及具体 `error`，不写入任何记录。
  - 数据文件无法读取、不是合法数组或保存失败时返回 `500`，已有数据不会丢失或被重置。
- 未知路径返回 404；已知地址不支持的方法：`/` 与 `/health` 返回 405 且 `Allow: GET`，`/api/rooms` 返回 405 且 `Allow: GET, POST`。

房间数据保存在 `--data-dir` 下的 `rooms.json`（顶层数组），已有的房间记录及其附带字段会原样保留。

## 回归测试

接口与本地保存的回归测试（Go，启动真实服务子进程）：

```sh
go test ./...
```

首页创建公开房间的界面回归测试（Node.js + 系统 Chrome，真实浏览器加载真实服务页面，覆盖成功提示、表单复位、列表刷新、创建被拒与列表刷新失败，以及名称的首尾空白整理、U+FEFF 保留、按码点计的长度边界与页面拦截行为）：

```sh
npm install
npm test
```

需要本机安装 Chrome/Chromium，默认使用 `/usr/bin/google-chrome`，可用 `CHROME_PATH=/path/to/chrome npm test` 覆盖。

```sh
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/rooms
curl -X POST http://127.0.0.1:8080/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"name":"晚间五子棋","game":"gomoku","capacity":2,"turnSeconds":0}'
```
