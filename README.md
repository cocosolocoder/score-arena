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

打开 http://127.0.0.1:8080 查看首页。Ctrl+C 停止服务。`--data-dir` 指定本地业务数据目录，重启时继续使用同一目录。

接口：

- `GET /health` 返回服务状态和产品名称。
- `GET /api/rooms` 返回房间列表，首次启动时为空。
- `POST /api/rooms` 创建公开房间，请求体为 JSON 对象，包含：
  - `name`：房间名称，去掉首尾空白后须为 1 至 40 个 Unicode 码点（保留内部空格）。
  - `game`：游戏规则，`gomoku`（五子棋）或 `ludo`（飞行棋）。
  - `capacity`：人数上限，必须为整数；五子棋固定为 2，飞行棋为 2 至 4。
  - `turnSeconds`：每步操作时间限制（秒），必须为整数；`0` 代表不限时，否则为 10 至 600。
- 创建成功返回 `201` 及房间对象（`id`、`status` 固定为 `waiting`、`visibility` 固定为 `public`、`createdAt`）；校验失败返回 `400` 及具体 `error`；数据文件不可读或保存失败返回 `500`。
- 房间记录写入 `--data-dir` 下的 `rooms.json`，顶层为数组，已有记录及其附带字段会保留；服务重启后编号和配置不变。
- 未知路径返回 404，已知路径不支持的方法返回 405（`Allow` 列出支持的方法）。

```sh
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/rooms
curl -X POST http://127.0.0.1:8080/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"name":"欢乐五子棋","game":"gomoku","capacity":2,"turnSeconds":30}'
```
