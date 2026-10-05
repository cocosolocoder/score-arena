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
	"syscall"
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

// managedServer 是一个可以被正常停止的服务子进程句柄。
type managedServer struct {
	cmd     *exec.Cmd
	baseURL string
}

// startManagedServer 在 dataDir 上启动服务子进程，不注册 t.Cleanup 强杀，
// 以便测试显式地走“正常停止（SIGTERM 优雅停机）→ 等待退出”的流程。
func startManagedServer(t *testing.T, dataDir string) *managedServer {
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

	var baseURL string
	select {
	case line := <-lineCh:
		if line == "" {
			_ = cmd.Wait()
			t.Fatal("服务在输出监听地址前退出")
		}
		idx := strings.Index(line, "http://")
		if idx < 0 {
			_ = cmd.Wait()
			t.Fatalf("无法从服务输出解析地址: %q", line)
		}
		baseURL = strings.TrimSpace(line[idx:])
	case <-time.After(15 * time.Second):
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatal("等待服务监听地址超时")
	}
	return &managedServer{cmd: cmd, baseURL: baseURL}
}

// stopGracefully 发送 SIGTERM 让服务走正常停机流程，并等待其退出，
// 模拟题目要求的“正常停止服务”。若进程未在限时内退出则强制结束并使测试失败。
func (s *managedServer) stopGracefully(t *testing.T) {
	t.Helper()
	if err := s.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("发送停止信号失败: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- s.cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		_ = s.cmd.Process.Kill()
		<-done
		t.Fatal("服务在正常停止信号后未退出")
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

// 每步时间限制的合法取值：0 表示不限时，10 至 600 的整数（含两个端点）照常接受。
// 五子棋与飞行棋遵循同一时间规则，人数按各自规则填写。合法请求返回 201，
// 创建响应、房间列表与本地保存记录里的时间数值必须与提交值一致；
// 0 必须作为明确的配置保存（字段存在且为 0），不能被当成没填；
// 名称、规则和人数也不能因为时间处理而改变。
func TestCreateRoomTurnSecondsValidValues(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		name     string
		game     string
		capacity int
		turn     int
	}{
		{"五子棋不限时", "gomoku", 2, 0},
		{"五子棋十秒", "gomoku", 2, 10},
		{"五子棋六百秒", "gomoku", 2, 600},
		{"五子棋四十五秒", "gomoku", 2, 45},
		{"飞行棋不限时", "ludo", 3, 0},
		{"飞行棋十秒", "ludo", 2, 10},
		{"飞行棋六百秒", "ludo", 4, 600},
		{"飞行棋五百九十九秒", "ludo", 4, 599},
	}

	createdRooms := make([]map[string]any, 0, len(cases))
	for _, tc := range cases {
		body, _ := json.Marshal(map[string]any{
			"name": "  " + tc.name + "  ", "game": tc.game,
			"capacity": tc.capacity, "turnSeconds": tc.turn,
		})
		status, created := postRoom(t, baseURL, string(body))
		if status != http.StatusCreated {
			t.Fatalf("%s turnSeconds=%d 创建状态码 = %d，期望 201，响应: %v", tc.game, tc.turn, status, created)
		}
		if id, _ := created["id"].(string); id == "" {
			t.Fatalf("%s turnSeconds=%d 的新房间编号为空", tc.game, tc.turn)
		}
		if got := created["turnSeconds"]; got != float64(tc.turn) {
			t.Fatalf("创建响应的每步时间 = %v，期望 %d（按提交值保存，含明确的 0）", got, tc.turn)
		}
		// 时间处理不得改变其余配置。
		if got := created["name"]; got != tc.name {
			t.Fatalf("名称 = %v，期望 %q（仍按现有方式去掉首尾空白）", got, tc.name)
		}
		if got := created["game"]; got != tc.game {
			t.Fatalf("规则 = %v，期望 %q", got, tc.game)
		}
		if got := created["capacity"]; got != float64(tc.capacity) {
			t.Fatalf("人数 = %v，期望 %d", got, tc.capacity)
		}
		if got := created["status"]; got != "waiting" {
			t.Fatalf("状态 = %v，期望 waiting", got)
		}
		if got := created["visibility"]; got != "public" {
			t.Fatalf("公开范围 = %v，期望 public", got)
		}
		createdRooms = append(createdRooms, created)
	}

	// 房间列表：原有 2 条之后按创建次序追加，每条与创建响应一致。
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

	// 本地保存记录：与列表一致，且每个新房间的 turnSeconds 字段都明确存在、
	// 数值等于提交值——0 也必须落盘为 0，不能缺省或被改成默认时间。
	saved := decodeRecords(t, readDataFile(t, dataDir))
	if !reflect.DeepEqual(saved, rooms) {
		t.Fatalf("本地保存记录与房间列表不一致：\n文件: %v\n列表: %v", saved, rooms)
	}
	for i, tc := range cases {
		record, ok := saved[2+i].(map[string]any)
		if !ok {
			t.Fatalf("保存的第 %d 条新记录不是对象: %v", i+1, saved[2+i])
		}
		got, present := record["turnSeconds"]
		if !present {
			t.Fatalf("%s turnSeconds=%d 的保存记录缺少 turnSeconds 字段（0 也必须明确保存）", tc.game, tc.turn)
		}
		if got != float64(tc.turn) {
			t.Fatalf("保存的每步时间 = %v，期望 %d", got, tc.turn)
		}
	}
}

// 每步时间以非整数形式提供时必须拒绝：null、字符串、布尔值、对象、数组，
// 以及带小数点的 30.0（数值虽为整数）和科学计数法 3e1，都按非整数写法拒绝，
// 不能取整或转换后创建。返回 400 且 error 说明 turnSeconds 必须是整数，
// 而不是缺少字段；不返回成功房间，已有记录与本地文件保持原样。
// 请求中的名称、规则和人数均合法，失败原因只能落在时间配置上。
func TestCreateRoomRejectsNonIntegerTurnSeconds(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		desc string
		body string
	}{
		{"时间为 null", `{"name":"null 时间房","game":"gomoku","capacity":2,"turnSeconds":null}`},
		{"时间为字符串", `{"name":"字符串时间房","game":"gomoku","capacity":2,"turnSeconds":"30"}`},
		{"时间为布尔值", `{"name":"布尔时间房","game":"ludo","capacity":3,"turnSeconds":true}`},
		{"时间为对象", `{"name":"对象时间房","game":"ludo","capacity":4,"turnSeconds":{"seconds":30}}`},
		{"时间为数组", `{"name":"数组时间房","game":"gomoku","capacity":2,"turnSeconds":[30]}`},
		{"时间为带小数点的整数值 30.0", `{"name":"小数点时间房","game":"gomoku","capacity":2,"turnSeconds":30.0}`},
		{"时间为科学计数法 3e1", `{"name":"科学计数时间房","game":"ludo","capacity":2,"turnSeconds":3e1}`},
	}

	for _, tc := range cases {
		status, rejected := postRoom(t, baseURL, tc.body)
		if status != http.StatusBadRequest {
			t.Fatalf("%s：状态码 = %d，期望 400，响应: %v", tc.desc, status, rejected)
		}
		errMsg, _ := rejected["error"].(string)
		if !strings.Contains(errMsg, "turnSeconds") || !strings.Contains(errMsg, "整数") {
			t.Fatalf("%s：error 应说明 turnSeconds 必须是整数，实际: %q", tc.desc, errMsg)
		}
		if strings.Contains(errMsg, "缺少") {
			t.Fatalf("%s：字段已提供但类型不符，error 不应说成缺少字段，实际: %q", tc.desc, errMsg)
		}
		// 名称、规则与人数均合法，错误原因只能落在时间字段上。
		if strings.Contains(errMsg, "名称") || strings.Contains(errMsg, "capacity") || strings.Contains(errMsg, "game") {
			t.Fatalf("%s：其余配置均合法，error 不应落在无关字段上，实际: %q", tc.desc, errMsg)
		}
		if _, ok := rejected["id"]; ok {
			t.Fatalf("%s：被拒绝的请求不应返回房间编号，实际: %v", tc.desc, rejected)
		}
	}

	// 缺少字段与类型不符要能区分：未提供 turnSeconds 报“缺少必填字段”，不含“整数”。
	missingStatus, missingBody := postRoom(t, baseURL, `{"name":"复验缺时间","game":"gomoku","capacity":2}`)
	if missingStatus != http.StatusBadRequest {
		t.Fatalf("缺时间复验状态码 = %d，期望 400，响应: %v", missingStatus, missingBody)
	}
	missingErr, _ := missingBody["error"].(string)
	if !strings.Contains(missingErr, "缺少必填字段") || !strings.Contains(missingErr, "turnSeconds") {
		t.Fatalf("缺少 turnSeconds 应报“缺少必填字段：turnSeconds”，实际: %q", missingErr)
	}
	if strings.Contains(missingErr, "整数") {
		t.Fatalf("缺少时间字段不应报“必须是整数”，实际: %q", missingErr)
	}

	// 全部拒绝后：已有房间数量、次序、内容与附带字段不变，本地文件逐字节保留。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// 整数但越界的每步时间必须拒绝：-1、1、9 和 601 属于范围错误，
// 返回 400（不是 500 服务内部故障），error 说明允许 0（不限时）或 10 至 600 秒；
// 不返回成功房间，已有记录与本地文件保持原样。只把时间改为合法整数、
// 保留其余配置再提交时应正常创建，新房间按修正后的秒数追加，被拒的时间不留记录。
func TestCreateRoomRejectsOutOfRangeTurnSeconds(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	outOfRange := []int{-1, 1, 9, 601}
	for _, turn := range outOfRange {
		body, _ := json.Marshal(map[string]any{
			"name": "越界时间房", "game": "ludo", "capacity": 3, "turnSeconds": turn,
		})
		status, rejected := postRoom(t, baseURL, string(body))
		if status != http.StatusBadRequest {
			t.Fatalf("turnSeconds=%d：状态码 = %d，期望 400（不得返回成功或 500），响应: %v", turn, status, rejected)
		}
		errMsg, _ := rejected["error"].(string)
		for _, part := range []string{"0", "10", "600"} {
			if !strings.Contains(errMsg, part) {
				t.Fatalf("turnSeconds=%d：error 应包含 %q 以说明允许 0 或 10 至 600 秒，实际: %q", turn, part, errMsg)
			}
		}
		// 名称、规则与人数均合法，错误原因只能落在时间范围上。
		if strings.Contains(errMsg, "名称") || strings.Contains(errMsg, "capacity") {
			t.Fatalf("turnSeconds=%d：其余配置均合法，error 不应落在无关字段上，实际: %q", turn, errMsg)
		}
		if _, ok := rejected["id"]; ok {
			t.Fatalf("turnSeconds=%d：被拒绝的请求不应返回房间编号，实际: %v", turn, rejected)
		}
	}

	// 全部拒绝后：已有房间数量、次序、内容与附带字段不变，本地文件逐字节保留。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)

	// 只把时间改成合法整数、其余配置原样保留再提交，应正常创建。
	const fixedTurn = 30
	body, _ := json.Marshal(map[string]any{
		"name": "越界时间房", "game": "ludo", "capacity": 3, "turnSeconds": fixedTurn,
	})
	status, created := postRoom(t, baseURL, string(body))
	if status != http.StatusCreated {
		t.Fatalf("修正时间后创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	if got := created["turnSeconds"]; got != float64(fixedTurn) {
		t.Fatalf("修正后保存的每步时间 = %v，期望 %d", got, fixedTurn)
	}
	if got := created["name"]; got != "越界时间房" {
		t.Fatalf("修正后名称 = %v，期望沿用原名称", got)
	}
	if got := created["game"]; got != "ludo" {
		t.Fatalf("修正后规则 = %v，期望沿用 ludo", got)
	}
	if got := created["capacity"]; got != float64(3) {
		t.Fatalf("修正后人数 = %v，期望沿用 3", got)
	}

	// 新房间按修正后的秒数追加在最后；曾被拒的时间不留下任何记录。
	_, rooms := getRooms(t, baseURL)
	if len(rooms) != 3 {
		t.Fatalf("房间数量 = %d，期望 3（种子 2 条 + 修正后 1 条，被拒时间不得留记录）", len(rooms))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间被改动：\n得到: %v\n期望: %v", rooms[:2], want)
	}
	last, ok := rooms[2].(map[string]any)
	if !ok {
		t.Fatalf("新记录不是对象: %v", rooms[2])
	}
	if !reflect.DeepEqual(last, created) {
		t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", last, created)
	}
	for _, record := range rooms {
		room, _ := record.(map[string]any)
		if room["name"] == "越界时间房" {
			if got := room["turnSeconds"]; got != float64(fixedTurn) {
				t.Fatalf("列表中出现曾被拒绝的时间 %v，说明越界值被保存或留了记录", got)
			}
		}
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

// 以下测试覆盖“正常停止服务后，用同一业务数据目录重新启动”的保留行为：
// 服务子进程先接收 SIGTERM 走优雅停机，再以相同 --data-dir 拉起新进程，
// 全程只通过公开 HTTP 接口与本地 rooms.json 观察结果。

// assertFileByteStable 断言当前数据文件与给定快照逐字节一致，
// 用于钉住“启动”和“只查询列表”都不得改写本地已有内容。
func assertFileByteStable(t *testing.T, dataDir string, snapshot []byte, phase string) {
	t.Helper()
	if got := readDataFile(t, dataDir); !bytes.Equal(got, snapshot) {
		t.Fatalf("%s后数据文件被改写：\n得到: %s\n期望: %s", phase, got, snapshot)
	}
}

// 用户成功创建五子棋（不限时 0）和飞行棋（有限整数秒）房间后正常停止服务，
// 使用同一数据目录重启：查询必须返回停止前的全部记录，数量、排列次序、编号一致，
// 名称、规则、人数、每步时间、状态、公开范围、创建时间均为原值；
// 0 不能被补成默认秒数，两个房间的配置不能相互串用；
// 名称以创建时去首尾空白的结果为准，内部空格与表情保留。
// 启动与只查询列表都不得改写本地文件；重启后再创建的房间只追加在旧记录之后，
// 新编号非空且不同于全部已有编号，旧记录内容与相对顺序不变。
func TestRoomsPreservedAcrossGracefulRestart(t *testing.T) {
	dataDir := t.TempDir()
	server := startManagedServer(t, dataDir)

	// 房间一：五子棋 + 不限时；名称首尾带空白，内部空格与表情必须保留。
	status1, created1 := postRoom(t, server.baseURL, `{"name":"  深夜 😀 五子棋 房  ","game":"gomoku","capacity":2,"turnSeconds":0}`)
	if status1 != http.StatusCreated {
		t.Fatalf("五子棋房间创建状态码 = %d，期望 201，响应: %v", status1, created1)
	}
	// 房间二：飞行棋 + 有限整数秒，人数与时间都不同于房间一。
	status2, created2 := postRoom(t, server.baseURL, `{"name":" 周末 飞行棋 局 🎲 ","game":"ludo","capacity":3,"turnSeconds":45}`)
	if status2 != http.StatusCreated {
		t.Fatalf("飞行棋房间创建状态码 = %d，期望 201，响应: %v", status2, created2)
	}

	id1, _ := created1["id"].(string)
	id2, _ := created2["id"].(string)
	if id1 == "" || id2 == "" || id1 == id2 {
		t.Fatalf("停止前两个房间编号应非空且互不相同，实际: %q, %q", id1, id2)
	}

	// 停止前的列表：两条记录按创建次序排列，与创建响应一致。
	listStatus, beforeStop := getRooms(t, server.baseURL)
	if listStatus != http.StatusOK || len(beforeStop) != 2 {
		t.Fatalf("停止前列表状态码 = %d、数量 = %d，期望 200/2", listStatus, len(beforeStop))
	}
	if !reflect.DeepEqual(beforeStop[0], created1) || !reflect.DeepEqual(beforeStop[1], created2) {
		t.Fatalf("停止前列表与创建响应不一致：\n%v\n%v", beforeStop, []any{created1, created2})
	}

	// 正常停止，并固化停止后的本地文件快照。
	server.stopGracefully(t)
	snapshot := readDataFile(t, dataDir)
	if len(decodeRecords(t, snapshot)) != 2 {
		t.Fatalf("停止后数据文件应有 2 条记录，实际: %s", snapshot)
	}

	// 使用同一业务数据目录重新启动。
	restarted := startManagedServer(t, dataDir)

	// 仅启动不应改写已有文件。
	assertFileByteStable(t, dataDir, snapshot, "重新启动")

	// 只查询列表不应改写本地文件。
	getStatus, afterRestart := getRooms(t, restarted.baseURL)
	if getStatus != http.StatusOK {
		t.Fatalf("重启后 GET /api/rooms 状态码 = %d，期望 200", getStatus)
	}
	assertFileByteStable(t, dataDir, snapshot, "查询列表")

	// 数量、排列次序、编号一致。
	if len(afterRestart) != 2 {
		t.Fatalf("重启后房间数量 = %d，期望 2（不能清空或只恢复部分）", len(afterRestart))
	}
	if !reflect.DeepEqual(afterRestart, beforeStop) {
		t.Fatalf("重启后记录与停止前不一致（数量/次序/任一原值被改）：\n得到: %v\n期望: %v", afterRestart, beforeStop)
	}

	r1, _ := afterRestart[0].(map[string]any)
	r2, _ := afterRestart[1].(map[string]any)
	if r1["id"] != id1 || r2["id"] != id2 {
		t.Fatalf("重启后编号/次序变化: %q, %q（期望 %q, %q）", r1["id"], r2["id"], id1, id2)
	}
	// 名称：以创建成功时去首尾空白的结果为准，内部空格与表情保留。
	if got := r1["name"]; got != "深夜 😀 五子棋 房" {
		t.Fatalf("房间一名称 = %v，期望 %q", got, "深夜 😀 五子棋 房")
	}
	if got := r2["name"]; got != "周末 飞行棋 局 🎲" {
		t.Fatalf("房间二名称 = %v，期望 %q", got, "周末 飞行棋 局 🎲")
	}
	// 规则、人数、时间、状态、公开范围、创建时间逐项钉住原值，防止只恢复部分配置。
	if r1["game"] != "gomoku" || r2["game"] != "ludo" {
		t.Fatalf("规则未按原值保留: %v, %v", r1["game"], r2["game"])
	}
	if r1["capacity"] != float64(2) || r2["capacity"] != float64(3) {
		t.Fatalf("人数未按原值保留: %v, %v（不能相互串用）", r1["capacity"], r2["capacity"])
	}
	if r1["turnSeconds"] != float64(0) {
		t.Fatalf("不限时的 0 未被保留，实际 = %v（不能补成默认值）", r1["turnSeconds"])
	}
	if r2["turnSeconds"] != float64(45) {
		t.Fatalf("有限整数秒未被保留，实际 = %v", r2["turnSeconds"])
	}
	if r1["status"] != "waiting" || r2["status"] != "waiting" {
		t.Fatalf("状态未按原值保留: %v, %v", r1["status"], r2["status"])
	}
	if r1["visibility"] != "public" || r2["visibility"] != "public" {
		t.Fatalf("公开范围未按原值保留: %v, %v", r1["visibility"], r2["visibility"])
	}
	if r1["createdAt"] != created1["createdAt"] || r2["createdAt"] != created2["createdAt"] {
		t.Fatalf("创建时间被改动: %v, %v（期望 %v, %v）",
			r1["createdAt"], r2["createdAt"], created1["createdAt"], created2["createdAt"])
	}

	// 重启后再成功创建一个房间：只能在原记录之后追加。
	status3, created3 := postRoom(t, restarted.baseURL, `{"name":"重启后的新飞行棋","game":"ludo","capacity":4,"turnSeconds":600}`)
	if status3 != http.StatusCreated {
		t.Fatalf("重启后创建状态码 = %d，期望 201，响应: %v", status3, created3)
	}
	id3, _ := created3["id"].(string)
	if id3 == "" {
		t.Fatal("重启后新房间编号为空")
	}
	if id3 == id1 || id3 == id2 {
		t.Fatalf("重启后新房间编号 %q 与已有编号重复", id3)
	}

	_, rooms := getRooms(t, restarted.baseURL)
	if len(rooms) != 3 {
		t.Fatalf("追加后房间数量 = %d，期望 3", len(rooms))
	}
	// 旧记录内容与相对顺序继续保持。
	if !reflect.DeepEqual(rooms[:2], beforeStop) {
		t.Fatalf("追加新房间后旧记录被改动：\n得到: %v\n期望: %v", rooms[:2], beforeStop)
	}
	// 查询到的新记录与这次创建返回的房间一致。
	if !reflect.DeepEqual(rooms[2], created3) {
		t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[2], created3)
	}
	// 本地落盘同样是“旧两条 + 新一条”。
	saved := decodeRecords(t, readDataFile(t, dataDir))
	if len(saved) != 3 || !reflect.DeepEqual(saved[:2], beforeStop) || !reflect.DeepEqual(saved[2], created3) {
		t.Fatalf("落盘记录与预期（旧记录原位 + 新记录追加）不一致: %v", saved)
	}

	restarted.stopGracefully(t)
}

// 历史记录带有备注、数组、嵌套对象等附带字段，或缺少当前表单使用的字段时，
// 正常停止并用同一目录重启后，必须按原内容全部返回：不能因字段不完整删除记录，
// 不能丢附带字段，不能改次序。启动与只查询列表不改写本地文件；
// 重启后合法创建的房间只追加，旧记录原位保留。
func TestExtraAndPartialRecordsSurviveRestart(t *testing.T) {
	dataDir := t.TempDir()

	// 记录一：当前表单字段齐全，附带备注字符串、数组与嵌套对象。
	recFull := `{"id":"restart-full","name":"老友备注房","game":"gomoku","capacity":2,"turnSeconds":0,"status":"waiting","visibility":"public","createdAt":"2026-03-03T03:03:03Z","note":"重启别丢我","tags":["周赛","😀"],"meta":{"board":{"size":15},"history":[1,2,3]}}`
	// 记录二：历史遗留数据，缺少当前表单使用的 game/capacity/turnSeconds，
	// 不能仅因字段不完整而删除。
	recPartial := `{"id":"restart-legacy","name":"遗留房间","createdAt":"2026-02-02T02:02:02Z"}`
	seed := seedRooms(t, dataDir, recFull, recPartial)

	first := startManagedServer(t, dataDir)
	assertFileByteStable(t, dataDir, seed, "首次启动")
	status1, rooms1 := getRooms(t, first.baseURL)
	if status1 != http.StatusOK {
		t.Fatalf("首次查询状态码 = %d，期望 200", status1)
	}
	want := decodeRecords(t, seed)
	if !reflect.DeepEqual(rooms1, want) {
		t.Fatalf("首次查询未原样返回历史记录：\n得到: %v\n期望: %v", rooms1, want)
	}
	assertFileByteStable(t, dataDir, seed, "首次查询列表")
	first.stopGracefully(t)

	// 停止期间文件应保持原样，再用同一目录重启。
	if got := readDataFile(t, dataDir); !bytes.Equal(got, seed) {
		t.Fatalf("正常停止改写了数据文件：\n得到: %s", got)
	}
	restarted := startManagedServer(t, dataDir)
	assertFileByteStable(t, dataDir, seed, "重新启动")

	status2, rooms2 := getRooms(t, restarted.baseURL)
	if status2 != http.StatusOK {
		t.Fatalf("重启后查询状态码 = %d，期望 200", status2)
	}
	if len(rooms2) != 2 {
		t.Fatalf("重启后记录数量 = %d，期望 2（缺字段的遗留记录不能被删除）", len(rooms2))
	}
	if !reflect.DeepEqual(rooms2, want) {
		t.Fatalf("重启后附带字段或遗留记录未原样保留：\n得到: %v\n期望: %v", rooms2, want)
	}
	full, _ := rooms2[0].(map[string]any)
	if full["note"] != "重启别丢我" {
		t.Fatalf("备注字段丢失: %v", full["note"])
	}
	tags, ok := full["tags"].([]any)
	if !ok || len(tags) != 2 || tags[1] != "😀" {
		t.Fatalf("数组附带字段未原样保留: %v", full["tags"])
	}
	meta, ok := full["meta"].(map[string]any)
	if !ok {
		t.Fatalf("嵌套对象附带字段丢失: %v", full["meta"])
	}
	board, _ := meta["board"].(map[string]any)
	if board["size"] != float64(15) {
		t.Fatalf("嵌套对象内容未原样保留: %v", meta["board"])
	}
	history, ok := meta["history"].([]any)
	if !ok || len(history) != 3 || history[2] != float64(3) {
		t.Fatalf("嵌套对象内的数组未原样保留: %v", meta["history"])
	}
	legacy, _ := rooms2[1].(map[string]any)
	if legacy["id"] != "restart-legacy" || legacy["name"] != "遗留房间" {
		t.Fatalf("缺字段的遗留记录被改动: %v", legacy)
	}
	assertFileByteStable(t, dataDir, seed, "重启后查询列表")

	// 重启后合法创建：只在原记录之后追加，旧记录一条不动。
	status3, created := postRoom(t, restarted.baseURL, `{"name":"重启后追加房","game":"ludo","capacity":2,"turnSeconds":30}`)
	if status3 != http.StatusCreated {
		t.Fatalf("重启后创建状态码 = %d，期望 201，响应: %v", status3, created)
	}
	_, rooms3 := getRooms(t, restarted.baseURL)
	if len(rooms3) != 3 {
		t.Fatalf("追加后记录数量 = %d，期望 3", len(rooms3))
	}
	if !reflect.DeepEqual(rooms3[:2], want) {
		t.Fatalf("追加后旧记录被改动：\n得到: %v\n期望: %v", rooms3[:2], want)
	}
	if !reflect.DeepEqual(rooms3[2], created) {
		t.Fatalf("新记录与创建响应不一致：\n列表: %v\n响应: %v", rooms3[2], created)
	}

	restarted.stopGracefully(t)
}

// 停止后保留的数据已损坏（被截断，或顶层是 null 而不是数组）时，
// 用同一目录重启：列表查询与合法创建都必须返回 500，error 明确指向房间数据的
// 读取或解析失败；不能返回成功的空列表或新房间编号；
// 损坏的原数据不能被清空、替换或追加。
func TestCorruptRetainedDataFailsAfterRestart(t *testing.T) {
	cases := []struct {
		name    string
		corrupt func(valid []byte) []byte
		needArr bool // error 是否还需明确指出“数组”
	}{
		{
			name: "保留数据被截断",
			corrupt: func(valid []byte) []byte {
				// 从真实保留文件上不断截掉后半段，直到其确实无法解析为数组。
				corrupt := valid
				for {
					corrupt = corrupt[:len(corrupt)/2]
					var probe []any
					if json.Unmarshal(corrupt, &probe) != nil {
						return corrupt
					}
					if len(corrupt) == 0 {
						return corrupt
					}
				}
			},
			needArr: false,
		},
		{
			name:    "顶层是 null 而不是数组",
			corrupt: func(_ []byte) []byte { return []byte("null\n") },
			needArr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dataDir := t.TempDir()

			// 先正常创建两间房并正常停止，得到真实的保留数据。
			first := startManagedServer(t, dataDir)
			if s, _ := postRoom(t, first.baseURL, `{"name":"损坏前五子棋","game":"gomoku","capacity":2,"turnSeconds":0}`); s != http.StatusCreated {
				t.Fatalf("准备数据：创建房间一失败，状态码 %d", s)
			}
			if s, _ := postRoom(t, first.baseURL, `{"name":"损坏前飞行棋","game":"ludo","capacity":4,"turnSeconds":120}`); s != http.StatusCreated {
				t.Fatalf("准备数据：创建房间二失败，状态码 %d", s)
			}
			if s, rooms := getRooms(t, first.baseURL); s != http.StatusOK || len(rooms) != 2 {
				t.Fatalf("准备数据：停止前列表异常，状态码 %d 数量 %d", s, len(rooms))
			}
			first.stopGracefully(t)

			// 停止后破坏保留下来的数据。
			corrupt := tc.corrupt(readDataFile(t, dataDir))
			if err := os.WriteFile(filepath.Join(dataDir, "rooms.json"), corrupt, 0o644); err != nil {
				t.Fatalf("写入损坏数据失败: %v", err)
			}

			// 用同一目录重启：服务可以启动，但读取房间时必须明确报错。
			restarted := startManagedServer(t, dataDir)
			assertFileByteStable(t, dataDir, corrupt, "带损坏数据重新启动")

			getStatus, getBody := getRoomsResponse(t, restarted.baseURL)
			if getStatus != http.StatusInternalServerError {
				t.Fatalf("损坏数据查询状态码 = %d，期望 500，响应: %v", getStatus, getBody)
			}
			getErr, _ := getBody["error"].(string)
			if !strings.Contains(getErr, "房间数据") {
				t.Fatalf("查询 error 应明确说明房间数据读取或解析失败，实际: %q", getErr)
			}
			if tc.needArr && !strings.Contains(getErr, "数组") {
				t.Fatalf("顶层 null 时 error 应明确说明房间数据必须是数组，实际: %q", getErr)
			}
			if _, ok := getBody["rooms"]; ok {
				t.Fatalf("损坏数据不能返回成功的房间列表（即使为空），实际: %v", getBody["rooms"])
			}
			assertFileByteStable(t, dataDir, corrupt, "损坏数据查询")

			// 提交一份完全合法的创建请求：必须 500 且无新编号，不能追加或替换原数据。
			postStatus, postBody := postRoom(t, restarted.baseURL, `{"name":"损坏后仍要创建","game":"gomoku","capacity":2,"turnSeconds":30}`)
			if postStatus != http.StatusInternalServerError {
				t.Fatalf("损坏数据下创建状态码 = %d，期望 500，响应: %v", postStatus, postBody)
			}
			postErr, _ := postBody["error"].(string)
			if !strings.Contains(postErr, "房间数据") {
				t.Fatalf("创建 error 应明确说明房间数据读取或解析失败，实际: %q", postErr)
			}
			if tc.needArr && !strings.Contains(postErr, "数组") {
				t.Fatalf("顶层 null 时创建 error 应明确说明房间数据必须是数组，实际: %q", postErr)
			}
			if strings.Contains(postErr, "缺少必填字段") || strings.Contains(postErr, "不能为空") {
				t.Fatalf("损坏数据的错误不应归为用户输入问题，实际: %q", postErr)
			}
			if _, ok := postBody["id"]; ok {
				t.Fatalf("损坏数据下不能返回新房间编号，实际: %v", postBody)
			}
			// 原损坏数据逐字节保留：未被清空、替换为 [] 或追加新记录。
			assertFileByteStable(t, dataDir, corrupt, "损坏数据下创建")

			restarted.stopGracefully(t)
			if got := readDataFile(t, dataDir); !bytes.Equal(got, corrupt) {
				t.Fatalf("再次停止后损坏数据被改动：\n得到: %s", got)
			}
		})
	}
}

// 真正的空数组表示没有房间：空数据目录首次启动又正常停止后，文件为 []，
// 用同一目录重启，查询成功且列表为空（启动与查询都不改写文件），
// 随后创建的第一条记录可以被查询到，且与创建响应一致。
func TestEmptyArrayAcrossRestartThenCreateFirst(t *testing.T) {
	dataDir := t.TempDir()

	// 首次启动后不创建任何房间，正常停止。
	first := startManagedServer(t, dataDir)
	first.stopGracefully(t)

	emptyFile := readDataFile(t, dataDir)
	if got := decodeRecords(t, emptyFile); len(got) != 0 {
		t.Fatalf("首次停止后应为空数组，实际: %s", emptyFile)
	}

	restarted := startManagedServer(t, dataDir)
	assertFileByteStable(t, dataDir, emptyFile, "空数组重新启动")

	status, rooms := getRooms(t, restarted.baseURL)
	if status != http.StatusOK {
		t.Fatalf("空数组重启后查询状态码 = %d，期望 200", status)
	}
	if len(rooms) != 0 {
		t.Fatalf("空数组重启后列表数量 = %d，期望 0", len(rooms))
	}
	assertFileByteStable(t, dataDir, emptyFile, "空数组查询列表")

	// 随后创建第一条记录，可以被查询到。
	createStatus, created := postRoom(t, restarted.baseURL, `{"name":"重启后的第一间","game":"gomoku","capacity":2,"turnSeconds":0}`)
	if createStatus != http.StatusCreated {
		t.Fatalf("空数组重启后创建状态码 = %d，期望 201，响应: %v", createStatus, created)
	}
	if id, _ := created["id"].(string); id == "" {
		t.Fatal("第一条房间编号为空")
	}
	listStatus, list := getRooms(t, restarted.baseURL)
	if listStatus != http.StatusOK || len(list) != 1 {
		t.Fatalf("创建后列表状态码 = %d、数量 = %d，期望 200/1", listStatus, len(list))
	}
	if !reflect.DeepEqual(list[0], created) {
		t.Fatalf("查询到的第一条记录与创建响应不一致：\n列表: %v\n响应: %v", list[0], created)
	}

	restarted.stopGracefully(t)
}
