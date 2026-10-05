package main

import (
	"bufio"
	"bytes"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
)

// 本文件回归“服务正常停止后，使用同一业务数据目录重新启动”的保留行为：
// 停止前创建成功的房间必须原样可查，编号不重新分配、配置不补默认值、不相互串用；
// 历史附带字段与字段不完整的老记录不能被删除；启动与只查询列表不得改写本地文件；
// 重启后的新建房间只能追加在原记录之后。保留数据被截断或顶层为 null 时，
// 查询与合法创建都必须返回 500，且原数据逐字节保留。真正的空数组仍表示没有房间。
//
// 与 main_test.go 一样以子进程方式运行真实服务，区别是这里要真正经历一次
// “正常停止（SIGINT，对应 Ctrl+C）后重新启动”，而不是单进程内反复查询。

// restartServer 是一个可以被正常停止、再由新进程接替同一数据目录的服务句柄。
type restartServer struct {
	cmd *exec.Cmd
	url string
}

// startRestartServer 在 dataDir 上启动真实服务子进程（--port 0 自动选端口）。
func startRestartServer(t *testing.T, dataDir string) *restartServer {
	t.Helper()
	cmd := exec.Command(serverBin, "serve", "--host", "127.0.0.1", "--port", "0", "--data-dir", dataDir)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("获取服务输出失败: %v", err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("启动服务失败: %v", err)
	}
	// 兜底：若测试中途失败而没走到正常停止，仍回收子进程。
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Signal(syscall.SIGTERM)
			_ = cmd.Wait()
		}
	})

	urlCh := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if line := scanner.Text(); strings.Contains(line, "listening on") {
				idx := strings.Index(line, "http://")
				if idx >= 0 {
					urlCh <- strings.TrimSpace(line[idx:])
					return
				}
			}
		}
		urlCh <- ""
	}()

	select {
	case url := <-urlCh:
		if url == "" {
			t.Fatal("服务在输出监听地址前退出")
		}
		return &restartServer{cmd: cmd, url: url}
	case <-time.After(15 * time.Second):
		t.Fatal("等待服务监听地址超时")
		return nil
	}
}

// stop 发送 SIGINT（与 Ctrl+C 正常停止一致），等待进程以退出码 0 结束。
// 被杀掉退出或超时都算失败——本套回归保护的正是“正常停止”之后的保留行为。
func (s *restartServer) stop(t *testing.T) {
	t.Helper()
	if err := s.cmd.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatalf("发送正常停止信号失败: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- s.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("正常停止应成功退出（退出码 0），实际: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("等待服务正常停止超时")
	}
}

// 用户成功创建五子棋（不限时 0）和飞行棋（有限时整数秒）房间后正常停止服务，
// 再用同一数据目录重启：查询必须返回停止前的全部记录，数量、排列次序、编号一致，
// 名称（仅去首尾空白，内部空格与表情保留）、规则、人数、每步时间、状态、公开范围、
// 创建时间全部保持原值；0 不能被补成默认秒数，两个房间的配置不能相互串用。
// 启动与只查询列表不得改写本地文件。重启后再创建的房间只能追加在旧记录之后，
// 新编号非空且不同于全部已有编号，列表中的新记录与本次创建响应一致。
func TestRoomsSurviveGracefulRestart(t *testing.T) {
	dataDir := t.TempDir()

	// 第一轮服务：创建两间配置刻意不同的房间（0 秒 vs 有限时，2 人 vs 4 人）。
	first := startRestartServer(t, dataDir)

	gomokuStatus, gomokuRoom := postRoom(t, first.url,
		`{"name":"  深夜 😀 五子棋 对局  ","game":"gomoku","capacity":2,"turnSeconds":0}`)
	if gomokuStatus != http.StatusCreated {
		t.Fatalf("五子棋房间创建状态码 = %d，期望 201，响应: %v", gomokuStatus, gomokuRoom)
	}
	ludoStatus, ludoRoom := postRoom(t, first.url,
		`{"name":" 周末 飞行棋 大赛 ","game":"ludo","capacity":4,"turnSeconds":45}`)
	if ludoStatus != http.StatusCreated {
		t.Fatalf("飞行棋房间创建状态码 = %d，期望 201，响应: %v", ludoStatus, ludoRoom)
	}
	gomokuID, _ := gomokuRoom["id"].(string)
	ludoID, _ := ludoRoom["id"].(string)
	if gomokuID == "" || ludoID == "" || gomokuID == ludoID {
		t.Fatalf("两个房间编号应非空且互不相同，实际: %q, %q", gomokuID, ludoID)
	}

	// 停止前先取一次列表与文件快照，作为重启后的比对基准。
	listStatus, before := getRooms(t, first.url)
	if listStatus != http.StatusOK || len(before) != 2 {
		t.Fatalf("停止前列表状态码 = %d、数量 = %d，期望 200 与 2 条", listStatus, len(before))
	}
	if !reflect.DeepEqual(before[0], gomokuRoom) || !reflect.DeepEqual(before[1], ludoRoom) {
		t.Fatalf("停止前列表与创建响应不一致: %v / %v", before, []map[string]any{gomokuRoom, ludoRoom})
	}
	beforeStopFile := readDataFile(t, dataDir)

	// 正常停止：停止过程本身不得重写数据文件。
	first.stop(t)
	if got := readDataFile(t, dataDir); !bytes.Equal(got, beforeStopFile) {
		t.Fatalf("正常停止改写了数据文件：\n得到: %s\n期望: %s", got, beforeStopFile)
	}

	// 第二轮服务：同一业务数据目录，全新进程。
	second := startRestartServer(t, dataDir)
	restartStatus, after := getRooms(t, second.url)
	if restartStatus != http.StatusOK {
		t.Fatalf("重启后查询状态码 = %d，期望 200", restartStatus)
	}
	if len(after) != 2 {
		t.Fatalf("重启后房间数量 = %d，期望 2（不得清空、不得只恢复部分）", len(after))
	}
	// 数量、排列次序与每条记录的完整内容都必须与停止前一致。
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("重启后记录与停止前不一致：\n得到: %v\n期望: %v", after, before)
	}

	r0, ok := after[0].(map[string]any)
	if !ok {
		t.Fatalf("重启后第 1 条不是对象: %v", after[0])
	}
	r1, ok := after[1].(map[string]any)
	if !ok {
		t.Fatalf("重启后第 2 条不是对象: %v", after[1])
	}

	// 编号保持：重新分配编号会在这里暴露。
	if got := r0["id"]; got != gomokuID {
		t.Fatalf("五子棋房间编号 = %v，期望保持原值 %q", got, gomokuID)
	}
	if got := r1["id"]; got != ludoID {
		t.Fatalf("飞行棋房间编号 = %v，期望保持原值 %q", got, ludoID)
	}

	// 名称以创建成功时已去掉首尾空白的结果为准，内部空格与表情仍在。
	if got := r0["name"]; got != "深夜 😀 五子棋 对局" {
		t.Fatalf("五子棋名称 = %v，期望 %q（首尾空白已去，内部空格与表情保留）", got, "深夜 😀 五子棋 对局")
	}
	if got := r1["name"]; got != "周末 飞行棋 大赛" {
		t.Fatalf("飞行棋名称 = %v，期望 %q", got, "周末 飞行棋 大赛")
	}

	// 规则、人数、每步时间、状态、公开范围、创建时间逐字段钉住，
	// 同时防止两个房间的配置相互串用。
	if got := r0["game"]; got != "gomoku" {
		t.Fatalf("第 1 条规则 = %v，期望 gomoku", got)
	}
	if got := r1["game"]; got != "ludo" {
		t.Fatalf("第 2 条规则 = %v，期望 ludo", got)
	}
	if got := r0["capacity"]; got != float64(2) {
		t.Fatalf("五子棋人数 = %v，期望 2", got)
	}
	if got := r1["capacity"]; got != float64(4) {
		t.Fatalf("飞行棋人数 = %v，期望 4（不得套用五子棋的 2）", got)
	}
	if got, present := r0["turnSeconds"]; !present {
		t.Fatalf("五子棋记录缺少 turnSeconds 字段（0 也必须明确保留，不能当成缺失配置）")
	} else if got != float64(0) {
		t.Fatalf("五子棋每步时间 = %v，期望 0（不限时）", got)
	}
	if got := r1["turnSeconds"]; got != float64(45) {
		t.Fatalf("飞行棋每步时间 = %v，期望 45（有限时整数秒必须保留，不得补默认值或串成 0）", got)
	}
	if got := r0["status"]; got != "waiting" {
		t.Fatalf("第 1 条状态 = %v，期望 waiting", got)
	}
	if got := r1["status"]; got != "waiting" {
		t.Fatalf("第 2 条状态 = %v，期望 waiting", got)
	}
	if got := r0["visibility"]; got != "public" {
		t.Fatalf("第 1 条公开范围 = %v，期望 public", got)
	}
	if got := r1["visibility"]; got != "public" {
		t.Fatalf("第 2 条公开范围 = %v，期望 public", got)
	}
	if got := r0["createdAt"]; got != gomokuRoom["createdAt"] {
		t.Fatalf("五子棋创建时间 = %v，期望保持原值 %v", got, gomokuRoom["createdAt"])
	}
	if got := r1["createdAt"]; got != ludoRoom["createdAt"] {
		t.Fatalf("飞行棋创建时间 = %v，期望保持原值 %v", got, ludoRoom["createdAt"])
	}

	// 启动与只查询列表不应改写本地已有内容：重启 + 查询后文件逐字节不变。
	if got := readDataFile(t, dataDir); !bytes.Equal(got, beforeStopFile) {
		t.Fatalf("重启或查询列表改写了数据文件：\n得到: %s\n期望: %s", got, beforeStopFile)
	}

	// 重启后再成功创建一个房间：只能在原记录之后追加，旧记录内容与相对顺序不变。
	createStatus, third := postRoom(t, second.url,
		`{"name":"重启后新开的飞行棋","game":"ludo","capacity":2,"turnSeconds":600}`)
	if createStatus != http.StatusCreated {
		t.Fatalf("重启后创建状态码 = %d，期望 201，响应: %v", createStatus, third)
	}
	thirdID, _ := third["id"].(string)
	if thirdID == "" {
		t.Fatal("重启后新房间编号为空")
	}
	if thirdID == gomokuID || thirdID == ludoID {
		t.Fatalf("重启后新房间编号 %q 与已有编号重复", thirdID)
	}

	finalStatus, finalRooms := getRooms(t, second.url)
	if finalStatus != http.StatusOK {
		t.Fatalf("追加后查询状态码 = %d，期望 200", finalStatus)
	}
	if len(finalRooms) != 3 {
		t.Fatalf("追加后房间数量 = %d，期望 3（原 2 条 + 新 1 条，不得清空或重新编号）", len(finalRooms))
	}
	if !reflect.DeepEqual(finalRooms[:2], before) {
		t.Fatalf("追加后旧记录的内容或相对顺序被改变：\n得到: %v\n期望: %v", finalRooms[:2], before)
	}
	if !reflect.DeepEqual(finalRooms[2], third) {
		t.Fatalf("列表中的新记录与本次创建响应不一致：\n列表: %v\n响应: %v", finalRooms[2], third)
	}
}

// 历史记录带有备注、数组或嵌套对象等附带字段，或缺少当前表单使用的字段时，
// 正常停止并用同一目录重启后必须按原内容返回，不能仅因字段不完整而删除记录；
// 历史名称中的首尾空白也不能在重启加载时被二次“整理”。启动与只查询列表不改写文件；
// 重启后合法创建的房间追加在这些历史记录之后。
func TestRestartPreservesAncillaryFieldsAndIncompleteHistory(t *testing.T) {
	dataDir := t.TempDir()
	// 完整对象 + 多种附带字段（字符串备注、数组、嵌套对象）。
	histFull := `{"id":"hist-note","name":" 历史备注房 ","game":"ludo","capacity":3,"turnSeconds":0,"status":"waiting","visibility":"public","createdAt":"2026-03-04T10:00:00Z","note":"别忘带棋盘","tags":["周赛","老友"],"extra":{"rank":2,"meta":{"keep":true}}}`
	// 老版本遗留记录：缺少当前表单使用的 game/capacity/turnSeconds 等字段，仍须保留。
	histPartial := `{"id":"legacy-incomplete","name":"缺少表单字段的老房间"}`
	seed := seedRooms(t, dataDir, histFull, histPartial)

	// 第一轮服务（模拟写下这批数据的上一轮进程）：只查询，不改写、不删除。
	first := startRestartServer(t, dataDir)
	assertRoomsUnchanged(t, first.url, dataDir, seed)
	first.stop(t)

	// 第二轮服务：重启后同样原样返回，启动与查询都不动磁盘文件。
	second := startRestartServer(t, dataDir)
	assertRoomsUnchanged(t, second.url, dataDir, seed)

	_, rooms := getRooms(t, second.url)
	full, ok := rooms[0].(map[string]any)
	if !ok {
		t.Fatalf("历史完整记录不是对象: %v", rooms[0])
	}
	if got := full["name"]; got != " 历史备注房 " {
		t.Fatalf("历史名称应原样返回（不在加载时二次去空白），实际: %v", got)
	}
	if got := full["note"]; got != "别忘带棋盘" {
		t.Fatalf("备注字段应原样保留，实际: %v", got)
	}
	tags, ok := full["tags"].([]any)
	if !ok || len(tags) != 2 || tags[0] != "周赛" || tags[1] != "老友" {
		t.Fatalf("数组附带字段应原样保留，实际: %v", full["tags"])
	}
	extra, ok := full["extra"].(map[string]any)
	if !ok {
		t.Fatalf("嵌套对象附带字段缺失: %v", full["extra"])
	}
	if got := extra["rank"]; got != float64(2) {
		t.Fatalf("嵌套对象的 rank 应原样保留，实际: %v", got)
	}
	meta, ok := extra["meta"].(map[string]any)
	if !ok || meta["keep"] != true {
		t.Fatalf("深层嵌套内容应原样保留，实际: %v", extra["meta"])
	}
	partial, ok := rooms[1].(map[string]any)
	if !ok {
		t.Fatalf("字段不完整的历史记录不是对象: %v", rooms[1])
	}
	if len(partial) != 2 || partial["id"] != "legacy-incomplete" || partial["name"] != "缺少表单字段的老房间" {
		t.Fatalf("字段不完整的历史记录应原样保留、不能被补默认值或删除，实际: %v", partial)
	}

	// 重启后合法创建：历史两条原位保留，新对象追加在最后，附带字段不丢。
	createStatus, created := postRoom(t, second.url,
		`{"name":"历史数据上的新房","game":"gomoku","capacity":2,"turnSeconds":30}`)
	if createStatus != http.StatusCreated {
		t.Fatalf("历史数据上创建状态码 = %d，期望 201，响应: %v", createStatus, created)
	}
	_, all := getRooms(t, second.url)
	if len(all) != 3 {
		t.Fatalf("创建后记录数量 = %d，期望 3（历史 2 条一条不少 + 新房 1 条）", len(all))
	}
	if !reflect.DeepEqual(all[:2], decodeRecords(t, seed)) {
		t.Fatalf("创建后历史记录（含附带字段与缺字段记录）被改动：\n得到: %v", all[:2])
	}
	if !reflect.DeepEqual(all[2], created) {
		t.Fatalf("新房间应作为最后一条且与创建响应一致：\n列表: %v\n响应: %v", all[2], created)
	}
}

// 正常停止后保留下来的数据已经损坏（被截断，或顶层是 null 而不是数组）时，
// 重启本身不应清空/替换数据；重启后的列表查询和合法创建都必须返回 500，
// error 明确指向房间数据的读取或解析失败，不能返回成功的空列表或新房间编号，
// 磁盘上的损坏内容逐字节保留。
func TestRestartFailsOnCorruptPersistedData(t *testing.T) {
	t.Run("停止后数据被截断", func(t *testing.T) {
		dataDir := t.TempDir()
		first := startRestartServer(t, dataDir)
		if st, body := postRoom(t, first.url, `{"name":"截断前五子棋","game":"gomoku","capacity":2,"turnSeconds":0}`); st != http.StatusCreated {
			t.Fatalf("准备数据时创建状态码 = %d，期望 201，响应: %v", st, body)
		}
		if st, body := postRoom(t, first.url, `{"name":"截断前飞行棋","game":"ludo","capacity":3,"turnSeconds":45}`); st != http.StatusCreated {
			t.Fatalf("准备数据时创建状态码 = %d，期望 201，响应: %v", st, body)
		}
		first.stop(t)

		// 模拟停止后落盘内容被截断：只保留前半截，整体无法解析为数组。
		original := readDataFile(t, dataDir)
		corrupt := bytes.Clone(original[:len(original)/2])
		if err := os.WriteFile(filepath.Join(dataDir, "rooms.json"), corrupt, 0o644); err != nil {
			t.Fatalf("写入截断数据失败: %v", err)
		}

		// 进程能正常启动（启动不重置数据），但查询与合法创建都返回 500 且文件不动。
		second := startRestartServer(t, dataDir)
		assertCreateFailsOnUnreadableData(t, second.url, dataDir, corrupt)
	})

	t.Run("停止后数据顶层为 null", func(t *testing.T) {
		dataDir := t.TempDir()
		first := startRestartServer(t, dataDir)
		if st, body := postRoom(t, first.url, `{"name":"null 前的房间","game":"gomoku","capacity":2,"turnSeconds":0}`); st != http.StatusCreated {
			t.Fatalf("准备数据时创建状态码 = %d，期望 201，响应: %v", st, body)
		}
		first.stop(t)

		// 模拟停止后保留内容被整体替换为 JSON null。
		nullSeed := seedRaw(t, dataDir, "null\n")

		second := startRestartServer(t, dataDir)
		// 复用既有断言：GET 与合法 POST 均 500、error 指向房间数据、无列表/编号、文件逐字节不变。
		assertCreateFailsOnUnreadableData(t, second.url, dataDir, nullSeed)

		// null 不属于“没有房间”，error 还必须明确指出顶层必须是数组。
		st, body := postRoom(t, second.url, `{"name":"null 上的复验房","game":"gomoku","capacity":2,"turnSeconds":30}`)
		if st != http.StatusInternalServerError {
			t.Fatalf("null 数据上创建状态码 = %d，期望 500，响应: %v", st, body)
		}
		errMsg, _ := body["error"].(string)
		if !strings.Contains(errMsg, "数组") {
			t.Fatalf("error 应明确说明房间数据必须是数组、null 不代表空列表，实际: %q", errMsg)
		}
	})
}

// 真正的空数组仍表示没有房间：经历正常停止与同目录重启后，查询成功且列表为空，
// 启动与查询都不改写空数组文件；随后正常创建的第一条记录可以被查询到。
func TestRestartEmptyArrayRemainsEmptyThenCreate(t *testing.T) {
	dataDir := t.TempDir()

	// 首次启动会把数据文件初始化为空数组。
	first := startRestartServer(t, dataDir)
	st, rooms := getRooms(t, first.url)
	if st != http.StatusOK {
		t.Fatalf("首次查询状态码 = %d，期望 200", st)
	}
	if len(rooms) != 0 {
		t.Fatalf("首次查询房间数量 = %d，期望 0", len(rooms))
	}
	first.stop(t)
	if got := readDataFile(t, dataDir); string(got) != "[]\n" {
		t.Fatalf("首次启动应初始化为空数组文件，实际: %q", got)
	}

	// 同目录重启：仍是成功的空列表，启动与查询都不得把空数组改写成别的内容。
	second := startRestartServer(t, dataDir)
	st, rooms = getRooms(t, second.url)
	if st != http.StatusOK {
		t.Fatalf("重启后查询状态码 = %d，期望 200", st)
	}
	if len(rooms) != 0 {
		t.Fatalf("重启后空列表出现了房间，数量 = %d，期望 0", len(rooms))
	}
	if got := readDataFile(t, dataDir); string(got) != "[]\n" {
		t.Fatalf("重启或查询空列表改写了数据文件，实际: %q", got)
	}

	// 空列表上正常创建的第一条房间可以被查询到。
	createStatus, created := postRoom(t, second.url,
		`{"name":"空列表后的第一间","game":"ludo","capacity":3,"turnSeconds":0}`)
	if createStatus != http.StatusCreated {
		t.Fatalf("空列表上创建状态码 = %d，期望 201，响应: %v", createStatus, created)
	}
	if id, _ := created["id"].(string); id == "" {
		t.Fatal("新房间编号为空")
	}
	st, rooms = getRooms(t, second.url)
	if st != http.StatusOK || len(rooms) != 1 {
		t.Fatalf("创建后查询状态码 = %d、数量 = %d，期望 200 与 1 条", st, len(rooms))
	}
	if !reflect.DeepEqual(rooms[0], created) {
		t.Fatalf("列表中的第一条记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[0], created)
	}
}
