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

// writeDataFile 用原始内容直接覆盖 rooms.json（内容可以不是合法 JSON），返回写入的字节。
func writeDataFile(t *testing.T, dataDir string, content string) []byte {
	t.Helper()
	raw := []byte(content)
	if err := os.WriteFile(filepath.Join(dataDir, "rooms.json"), raw, 0o644); err != nil {
		t.Fatalf("写入数据文件失败: %v", err)
	}
	return raw
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

// getRoomsResponse 查询房间列表，返回状态码与解码后的整个响应体（成功或失败均可）。
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
		t.Fatalf("房间列表响应不是合法 JSON: %v（内容: %s）", err, payload)
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

// 合法的创建请求体：名称、游戏规则、人数、每步时间全部合法，
// 用于隔离"已有数据读不出来"这一失败原因（排除配置不合法的干扰）。
const validCreateBody = `{"name":"读取保护验证房","game":"gomoku","capacity":2,"turnSeconds":30}`

// assertCreateFailsOnUnreadableData 验证已有房间数据读不出来时的保护行为：
// 合法创建必须返回 500 并说明是房间数据的读取/解析问题，不能当成没有房间继续追加；
// 原数据文件逐字节保持不变；查询列表同样返回 500 而不是成功的空列表。
func assertCreateFailsOnUnreadableData(t *testing.T, baseURL, dataDir string, original []byte) {
	t.Helper()

	status, body := postRoom(t, baseURL, validCreateBody)
	if status != http.StatusInternalServerError {
		t.Fatalf("创建状态码 = %d，期望 500（读取已有数据失败不能当成没有房间），响应: %v", status, body)
	}
	errMsg, _ := body["error"].(string)
	if errMsg == "" {
		t.Fatalf("响应应包含非空 error 说明读取/解析失败，实际: %v", body)
	}
	if !strings.Contains(errMsg, "房间数据") {
		t.Fatalf("error 应说明问题出在房间数据的读取或解析，实际: %q", errMsg)
	}
	if strings.Contains(errMsg, "缺少") || strings.Contains(errMsg, "不能为空") {
		t.Fatalf("error 不应把责任归为用户漏填字段或配置不合法，实际: %q", errMsg)
	}
	if _, ok := body["id"]; ok {
		t.Fatalf("读取失败不应返回新房间编号，实际: %v", body)
	}
	if _, ok := body["rooms"]; ok {
		t.Fatalf("读取失败不应返回成功的房间对象或列表，实际: %v", body)
	}

	// 查询同一份数据也必须暴露读取失败，不能以成功的空列表掩盖问题。
	listStatus, listBody := getRoomsResponse(t, baseURL)
	if listStatus != http.StatusInternalServerError {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 500，响应: %v", listStatus, listBody)
	}
	listErr, _ := listBody["error"].(string)
	if !strings.Contains(listErr, "读取") || !strings.Contains(listErr, "房间数据") {
		t.Fatalf("列表接口的 error 应明确说明房间数据读取失败，实际: %q", listErr)
	}
	if _, ok := listBody["rooms"]; ok {
		t.Fatalf("读取失败不应返回房间列表（哪怕是空列表），实际: %v", listBody)
	}

	// 原数据与请求前完全相同：不能清空、改写成空数组、补齐损坏内容或留下新记录。
	if got := readDataFile(t, dataDir); !bytes.Equal(got, original) {
		t.Fatalf("数据文件被改动：\n得到: %s\n期望: %s", got, original)
	}
}

// 已有数据被截断、缺少结束符而无法解析时，即使前半段仍能辨认出已有房间，
// 也不能只保留可解析的部分继续追加；合法创建应返回 500，原数据逐字节保留。
func TestCreateRoomFailsWhenDataTruncated(t *testing.T) {
	dataDir := t.TempDir()
	// 两条完整记录之后被截断：缺少第三条记录和结束的 "]"。
	original := writeDataFile(t, dataDir, "[\n"+seedRecord1+",\n"+seedRecord2+",\n")
	baseURL := startServer(t, dataDir)

	assertCreateFailsOnUnreadableData(t, baseURL, dataDir, original)
}

// 已有内容是完整 JSON 但不是房间数组（单个对象）时，同样属于读不出已有数据，
// 合法创建应返回 500，原数据逐字节保留。
func TestCreateRoomFailsWhenDataIsObject(t *testing.T) {
	dataDir := t.TempDir()
	original := writeDataFile(t, dataDir, seedRecord1+"\n")
	baseURL := startServer(t, dataDir)

	assertCreateFailsOnUnreadableData(t, baseURL, dataDir, original)
}

// 已有数据只有空白、没有数组内容时按解析失败处理，
// 不能套用首次使用时的空列表行为；合法创建应返回 500，原数据逐字节保留。
func TestCreateRoomFailsWhenDataOnlyWhitespace(t *testing.T) {
	dataDir := t.TempDir()
	original := writeDataFile(t, dataDir, " \n\t\n")
	baseURL := startServer(t, dataDir)

	assertCreateFailsOnUnreadableData(t, baseURL, dataDir, original)
}

// 与读取失败区分：已有内容是空数组、前后带有正常 JSON 空白时属于合法空列表，
// 创建应照常返回 201，查询能得到与创建响应一致的那一个新房间。
func TestCreateRoomOnEmptyArrayWithWhitespace(t *testing.T) {
	dataDir := t.TempDir()
	writeDataFile(t, dataDir, "  [\n]\n\n")
	baseURL := startServer(t, dataDir)

	status, created := postRoom(t, baseURL, validCreateBody)
	if status != http.StatusCreated {
		t.Fatalf("创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	if id, _ := created["id"].(string); id == "" {
		t.Fatal("新房间编号为空")
	}
	if got, want := created["name"], "读取保护验证房"; got != want {
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
