package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// 本文件通过公开 HTTP 接口对“创建房间并保存到本地”的行为做端到端回归测试：
// 以子进程方式启动真实服务（--port 0 自动选端口），不改动任何现有代码。

var serverBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "score-arena-testbin")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(dir)

	bin := filepath.Join(dir, "score-arena")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "构建服务失败:", err)
		os.Exit(1)
	}
	serverBin = bin
	os.Exit(m.Run())
}

// startServer 在 dataDir 上启动服务子进程，返回基地址（如 http://127.0.0.1:12345）。
func startServer(t *testing.T, dataDir string) string {
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
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	lineCh := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if line := scanner.Text(); strings.Contains(line, "listening on") {
				lineCh <- line
				return
			}
		}
		lineCh <- ""
	}()

	select {
	case line := <-lineCh:
		if line == "" {
			t.Fatal("服务在输出监听地址前退出")
		}
		idx := strings.Index(line, "http://")
		if idx < 0 {
			t.Fatalf("无法从服务输出解析地址: %q", line)
		}
		return strings.TrimSpace(line[idx:])
	case <-time.After(15 * time.Second):
		t.Fatal("等待服务监听地址超时")
		return ""
	}
}

// seedRooms 在 dataDir 下写入给定的房间记录（每条为一段 JSON 文本），返回文件内容。
func seedRooms(t *testing.T, dataDir string, records ...string) []byte {
	t.Helper()
	content := "[\n" + strings.Join(records, ",\n") + "\n]\n"
	if err := os.WriteFile(filepath.Join(dataDir, "rooms.json"), []byte(content), 0o644); err != nil {
		t.Fatalf("写入种子数据失败: %v", err)
	}
	return []byte(content)
}

func decodeRecords(t *testing.T, raw []byte) []any {
	t.Helper()
	var records []any
	if err := json.Unmarshal(raw, &records); err != nil {
		t.Fatalf("解析记录失败: %v", err)
	}
	return records
}

var httpClient = &http.Client{Timeout: 5 * time.Second}

// postRoom 提交创建请求，返回状态码与解码后的响应体。
func postRoom(t *testing.T, baseURL, body string) (int, map[string]any) {
	t.Helper()
	resp, err := httpClient.Post(baseURL+"/api/rooms", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST /api/rooms 失败: %v", err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应失败: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("响应不是合法 JSON: %v（内容: %s）", err, payload)
	}
	return resp.StatusCode, decoded
}

// getRooms 查询房间列表，返回状态码与记录数组（保持服务端顺序）。
func getRooms(t *testing.T, baseURL string) (int, []any) {
	t.Helper()
	resp, err := httpClient.Get(baseURL + "/api/rooms")
	if err != nil {
		t.Fatalf("GET /api/rooms 失败: %v", err)
	}
	defer resp.Body.Close()
	var body struct {
		Rooms []json.RawMessage `json:"rooms"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("房间列表响应不是合法 JSON: %v", err)
	}
	rooms := make([]any, 0, len(body.Rooms))
	for _, raw := range body.Rooms {
		var record any
		if err := json.Unmarshal(raw, &record); err != nil {
			t.Fatalf("房间记录不是合法 JSON: %v", err)
		}
		rooms = append(rooms, record)
	}
	return resp.StatusCode, rooms
}

func readDataFile(t *testing.T, dataDir string) []byte {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(dataDir, "rooms.json"))
	if err != nil {
		t.Fatalf("读取数据文件失败: %v", err)
	}
	return content
}

// assertRoomsUnchanged 断言查询结果与磁盘文件都和种子数据完全一致（数量、内容、顺序、附带字段）。
func assertRoomsUnchanged(t *testing.T, baseURL, dataDir string, seed []byte) {
	t.Helper()
	status, rooms := getRooms(t, baseURL)
	if status != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", status)
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms, want) {
		t.Fatalf("房间列表被改动：\n得到: %v\n期望: %v", rooms, want)
	}
	if got := readDataFile(t, dataDir); !bytes.Equal(got, seed) {
		t.Fatalf("数据文件被改动：\n得到: %s\n期望: %s", got, seed)
	}
}

// 种子记录带有额外字段（note、tags、extra），用于验证追加新房间时附带字段原样保留。
var seedRecord1 = `{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}`
var seedRecord2 = `{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}`

// 已有房间时，合法创建应成功追加，且原有记录（含附带字段）保持不变。
func TestCreateRoomAppendsToExistingRooms(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	status, created := postRoom(t, baseURL, `{"name":"  周末 五子棋 友谊赛  ","game":"gomoku","capacity":2,"turnSeconds":0}`)
	if status != http.StatusCreated {
		t.Fatalf("创建状态码 = %d，期望 201，响应: %v", status, created)
	}

	id, _ := created["id"].(string)
	if id == "" {
		t.Fatal("新房间编号为空")
	}
	if id == "seed-alpha" || id == "seed-beta" {
		t.Fatalf("新房间编号 %q 与已有编号重复", id)
	}
	if got, want := created["name"], "周末 五子棋 友谊赛"; got != want {
		t.Fatalf("名称 = %v，期望 %q（仅去掉首尾空白，内部空格保留）", got, want)
	}
	if got := created["game"]; got != "gomoku" {
		t.Fatalf("游戏 = %v，期望 gomoku", got)
	}
	if got := created["capacity"]; got != float64(2) {
		t.Fatalf("人数 = %v，期望 2", got)
	}
	if got := created["turnSeconds"]; got != float64(0) {
		t.Fatalf("每步时间 = %v，期望 0（不限时）", got)
	}
	if got := created["status"]; got != "waiting" {
		t.Fatalf("状态 = %v，期望 waiting", got)
	}
	if got := created["visibility"]; got != "public" {
		t.Fatalf("公开范围 = %v，期望 public", got)
	}
	createdAt, _ := created["createdAt"].(string)
	if _, err := time.Parse(time.RFC3339, createdAt); err != nil {
		t.Fatalf("创建时间 %q 不是有效的 RFC3339 时间: %v", createdAt, err)
	}

	// 列表应包含同一条新记录，追加在原记录之后。
	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if len(rooms) != 3 {
		t.Fatalf("房间数量 = %d，期望 3（原有 2 条 + 新增 1 条）", len(rooms))
	}
	seedRecords := decodeRecords(t, seed)
	if !reflect.DeepEqual(rooms[:2], seedRecords) {
		t.Fatalf("原有房间被改写或重新排序：\n得到: %v\n期望: %v", rooms[:2], seedRecords)
	}
	last, ok := rooms[2].(map[string]any)
	if !ok {
		t.Fatalf("新记录不是对象: %v", rooms[2])
	}
	if !reflect.DeepEqual(last, created) {
		t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", last, created)
	}
	if got := last["turnSeconds"]; got != float64(0) {
		t.Fatalf("列表中新记录的每步时间 = %v，期望 0（不限时）", got)
	}
}

// 没有历史记录时，同样应能成功创建并查询到第一条房间。
func TestCreateRoomOnEmptyHistory(t *testing.T) {
	dataDir := t.TempDir()
	baseURL := startServer(t, dataDir)

	status, created := postRoom(t, baseURL, `{"name":"  第一间 五子棋 房  ","game":"gomoku","capacity":2,"turnSeconds":0}`)
	if status != http.StatusCreated {
		t.Fatalf("创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	if id, _ := created["id"].(string); id == "" {
		t.Fatal("新房间编号为空")
	}
	if got, want := created["name"], "第一间 五子棋 房"; got != want {
		t.Fatalf("名称 = %v，期望 %q", got, want)
	}

	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if len(rooms) != 1 {
		t.Fatalf("房间数量 = %d，期望 1", len(rooms))
	}
	if !reflect.DeepEqual(rooms[0], created) {
		t.Fatalf("列表中的记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[0], created)
	}
}

// 缺少每步时间不能被当成不限时，应返回 400 且不产生新房间、不改变原有记录。
func TestCreateRoomRejectedWhenTurnSecondsMissing(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	status, body := postRoom(t, baseURL, `{"name":"缺时间的房间","game":"gomoku","capacity":2}`)
	if status != http.StatusBadRequest {
		t.Fatalf("状态码 = %d，期望 400，响应: %v", status, body)
	}
	errMsg, _ := body["error"].(string)
	if !strings.Contains(errMsg, "turnSeconds") {
		t.Fatalf("error 应说明缺少 turnSeconds，实际: %q", errMsg)
	}
	if _, ok := body["id"]; ok {
		t.Fatalf("被拒绝的请求不应返回房间，实际: %v", body)
	}

	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// 每步时间带小数不能被取整保存，应返回 400 且不产生新房间、不改变原有记录。
func TestCreateRoomRejectedWhenTurnSecondsFractional(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	status, body := postRoom(t, baseURL, `{"name":"小数时间房","game":"gomoku","capacity":2,"turnSeconds":30.5}`)
	if status != http.StatusBadRequest {
		t.Fatalf("状态码 = %d，期望 400，响应: %v", status, body)
	}
	errMsg, _ := body["error"].(string)
	if !strings.Contains(errMsg, "turnSeconds") || !strings.Contains(errMsg, "整数") {
		t.Fatalf("error 应说明 turnSeconds 必须是整数，实际: %q", errMsg)
	}
	if _, ok := body["id"]; ok {
		t.Fatalf("被拒绝的请求不应返回房间，实际: %v", body)
	}

	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// 数据可读、配置合法但保存无法完成时，应返回 500 并说明保存失败，
// 原有数据保持完整可读，不出现只保存了一部分的新记录。
func TestCreateRoomFailsWhenSaveFails(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	// 数据文件保持可读，但数据目录不可写，本次保存必然失败。
	if err := os.Chmod(dataDir, 0o555); err != nil {
		t.Fatalf("修改数据目录权限失败: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dataDir, 0o755) })

	status, body := postRoom(t, baseURL, `{"name":"保存失败的房间","game":"gomoku","capacity":2,"turnSeconds":0}`)
	if status != http.StatusInternalServerError {
		t.Fatalf("状态码 = %d，期望 500，响应: %v", status, body)
	}
	errMsg, _ := body["error"].(string)
	if !strings.Contains(errMsg, "失败") || !strings.Contains(errMsg, "数据") {
		t.Fatalf("error 应明确说明保存失败，实际: %q", errMsg)
	}
	if _, ok := body["id"]; ok {
		t.Fatalf("保存失败不应返回成功房间，实际: %v", body)
	}

	// 原数据完整可读：数量、内容和附带字段与创建前一致。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// 名称首尾空白采用 Unicode 空白范围：U+0085、U+00A0 等应去掉，
// U+FEFF 不属于该范围，应保留并计入长度；内部空白原样保留。
func TestCreateRoomTrimsUnicodeWhitespaceButKeepsFEFF(t *testing.T) {
	dataDir := t.TempDir()
	seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	rawName := "\u0085\u00a0\ufeff深夜\ufeff 对局\ufeff \u00a0\u0085"
	wantName := "\ufeff深夜\ufeff 对局\ufeff"
	body, _ := json.Marshal(map[string]any{"name": rawName, "game": "ludo", "capacity": 3, "turnSeconds": 60})
	status, created := postRoom(t, baseURL, string(body))
	if status != http.StatusCreated {
		t.Fatalf("创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	if got := created["name"]; got != wantName {
		t.Fatalf("名称 = %q，期望 %q（U+0085/U+00A0 去掉，U+FEFF 保留，内部空格不动）", got, wantName)
	}

	// 仅由 U+FEFF 组成的名称长度为 1 个码点，是合法名称。
	body, _ = json.Marshal(map[string]any{"name": "\ufeff", "game": "gomoku", "capacity": 2, "turnSeconds": 0})
	status, created = postRoom(t, baseURL, string(body))
	if status != http.StatusCreated {
		t.Fatalf("U+FEFF 名称创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	if got := created["name"]; got != "\ufeff" {
		t.Fatalf("名称 = %q，期望 %q（U+FEFF 保留并计入长度）", got, "\ufeff")
	}
}

// 名称长度按 Unicode 码点计：恰好 40 个码点（含补充平面表情）可以创建，
// 41 个码点必须拒绝，且不产生新房间、不改变已有数据。
func TestCreateRoomNameLengthBoundary(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	name40 := strings.Repeat("棋", 39) + "😀"
	body, _ := json.Marshal(map[string]any{"name": name40, "game": "gomoku", "capacity": 2, "turnSeconds": 0})
	status, created := postRoom(t, baseURL, string(body))
	if status != http.StatusCreated {
		t.Fatalf("40 码点名称创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	if got := created["name"]; got != name40 {
		t.Fatalf("保存的名称 = %q，期望 %q", got, name40)
	}

	name41 := strings.Repeat("棋", 40) + "😀"
	body, _ = json.Marshal(map[string]any{"name": name41, "game": "gomoku", "capacity": 2, "turnSeconds": 0})
	status, rejected := postRoom(t, baseURL, string(body))
	if status != http.StatusBadRequest {
		t.Fatalf("41 码点名称状态码 = %d，期望 400，响应: %v", status, rejected)
	}
	errMsg, _ := rejected["error"].(string)
	if !strings.Contains(errMsg, "40") {
		t.Fatalf("error 应说明超过 40 个字符，实际: %q", errMsg)
	}
	if _, ok := rejected["id"]; ok {
		t.Fatalf("被拒绝的请求不应返回房间编号，实际: %v", rejected)
	}

	// 只有 40 码点那一条被追加，拒绝的请求不产生记录，种子记录保持不变。
	_, rooms := getRooms(t, baseURL)
	if len(rooms) != 3 {
		t.Fatalf("房间数量 = %d，期望 3（种子 2 条 + 40 码点 1 条）", len(rooms))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("种子记录被改动：\n得到: %v\n期望: %v", rooms[:2], want)
	}
}

// seedRaw 以原始字节写入 rooms.json，用于构造损坏或形态异常的历史数据。
func seedRaw(t *testing.T, dataDir string, content string) []byte {
	t.Helper()
	raw := []byte(content)
	if err := os.WriteFile(filepath.Join(dataDir, "rooms.json"), raw, 0o644); err != nil {
		t.Fatalf("写入种子数据失败: %v", err)
	}
	return raw
}

// getRoomsResponse 查询房间列表，返回状态码与解码后的响应体（成功或失败均可）。
func getRoomsResponse(t *testing.T, baseURL string) (int, map[string]any) {
	t.Helper()
	resp, err := httpClient.Get(baseURL + "/api/rooms")
	if err != nil {
		t.Fatalf("GET /api/rooms 失败: %v", err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应失败: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("响应不是合法 JSON: %v（内容: %s）", err, payload)
	}
	return resp.StatusCode, decoded
}

// assertCreateFailsOnUnreadableData 在历史数据读不出来的前提下提交一份完全合法的房间配置，
// 断言：创建返回 500 且 error 指向房间数据的读取/解析问题（而非用户输入），
// 不返回新房间编号或成功房间对象；查询同一份数据同样返回 500 而不是空列表；
// 磁盘上的原始数据逐字节保持不变（不清空、不改写、不追加、不修复）。
func assertCreateFailsOnUnreadableData(t *testing.T, baseURL, dataDir string, seed []byte) {
	t.Helper()

	status, body := postRoom(t, baseURL, `{"name":"读取保护验证房","game":"gomoku","capacity":2,"turnSeconds":30}`)
	if status != http.StatusInternalServerError {
		t.Fatalf("创建状态码 = %d，期望 500，响应: %v", status, body)
	}
	errMsg, _ := body["error"].(string)
	if errMsg == "" {
		t.Fatalf("读取失败时响应应包含非空 error，实际: %v", body)
	}
	if !strings.Contains(errMsg, "房间数据") {
		t.Fatalf("error 应说明问题出在房间数据的读取或解析，实际: %q", errMsg)
	}
	if strings.Contains(errMsg, "缺少必填字段") || strings.Contains(errMsg, "不能为空") {
		t.Fatalf("error 不应把读取失败归为用户漏填字段或配置不合法，实际: %q", errMsg)
	}
	if _, ok := body["id"]; ok {
		t.Fatalf("读取失败不应返回新房间编号，实际: %v", body)
	}
	if _, ok := body["rooms"]; ok {
		t.Fatalf("读取失败不应返回成功的房间对象或列表，实际: %v", body)
	}

	// 查询同一份数据也应明确报 500，不能以成功的空列表掩盖问题。
	getStatus, getBody := getRoomsResponse(t, baseURL)
	if getStatus != http.StatusInternalServerError {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 500，响应: %v", getStatus, getBody)
	}
	getErr, _ := getBody["error"].(string)
	if !strings.Contains(getErr, "房间数据") {
		t.Fatalf("GET 的 error 应说明房间数据读取失败，实际: %q", getErr)
	}
	if _, ok := getBody["rooms"]; ok {
		t.Fatalf("读取失败不应返回房间列表，实际: %v", getBody)
	}

	// 原数据逐字节保持不变：内容、顺序、附带字段不动，也没有本次提交的新记录。
	if got := readDataFile(t, dataDir); !bytes.Equal(got, seed) {
		t.Fatalf("数据文件被改动：\n得到: %s\n期望: %s", got, seed)
	}
}

// 已有数据被截断、缺少结束符而无法解析时，即使前半段仍能辨认出已有房间，
// 合法创建也必须返回 500，不能丢弃可解析部分后继续追加，原数据保持不变。
func TestCreateRoomFailsWhenDataTruncated(t *testing.T) {
	dataDir := t.TempDir()
	// 前半段是两条完整可辨的房间记录，但整体缺少收尾，无法作为数组解析。
	seed := seedRaw(t, dataDir, "[\n"+seedRecord1+",\n"+seedRecord2+",\n{\"id\":\"seed-ga")
	baseURL := startServer(t, dataDir)

	assertCreateFailsOnUnreadableData(t, baseURL, dataDir, seed)
}

// 已有内容是完整 JSON 却是一个对象而不是房间数组时，
// 合法创建必须返回 500，不能当成没有房间后用新记录覆盖。
func TestCreateRoomFailsWhenDataIsObjectNotArray(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRaw(t, dataDir, "{\n  \"rooms\": [\n"+seedRecord1+"\n  ]\n}\n")
	baseURL := startServer(t, dataDir)

	assertCreateFailsOnUnreadableData(t, baseURL, dataDir, seed)
}

// 整份数据是 JSON null 时，null 不表示“还没有房间”：公开约定要求顶层必须是
// 数组，只有空数组才表示没有记录。查询必须返回 500（不能返回成功的 rooms 内容），
// 合法创建同样必须返回 500 且原因落在已保存的房间数据上；文件内容逐字节保留，
// 不能被替换为空数组、追加房间或改写周围空白。null 前后的合法 JSON 空白一视同仁。
func TestRoomsFailWhenDataIsNull(t *testing.T) {
	cases := []struct {
		name    string
		content string
	}{
		{"仅 null", "null\n"},
		{"null 前后带合法 JSON 空白", " \t null \r\n"},
		{"制表符与换行包围的 null", "\t\nnull\n\t"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dataDir := t.TempDir()
			seed := seedRaw(t, dataDir, tc.content)
			baseURL := startServer(t, dataDir)

			assertCreateFailsOnUnreadableData(t, baseURL, dataDir, seed)

			// 失败信息必须明确指出房间数据必须是数组，与输入类错误区分开。
			status, body := postRoom(t, baseURL, `{"name":"null 数据复验房","game":"gomoku","capacity":2,"turnSeconds":30}`)
			if status != http.StatusInternalServerError {
				t.Fatalf("再次创建状态码 = %d，期望 500，响应: %v", status, body)
			}
			errMsg, _ := body["error"].(string)
			if !strings.Contains(errMsg, "数组") {
				t.Fatalf("error 应明确说明房间数据必须是数组，实际: %q", errMsg)
			}
			if strings.Contains(errMsg, "缺少必填字段") || strings.Contains(errMsg, "不能为空") {
				t.Fatalf("error 不应把格式错误归为用户漏填字段，实际: %q", errMsg)
			}

			// 文件仍逐字节保留为最初的 null 内容。
			if got := readDataFile(t, dataDir); !bytes.Equal(got, seed) {
				t.Fatalf("数据文件被改动：\n得到: %s\n期望: %s", got, seed)
			}
		})
	}
}

// 已有内容是带正常 JSON 空白的空数组时，属于合法空列表：
// 创建应照常返回 201，查询能得到与创建响应一致的那一个新房间。
func TestCreateRoomOnEmptyArrayWithWhitespace(t *testing.T) {
	dataDir := t.TempDir()
	seedRaw(t, dataDir, "  [\n]\n")
	baseURL := startServer(t, dataDir)

	status, created := postRoom(t, baseURL, `{"name":"空白环绕的空列表","game":"ludo","capacity":3,"turnSeconds":60}`)
	if status != http.StatusCreated {
		t.Fatalf("创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	if id, _ := created["id"].(string); id == "" {
		t.Fatal("新房间编号为空")
	}

	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if len(rooms) != 1 {
		t.Fatalf("房间数量 = %d，期望 1", len(rooms))
	}
	if !reflect.DeepEqual(rooms[0], created) {
		t.Fatalf("列表中的记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[0], created)
	}
}

// 已有数据只有空白、没有数组内容时，不能套用首次使用的空列表行为，
// 应按解析失败处理：创建返回 500，原数据保持不变。
func TestCreateRoomFailsWhenDataOnlyWhitespace(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRaw(t, dataDir, "  \n\t \n")
	baseURL := startServer(t, dataDir)

	assertCreateFailsOnUnreadableData(t, baseURL, dataDir, seed)
}

// 历史房间数组里混有非对象记录（null、字符串、数字、布尔值、数组——含空数组与
// 内部装着房间对象的数组）以及带额外字段或缺字段的对象时，GET /api/rooms 必须
// 把全部元素按数量、次序与原始类型原样返回：页面展示层正是依据“是不是 JSON 对象”
// 决定能否成为房间行，接口层不能提前过滤、丢弃或展开任何一条记录。
// 仅读取列表不得改写磁盘文件；随后合法创建房间时，原有混合记录仍要原位保留，
// 新房间对象追加在最后。
func TestGetRoomsPreservesMixedRawRecords(t *testing.T) {
	dataDir := t.TempDir()
	mixed := []string{
		seedRecord1, // 完整对象，附带 note/tags 额外字段
		`null`,
		`"误入的字符串"`,
		`""`, // 空字符串不能因其为空而漏计
		`0`,  // 数字 0 不能因其为假值而漏计
		`42`,
		`false`, // 布尔 false 不能因其为假值而漏计
		`true`,
		`[]`,                      // 空数组：一条非对象记录，不是“没有记录”
		`[{"id":"inside-array"}]`, // 装着对象的数组：整体一条记录，不能展开
		`{"id":"only-id"}`,        // 缺字段对象：仍是一条对象记录
	}
	seed := seedRooms(t, dataDir, mixed...)
	baseURL := startServer(t, dataDir)

	status, rooms := getRooms(t, baseURL)
	if status != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", status)
	}
	if len(rooms) != len(mixed) {
		t.Fatalf("返回记录数量 = %d，期望 %d（非对象记录不得被丢弃）", len(rooms), len(mixed))
	}

	// 与种子逐元素比对（解码后的值、次序、类型与附带字段完全一致）。
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms, want) {
		t.Fatalf("混合记录未被原样保留：\n得到: %v\n期望: %v", rooms, want)
	}

	// 逐位置钉住原始类型，防止“看起来数量对”但元素被转换或重新排序。
	if rooms[1] != nil {
		t.Fatalf("第 2 条应为 null，实际 %v (%T)", rooms[1], rooms[1])
	}
	if got := rooms[2]; got != "误入的字符串" {
		t.Fatalf("字符串记录应为 %q，实际 %v", "误入的字符串", got)
	}
	if got := rooms[3]; got != "" {
		t.Fatalf("空字符串记录应保留为空串，实际 %v (%T)", got, got)
	}
	if got := rooms[4]; got != float64(0) {
		t.Fatalf("数字 0 记录应保留为 0，实际 %v (%T)", got, got)
	}
	if got := rooms[6]; got != false {
		t.Fatalf("布尔 false 记录应保留为 false，实际 %v (%T)", got, got)
	}
	arr, ok := rooms[8].([]any)
	if !ok {
		t.Fatalf("空数组记录应保留为数组类型，实际 %T", rooms[8])
	}
	if len(arr) != 0 {
		t.Fatalf("空数组记录不应被展开或填充，实际 %v", arr)
	}
	nested, ok := rooms[9].([]any)
	if !ok || len(nested) != 1 {
		t.Fatalf("装对象的数组应整体保留为仅含 1 个元素的数组，实际 %v", rooms[9])
	}
	if inner, _ := nested[0].(map[string]any); inner["id"] != "inside-array" {
		t.Fatalf("数组内对象应原样保留在数组内部，实际 %v", nested[0])
	}
	if partial, ok := rooms[10].(map[string]any); !ok || len(partial) != 1 || partial["id"] != "only-id" {
		t.Fatalf("缺字段对象应原样保留为对象记录，实际 %v", rooms[10])
	}
	if first, _ := rooms[0].(map[string]any); first["note"] != "保留我" {
		t.Fatalf("首条对象的附带字段应原样保留，实际 %v", rooms[0])
	}

	// 只读取列表不得产生任何写入：磁盘文件与种子逐字节一致。
	if got := readDataFile(t, dataDir); !bytes.Equal(got, seed) {
		t.Fatalf("读取列表改写了数据文件：\n得到: %s\n期望: %s", got, seed)
	}

	// 混合数据下合法创建房间：原有 11 条混合记录原位保留，新对象追加在最后。
	createStatus, created := postRoom(t, baseURL, `{"name":"混合数据新建房","game":"gomoku","capacity":2,"turnSeconds":0}`)
	if createStatus != http.StatusCreated {
		t.Fatalf("混合历史数据下创建状态码 = %d，期望 201，响应: %v", createStatus, created)
	}
	_, after := getRooms(t, baseURL)
	if len(after) != len(mixed)+1 {
		t.Fatalf("创建后记录数量 = %d，期望 %d（原记录一条不少 + 新房间 1 条）", len(after), len(mixed)+1)
	}
	if !reflect.DeepEqual(after[:len(mixed)], decodeRecords(t, seed)) {
		t.Fatalf("创建后原有混合记录被改动：\n得到: %v", after[:len(mixed)])
	}
	last, ok := after[len(after)-1].(map[string]any)
	if !ok || last["id"] != created["id"] {
		t.Fatalf("新房间应作为对象追加在最后，实际 %v", after[len(after)-1])
	}
}

// 游戏规则与人数上限必须匹配：五子棋固定 2 人，飞行棋 2 至 4 人。
// 首页会随规则联动人数选项，但直接调用接口的请求不经过页面，
// 因此服务端必须独立完成同样的校验。下面验证所有允许的组合都能
// 按提交值保存（飞行棋 2/3/4 人不能都被存成 2），新房间追加在
// 原有记录之后，列表中的规则与人数和创建响应一致。
func TestCreateRoomGameCapacityCombinations(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		name     string
		game     string
		capacity int
		turn     int
	}{
		{"周末五子棋", "gomoku", 2, 0},
		{"双人飞行棋", "ludo", 2, 30},
		{"三人飞行棋", "ludo", 3, 60},
		{"四人飞行棋", "ludo", 4, 600},
	}

	createdRooms := make([]map[string]any, 0, len(cases))
	for _, tc := range cases {
		body, _ := json.Marshal(map[string]any{
			"name": "  " + tc.name + "  ", "game": tc.game,
			"capacity": tc.capacity, "turnSeconds": tc.turn,
		})
		status, created := postRoom(t, baseURL, string(body))
		if status != http.StatusCreated {
			t.Fatalf("%s %d 人创建状态码 = %d，期望 201，响应: %v", tc.game, tc.capacity, status, created)
		}
		if id, _ := created["id"].(string); id == "" {
			t.Fatalf("%s %d 人的新房间编号为空", tc.game, tc.capacity)
		}
		if got := created["game"]; got != tc.game {
			t.Fatalf("规则 = %v，期望 %q（与本次提交一致）", got, tc.game)
		}
		if got := created["capacity"]; got != float64(tc.capacity) {
			t.Fatalf("人数 = %v，期望 %d（按提交值保存，不得改写）", got, tc.capacity)
		}
		if got := created["name"]; got != tc.name {
			t.Fatalf("名称 = %v，期望 %q（仍按现有方式去掉首尾空白）", got, tc.name)
		}
		if got := created["turnSeconds"]; got != float64(tc.turn) {
			t.Fatalf("每步时间 = %v，期望 %d（人数校验不得改变其他配置）", got, tc.turn)
		}
		if got := created["status"]; got != "waiting" {
			t.Fatalf("状态 = %v，期望 waiting（未开始）", got)
		}
		if got := created["visibility"]; got != "public" {
			t.Fatalf("公开范围 = %v，期望 public", got)
		}
		createdRooms = append(createdRooms, created)
	}

	// 飞行棋三种人数必须分别保存为 2、3、4，不能都被存成 2。
	seen := map[float64]bool{}
	for _, created := range createdRooms {
		if created["game"] == "ludo" {
			cap, _ := created["capacity"].(float64)
			seen[cap] = true
		}
	}
	for _, want := range []float64{2, 3, 4} {
		if !seen[want] {
			t.Fatalf("飞行棋 %v 人未被按提交值保存，实际保存的人数: %v", want, seen)
		}
	}

	// 列表应在原有 2 条之后按创建次序追加 4 条新房间，
	// 列表中每条的规则、人数与对应创建响应一致。
	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if len(rooms) != 2+len(cases) {
		t.Fatalf("房间数量 = %d，期望 %d（原有 2 条 + 新增 %d 条）", len(rooms), 2+len(cases), len(cases))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间被改写或重新排序：\n得到: %v\n期望: %v", rooms[:2], want)
	}
	for i, created := range createdRooms {
		if !reflect.DeepEqual(rooms[2+i], created) {
			t.Fatalf("列表第 %d 条新记录与创建响应不一致：\n列表: %v\n响应: %v", i+1, rooms[2+i], created)
		}
	}
}

// 与规则不匹配的人数必须被拒绝：五子棋提交 3 或 4 人、飞行棋提交 1 或 5 人，
// 返回 400 且 error 清楚说明该规则允许的人数，不得悄悄改成合法值后创建。
// 这些请求的名称与每步时间都合法，错误原因必须落在规则与人数上，
// 不得显示无关的名称或时间错误。已有房间的数量、次序、内容与附带字段保持原样，
// 本地文件不被改写；把人数改成允许的值再次提交则应正常创建，被拒配置不留记录。
func TestCreateRoomRejectsCapacityMismatchingGame(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		game        string
		capacity    int
		wantErrPart []string // error 必须同时包含的片段，用于辨认具体原因
		fixed       int      // 该规则下允许、用于修正后重发的人数
	}{
		{"gomoku", 3, []string{"五子棋", "2"}, 2},
		{"gomoku", 4, []string{"五子棋", "2"}, 2},
		{"ludo", 1, []string{"飞行棋", "2", "4"}, 2},
		{"ludo", 5, []string{"飞行棋", "2", "4"}, 4},
	}

	for _, tc := range cases {
		// 名称与每步时间都合法，若报错只能是规则与人数不匹配。
		body, _ := json.Marshal(map[string]any{
			"name": "人数不匹配房", "game": tc.game,
			"capacity": tc.capacity, "turnSeconds": 30,
		})
		status, rejected := postRoom(t, baseURL, string(body))
		if status != http.StatusBadRequest {
			t.Fatalf("%s %d 人状态码 = %d，期望 400，响应: %v", tc.game, tc.capacity, status, rejected)
		}
		errMsg, _ := rejected["error"].(string)
		for _, part := range tc.wantErrPart {
			if !strings.Contains(errMsg, part) {
				t.Fatalf("%s %d 人的 error 应包含 %q 以说明该规则允许的人数，实际: %q", tc.game, tc.capacity, part, errMsg)
			}
		}
		if strings.Contains(errMsg, "名称") || strings.Contains(errMsg, "时间") || strings.Contains(errMsg, "turnSeconds") {
			t.Fatalf("名称与时间均合法，error 不应落在无关字段上，实际: %q", errMsg)
		}
		if _, ok := rejected["id"]; ok {
			t.Fatalf("被拒绝的请求不应返回房间编号，实际: %v", rejected)
		}
	}

	// 全部拒绝后：房间数量、次序、内容及附带字段与种子一致，本地文件未被改写。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)

	// 把人数改成对应规则允许的值再次提交，应正常创建；被拒配置不留下任何记录。
	for _, tc := range cases {
		body, _ := json.Marshal(map[string]any{
			"name": "人数不匹配房", "game": tc.game,
			"capacity": tc.fixed, "turnSeconds": 30,
		})
		status, created := postRoom(t, baseURL, string(body))
		if status != http.StatusCreated {
			t.Fatalf("修正为 %s %d 人后创建状态码 = %d，期望 201，响应: %v", tc.game, tc.fixed, status, created)
		}
		if got := created["capacity"]; got != float64(tc.fixed) {
			t.Fatalf("修正后保存的人数 = %v，期望 %d", got, tc.fixed)
		}
	}

	_, rooms := getRooms(t, baseURL)
	if len(rooms) != 2+len(cases) {
		t.Fatalf("房间数量 = %d，期望 %d（种子 2 条 + 修正后 %d 条，被拒配置不得留记录）", len(rooms), 2+len(cases), len(cases))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间被改动：\n得到: %v\n期望: %v", rooms[:2], want)
	}
	for _, record := range rooms[2:] {
		room, _ := record.(map[string]any)
		if room["name"] == "人数不匹配房" {
			game, _ := room["game"].(string)
			cap := room["capacity"]
			allowed := map[string][]float64{"gomoku": {2}, "ludo": {2, 3, 4}}[game]
			ok := false
			for _, a := range allowed {
				if cap == a {
					ok = true
				}
			}
			if !ok {
				t.Fatalf("列表中出现曾被拒绝的 %s %v 人配置，说明拒绝时被悄悄改成合法值或留下了记录", game, cap)
			}
		}
	}
}

// 人数缺失、或以字符串、小数、null 提供时，同样必须拒绝：
// 缺失报“缺少必填字段”，类型不符报“必须是整数”，两者要能区分；
// 不得先转换、取整或补默认人数再保存。已有数据保持不变，
// 修正为合法整数后应正常创建。
func TestCreateRoomRejectsMissingOrNonIntegerCapacity(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		desc        string
		body        string
		wantErrPart []string
	}{
		{"未提供人数", `{"name":"缺人数房","game":"ludo","turnSeconds":30}`, []string{"缺少必填字段", "capacity"}},
		{"人数为字符串", `{"name":"字符串人数房","game":"ludo","capacity":"3","turnSeconds":30}`, []string{"capacity", "整数"}},
		{"人数为小数", `{"name":"小数人数房","game":"ludo","capacity":2.5,"turnSeconds":30}`, []string{"capacity", "整数"}},
		{"人数为 null", `{"name":"null 人数房","game":"ludo","capacity":null,"turnSeconds":30}`, []string{"capacity", "整数"}},
	}

	for _, tc := range cases {
		status, rejected := postRoom(t, baseURL, tc.body)
		if status != http.StatusBadRequest {
			t.Fatalf("%s：状态码 = %d，期望 400，响应: %v", tc.desc, status, rejected)
		}
		errMsg, _ := rejected["error"].(string)
		for _, part := range tc.wantErrPart {
			if !strings.Contains(errMsg, part) {
				t.Fatalf("%s：error 应包含 %q 以区分缺少字段与人数不是整数，实际: %q", tc.desc, part, errMsg)
			}
		}
		// 名称与每步时间都合法，错误原因只能落在人数字段上。
		if strings.Contains(errMsg, "名称") || strings.Contains(errMsg, "turnSeconds") {
			t.Fatalf("%s：名称与时间均合法，error 不应落在无关字段上，实际: %q", tc.desc, errMsg)
		}
		if _, ok := rejected["id"]; ok {
			t.Fatalf("%s：被拒绝的请求不应返回房间编号，实际: %v", tc.desc, rejected)
		}
	}

	// 缺失与类型不符要能区分：缺人数报“缺少必填字段”，非整数报“必须是整数”。
	_, missingBody := postRoom(t, baseURL, `{"name":"复验缺人数","game":"gomoku","turnSeconds":0}`)
	missingErr, _ := missingBody["error"].(string)
	if strings.Contains(missingErr, "整数") {
		t.Fatalf("缺少人数字段不应报“必须是整数”，实际: %q", missingErr)
	}
	// 2.0 带小数点，不是整数字面量，同样按非整数拒绝，不能取整成 2 保存。
	fractionalStatus, fractionalBody := postRoom(t, baseURL, `{"name":"复验小数","game":"gomoku","capacity":2.0,"turnSeconds":0}`)
	if fractionalStatus != http.StatusBadRequest {
		t.Fatalf("小数人数复验状态码 = %d，期望 400，响应: %v", fractionalStatus, fractionalBody)
	}
	fractionalErr, _ := fractionalBody["error"].(string)
	if strings.Contains(fractionalErr, "缺少必填字段") {
		t.Fatalf("人数以非整数提供不应报“缺少必填字段”，实际: %q", fractionalErr)
	}

	// 全部拒绝后：已有房间与本地文件保持原样。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)

	// 修正为合法整数后应正常创建，被拒请求不留下记录。
	status, created := postRoom(t, baseURL, `{"name":"修正人数房","game":"ludo","capacity":3,"turnSeconds":30}`)
	if status != http.StatusCreated {
		t.Fatalf("修正后创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	if got := created["capacity"]; got != float64(3) {
		t.Fatalf("修正后保存的人数 = %v，期望 3", got)
	}
	_, rooms := getRooms(t, baseURL)
	if len(rooms) != 3 {
		t.Fatalf("房间数量 = %d，期望 3（种子 2 条 + 修正后 1 条，被拒请求不得留记录）", len(rooms))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间被改动：\n得到: %v\n期望: %v", rooms[:2], want)
	}
}

// 只含会被去掉的首尾空白（含 U+0085、U+00A0）的名称视为空，
// 返回 400 并说明名称不能为空，不返回新房间编号，已有数据保持不变。
func TestCreateRoomRejectedWhenNameOnlyWhitespace(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	body, _ := json.Marshal(map[string]any{"name": "  \u00a0 \u0085  ", "game": "gomoku", "capacity": 2, "turnSeconds": 0})
	status, rejected := postRoom(t, baseURL, string(body))
	if status != http.StatusBadRequest {
		t.Fatalf("状态码 = %d，期望 400，响应: %v", status, rejected)
	}
	errMsg, _ := rejected["error"].(string)
	if !strings.Contains(errMsg, "不能为空") {
		t.Fatalf("error 应说明名称不能为空，实际: %q", errMsg)
	}
	if _, ok := rejected["id"]; ok {
		t.Fatalf("被拒绝的请求不应返回房间编号，实际: %v", rejected)
	}

	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}
