package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// existingRoomsJSON 是两条带有附带字段的历史记录，用于验证创建、校验失败
// 和保存失败时原有数据（内容、附带字段与顺序）都不会被改动。
const existingRoomsJSON = `[
  {"id":"room-old-1","name":"棋友 交流 群","game":"ludo","capacity":4,"turnSeconds":30,"status":"playing","visibility":"public","createdAt":"2026-01-01T10:00:00Z","note":"历史备注","extra":{"rank":3}},
  {"id":"room-old-2","name":"深夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,"status":"waiting","visibility":"public","createdAt":"2026-01-02T12:00:00Z","archived":false}
]
`

// newTestHandler 在临时目录写入初始房间数据，并返回与 run 一致的路由和存储。
func newTestHandler(t *testing.T, initial string) (http.Handler, *roomStore, string) {
	t.Helper()
	dir := t.TempDir()
	dataFile := filepath.Join(dir, "rooms.json")
	if err := os.WriteFile(dataFile, []byte(initial), 0o600); err != nil {
		t.Fatalf("写入初始房间数据失败: %v", err)
	}
	store := newRoomStore(dataFile)
	return newHandler(store), store, dataFile
}

func serveRequest(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是合法 JSON 对象: %v，内容: %s", err, rec.Body.String())
	}
	return payload
}

// listRooms 通过 GET /api/rooms 查询房间列表。
func listRooms(t *testing.T, h http.Handler) []map[string]any {
	t.Helper()
	rec := serveRequest(t, h, http.MethodGet, "/api/rooms", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200，响应: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		Rooms []map[string]any `json:"rooms"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("房间列表不是合法 JSON: %v，内容: %s", err, rec.Body.String())
	}
	return payload.Rooms
}

// existingRecords 返回历史记录解码后的形式，用于与查询结果逐条比较。
func existingRecords(t *testing.T) []any {
	t.Helper()
	var records []any
	if err := json.Unmarshal([]byte(existingRoomsJSON), &records); err != nil {
		t.Fatalf("历史记录样例不是合法 JSON: %v", err)
	}
	return records
}

// assertExistingRoomsIntact 校验列表前缀与历史记录完全一致（内容、附带字段、顺序）。
func assertExistingRoomsIntact(t *testing.T, rooms []map[string]any) {
	t.Helper()
	original := existingRecords(t)
	if len(rooms) < len(original) {
		t.Fatalf("房间数量 = %d，少于原有 %d 条，原有记录丢失", len(rooms), len(original))
	}
	for i, want := range original {
		if !reflect.DeepEqual(rooms[i], want) {
			t.Errorf("第 %d 条原有记录被改动:\n  期望: %v\n  实际: %v", i, want, rooms[i])
		}
	}
}

// assertValidCreatedRoom 校验一条成功创建的房间记录，返回其编号。
func assertValidCreatedRoom(t *testing.T, got map[string]any, wantName string) string {
	t.Helper()
	id, ok := got["id"].(string)
	if !ok || id == "" {
		t.Fatalf("新房间编号为空或缺失: %v", got["id"])
	}
	for _, existing := range []string{"room-old-1", "room-old-2"} {
		if id == existing {
			t.Fatalf("新房间编号 %q 与已有编号重复", id)
		}
	}
	if got["name"] != wantName {
		t.Errorf("名称 = %q，期望 %q（仅去掉首尾空白，内部空格保留）", got["name"], wantName)
	}
	if got["game"] != "gomoku" {
		t.Errorf("game = %v，期望 gomoku", got["game"])
	}
	if got["capacity"] != float64(2) {
		t.Errorf("capacity = %v，期望 2", got["capacity"])
	}
	if got["turnSeconds"] != float64(0) {
		t.Errorf("turnSeconds = %v，期望 0（不限时）", got["turnSeconds"])
	}
	if got["status"] != "waiting" {
		t.Errorf("status = %v，期望 waiting", got["status"])
	}
	if got["visibility"] != "public" {
		t.Errorf("visibility = %v，期望 public", got["visibility"])
	}
	createdAt, ok := got["createdAt"].(string)
	if !ok {
		t.Fatalf("createdAt 缺失或不是字符串: %v", got["createdAt"])
	}
	stamp, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		t.Fatalf("createdAt %q 不是有效的 RFC3339 时间: %v", createdAt, err)
	}
	if since := time.Since(stamp); since < -time.Minute || since > time.Minute {
		t.Errorf("createdAt %q 与当前时间相差 %v，不像是本次创建时刻", createdAt, since)
	}
	return id
}

// 已有房间时，合法创建应返回 201，新房间追加到末尾，原有记录及其附带字段保持不变。
func TestCreateRoomAppendsToExistingRooms(t *testing.T) {
	handler, _, dataFile := newTestHandler(t, existingRoomsJSON)

	if rooms := listRooms(t, handler); len(rooms) != 2 {
		t.Fatalf("创建前房间数量 = %d，期望 2", len(rooms))
	}

	before := time.Now()
	rec := serveRequest(t, handler, http.MethodPost, "/api/rooms",
		`{"name":"  晚间 五子棋 对战  ","game":"gomoku","capacity":2,"turnSeconds":0}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /api/rooms 状态码 = %d，期望 201，响应: %s", rec.Code, rec.Body.String())
	}
	created := decodeBody(t, rec)
	newID := assertValidCreatedRoom(t, created, "晚间 五子棋 对战")
	if stamp, _ := time.Parse(time.RFC3339, created["createdAt"].(string)); stamp.Before(before.Add(-time.Second)) {
		t.Errorf("createdAt %v 早于请求发起时间 %v", stamp, before)
	}

	// 列表中应看到同一条新记录，且追加在原有记录之后。
	rooms := listRooms(t, handler)
	if len(rooms) != 3 {
		t.Fatalf("创建后房间数量 = %d，期望 3", len(rooms))
	}
	assertExistingRoomsIntact(t, rooms)
	if !reflect.DeepEqual(rooms[2], created) {
		t.Errorf("列表中的新记录与创建响应不一致:\n  响应: %v\n  列表: %v", created, rooms[2])
	}
	if rooms[2]["id"] != newID {
		t.Errorf("列表中新记录编号 = %v，期望 %v", rooms[2]["id"], newID)
	}

	// 数据文件同样应包含原有记录与新记录。
	raw, err := os.ReadFile(dataFile)
	if err != nil {
		t.Fatalf("读取数据文件失败: %v", err)
	}
	var saved []map[string]any
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatalf("数据文件不是合法 JSON: %v", err)
	}
	if len(saved) != 3 {
		t.Fatalf("数据文件中记录数 = %d，期望 3", len(saved))
	}
	original := existingRecords(t)
	for i := range original {
		if !reflect.DeepEqual(saved[i], original[i]) {
			t.Errorf("数据文件中第 %d 条原有记录被改动:\n  期望: %v\n  实际: %v", i, original[i], saved[i])
		}
	}
	if saved[2]["id"] != newID || saved[2]["turnSeconds"] != float64(0) {
		t.Errorf("数据文件中新记录不符合预期: %v", saved[2])
	}
}

// 没有历史记录时，同样应能成功创建并查询到第一条房间。
func TestCreateRoomSucceedsWithEmptyHistory(t *testing.T) {
	handler, _, _ := newTestHandler(t, "[]\n")

	if rooms := listRooms(t, handler); len(rooms) != 0 {
		t.Fatalf("创建前房间数量 = %d，期望 0", len(rooms))
	}

	rec := serveRequest(t, handler, http.MethodPost, "/api/rooms",
		`{"name":"  第一间 五子棋房  ","game":"gomoku","capacity":2,"turnSeconds":0}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /api/rooms 状态码 = %d，期望 201，响应: %s", rec.Code, rec.Body.String())
	}
	created := decodeBody(t, rec)
	assertValidCreatedRoom(t, created, "第一间 五子棋房")

	rooms := listRooms(t, handler)
	if len(rooms) != 1 {
		t.Fatalf("创建后房间数量 = %d，期望 1", len(rooms))
	}
	if !reflect.DeepEqual(rooms[0], created) {
		t.Errorf("列表中的首条记录与创建响应不一致:\n  响应: %v\n  列表: %v", created, rooms[0])
	}
}

// 缺少 turnSeconds 应返回 400 并说明原因，不能当成不限时，也不能改动原有记录。
func TestCreateRoomMissingTurnSecondsRejected(t *testing.T) {
	handler, _, dataFile := newTestHandler(t, existingRoomsJSON)
	before, err := os.ReadFile(dataFile)
	if err != nil {
		t.Fatalf("读取数据文件失败: %v", err)
	}

	rec := serveRequest(t, handler, http.MethodPost, "/api/rooms",
		`{"name":"新房间","game":"gomoku","capacity":2}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST /api/rooms 状态码 = %d，期望 400，响应: %s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	msg, _ := resp["error"].(string)
	if !strings.Contains(msg, "turnSeconds") || !strings.Contains(msg, "缺少") {
		t.Errorf("error %q 未说明缺少 turnSeconds", msg)
	}

	assertNoRoomAdded(t, handler, dataFile, before)
}

// turnSeconds 为小数应返回 400 并说明原因，不能被取整后保存。
func TestCreateRoomDecimalTurnSecondsRejected(t *testing.T) {
	handler, _, dataFile := newTestHandler(t, existingRoomsJSON)
	before, err := os.ReadFile(dataFile)
	if err != nil {
		t.Fatalf("读取数据文件失败: %v", err)
	}

	rec := serveRequest(t, handler, http.MethodPost, "/api/rooms",
		`{"name":"新房间","game":"gomoku","capacity":2,"turnSeconds":30.5}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST /api/rooms 状态码 = %d，期望 400，响应: %s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	msg, _ := resp["error"].(string)
	if !strings.Contains(msg, "turnSeconds") || !strings.Contains(msg, "整数") {
		t.Errorf("error %q 未说明 turnSeconds 必须是整数", msg)
	}

	assertNoRoomAdded(t, handler, dataFile, before)
}

// assertNoRoomAdded 校验被拒绝的请求没有产生新房间，原有记录与数据文件均未改动。
func assertNoRoomAdded(t *testing.T, handler http.Handler, dataFile string, before []byte) {
	t.Helper()
	rooms := listRooms(t, handler)
	if len(rooms) != 2 {
		t.Fatalf("请求被拒绝后房间数量 = %d，期望仍为 2", len(rooms))
	}
	assertExistingRoomsIntact(t, rooms)
	for _, room := range rooms {
		if room["name"] == "新房间" {
			t.Errorf("被拒绝的请求产生了新房间: %v", room)
		}
	}
	after, err := os.ReadFile(dataFile)
	if err != nil {
		t.Fatalf("读取数据文件失败: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Errorf("数据文件被改动:\n  之前: %s\n  之后: %s", before, after)
	}
}

// 读取正常、配置合法但保存失败时，应返回 500 并说明保存失败，原有数据完整可读。
func TestCreateRoomSaveFailureKeepsExistingData(t *testing.T) {
	handler, store, dataFile := newTestHandler(t, existingRoomsJSON)
	before, err := os.ReadFile(dataFile)
	if err != nil {
		t.Fatalf("读取数据文件失败: %v", err)
	}
	if rooms := listRooms(t, handler); len(rooms) != 2 {
		t.Fatalf("创建前房间数量 = %d，期望 2（数据应能正常读取）", len(rooms))
	}

	store.save = func(records []json.RawMessage) error {
		return errors.New("保存房间数据失败: 模拟磁盘写入失败")
	}

	rec := serveRequest(t, handler, http.MethodPost, "/api/rooms",
		`{"name":"  晚间 五子棋 对战  ","game":"gomoku","capacity":2,"turnSeconds":0}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("POST /api/rooms 状态码 = %d，期望 500，响应: %s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	msg, _ := resp["error"].(string)
	if !strings.Contains(msg, "保存") {
		t.Errorf("error %q 未明确说明保存失败", msg)
	}
	if _, ok := resp["id"]; ok {
		t.Errorf("保存失败的响应不应包含成功房间: %v", resp)
	}

	// 原数据仍应完整可读：数量、内容、附带字段与创建前一致，不出现部分保存的新记录。
	rooms := listRooms(t, handler)
	if len(rooms) != 2 {
		t.Fatalf("保存失败后房间数量 = %d，期望仍为 2", len(rooms))
	}
	assertExistingRoomsIntact(t, rooms)
	after, err := os.ReadFile(dataFile)
	if err != nil {
		t.Fatalf("保存失败后数据文件不可读: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Errorf("保存失败后数据文件被改动:\n  之前: %s\n  之后: %s", before, after)
	}
}
