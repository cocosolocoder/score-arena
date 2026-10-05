package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// 本文件聚焦“每步时间限制（turnSeconds）”在服务端的接收与保存：
// 首页会在提交前检查时间，但使用者也可以直接向 POST /api/rooms 发送请求，
// 因此这里通过公开接口验证服务端只按明确提交的合法整数秒创建房间——
// 不把漏填、类型错误或越界的值补成默认时间，也不把小数或科学计数法转换成合法值。
// 所有用例的名称、游戏规则和人数均合法，失败原因必须明确落在时间配置上。

// 合法时间（0 表示不限时，其余为 10 至 600 的整数，含两个端点与区间内整数）
// 应按提交值创建并保存：创建响应、房间列表与本地文件三处的秒数一致；
// 0 必须作为明确的配置保存（字段存在且为 0），不能被当成没填；
// 名称、规则和人数不因时间处理而改变。五子棋与飞行棋遵循同一时间规则。
func TestCreateRoomAcceptsValidTurnSeconds(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		name     string
		game     string
		capacity int
		turn     int
	}{
		{"不限时五子棋", "gomoku", 2, 0},
		{"端点十秒五子棋", "gomoku", 2, 10},
		{"端点六百秒五子棋", "gomoku", 2, 600},
		{"区间内五子棋", "gomoku", 2, 45},
		{"不限时飞行棋", "ludo", 2, 0},
		{"端点十秒飞行棋", "ludo", 3, 10},
		{"端点六百秒飞行棋", "ludo", 4, 600},
		{"区间内飞行棋", "ludo", 3, 599},
	}

	createdRooms := make([]map[string]any, 0, len(cases))
	for _, tc := range cases {
		// 名称带首尾空白以确认整理逻辑不受时间处理影响；时间以整数字面量写入请求体。
		body := fmt.Sprintf(`{"name":"  %s  ","game":%q,"capacity":%d,"turnSeconds":%d}`,
			tc.name, tc.game, tc.capacity, tc.turn)
		status, created := postRoom(t, baseURL, body)
		if status != http.StatusCreated {
			t.Fatalf("%s（%d 秒）创建状态码 = %d，期望 201，响应: %v", tc.name, tc.turn, status, created)
		}
		if id, _ := created["id"].(string); id == "" {
			t.Fatalf("%s（%d 秒）的新房间编号为空", tc.name, tc.turn)
		}
		if got := created["turnSeconds"]; got != float64(tc.turn) {
			t.Fatalf("%s：创建响应的每步时间 = %v，期望 %d（按提交值保存）", tc.name, got, tc.turn)
		}
		if got := created["name"]; got != tc.name {
			t.Fatalf("%s：名称 = %v，期望 %q（时间处理不得改变名称）", tc.name, got, tc.name)
		}
		if got := created["game"]; got != tc.game {
			t.Fatalf("%s：规则 = %v，期望 %q（时间处理不得改变规则）", tc.name, got, tc.game)
		}
		if got := created["capacity"]; got != float64(tc.capacity) {
			t.Fatalf("%s：人数 = %v，期望 %d（时间处理不得改变人数）", tc.name, got, tc.capacity)
		}
		if got := created["status"]; got != "waiting" {
			t.Fatalf("%s：状态 = %v，期望 waiting", tc.name, got)
		}
		if got := created["visibility"]; got != "public" {
			t.Fatalf("%s：公开范围 = %v，期望 public", tc.name, got)
		}
		createdRooms = append(createdRooms, created)
	}

	// 房间列表：原有 2 条种子记录不变，新房间按创建次序追加，
	// 每条的秒数与对应创建响应一致。
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

	// 本地保存记录：逐条与创建响应一致，且 turnSeconds 字段明确存在——
	// 0 必须作为明确的配置保存，不能被当成没填而省略字段。
	var fileRecords []map[string]any
	if err := json.Unmarshal(readDataFile(t, dataDir), &fileRecords); err != nil {
		t.Fatalf("本地数据文件不是合法 JSON: %v", err)
	}
	if len(fileRecords) != 2+len(cases) {
		t.Fatalf("本地记录数量 = %d，期望 %d", len(fileRecords), 2+len(cases))
	}
	for i, tc := range cases {
		saved := fileRecords[2+i]
		raw, ok := saved["turnSeconds"]
		if !ok {
			t.Fatalf("%s：本地记录缺少 turnSeconds 字段（0 也必须明确保存）", tc.name)
		}
		if raw != float64(tc.turn) {
			t.Fatalf("%s：本地保存的每步时间 = %v，期望 %d（与创建响应、房间列表一致）", tc.name, raw, tc.turn)
		}
		if saved["id"] != createdRooms[i]["id"] {
			t.Fatalf("%s：本地记录与创建响应不是同一房间：\n本地: %v\n响应: %v", tc.name, saved, createdRooms[i])
		}
	}
}

// 未提供时间字段、或以 null/字符串/布尔值/对象/数组提供、或以小数与科学计数法
// 提供时，都必须返回 400 且不产生任何记录：缺失报“缺少 turnSeconds”，
// 类型不符报“必须是整数”而不是缺少字段；30.0、3e1 这类数值上恰好为整数的
// 写法同样按非整数拒绝，不能取整或转换后创建。请求中其余字段均合法，
// 错误原因必须落在时间配置上，不能归为服务内部故障。
func TestCreateRoomRejectsMissingOrNonIntegerTurnSeconds(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		desc        string
		body        string
		wantErrPart []string // error 必须同时包含的片段
		notErrPart  []string // error 不得包含的片段（区分缺失与类型错误）
	}{
		{"未提供时间字段", `{"name":"缺时间房","game":"gomoku","capacity":2}`,
			[]string{"缺少", "turnSeconds"}, []string{"整数"}},
		{"时间为 null", `{"name":"null时间房","game":"gomoku","capacity":2,"turnSeconds":null}`,
			[]string{"turnSeconds", "整数"}, []string{"缺少"}},
		{"时间为字符串", `{"name":"字符串时间房","game":"gomoku","capacity":2,"turnSeconds":"30"}`,
			[]string{"turnSeconds", "整数"}, []string{"缺少"}},
		{"时间为布尔值", `{"name":"布尔时间房","game":"gomoku","capacity":2,"turnSeconds":true}`,
			[]string{"turnSeconds", "整数"}, []string{"缺少"}},
		{"时间为对象", `{"name":"对象时间房","game":"gomoku","capacity":2,"turnSeconds":{"seconds":30}}`,
			[]string{"turnSeconds", "整数"}, []string{"缺少"}},
		{"时间为数组", `{"name":"数组时间房","game":"gomoku","capacity":2,"turnSeconds":[30]}`,
			[]string{"turnSeconds", "整数"}, []string{"缺少"}},
		{"时间为带小数点的整数值 30.0", `{"name":"小数点时间房","game":"gomoku","capacity":2,"turnSeconds":30.0}`,
			[]string{"turnSeconds", "整数"}, []string{"缺少"}},
		{"时间为科学计数法 3e1", `{"name":"科学计数法时间房","game":"gomoku","capacity":2,"turnSeconds":3e1}`,
			[]string{"turnSeconds", "整数"}, []string{"缺少"}},
		{"时间为普通小数", `{"name":"普通小数时间房","game":"ludo","capacity":3,"turnSeconds":30.5}`,
			[]string{"turnSeconds", "整数"}, []string{"缺少"}},
	}

	for _, tc := range cases {
		status, rejected := postRoom(t, baseURL, tc.body)
		if status != http.StatusBadRequest {
			t.Fatalf("%s：状态码 = %d，期望 400（不得返回成功房间或服务内部故障），响应: %v", tc.desc, status, rejected)
		}
		errMsg, _ := rejected["error"].(string)
		for _, part := range tc.wantErrPart {
			if !strings.Contains(errMsg, part) {
				t.Fatalf("%s：error 应包含 %q，实际: %q", tc.desc, part, errMsg)
			}
		}
		for _, part := range tc.notErrPart {
			if strings.Contains(errMsg, part) {
				t.Fatalf("%s：error 不应包含 %q（缺失与类型错误必须区分），实际: %q", tc.desc, part, errMsg)
			}
		}
		// 名称、规则和人数均合法，错误原因只能落在时间配置上。
		if strings.Contains(errMsg, "名称") || strings.Contains(errMsg, "capacity") || strings.Contains(errMsg, "人数") {
			t.Fatalf("%s：名称、规则与人数均合法，error 不应落在无关字段上，实际: %q", tc.desc, errMsg)
		}
		if _, ok := rejected["id"]; ok {
			t.Fatalf("%s：被拒绝的请求不应返回房间编号，实际: %v", tc.desc, rejected)
		}
	}

	// 全部拒绝后：已有房间的数量、次序、内容及附带字段保持不变，本地文件未被改写。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)

	// 本地文件中不得留下任何曾被拒绝的时间值（如 30.5 或被转换后的 30）。
	for _, record := range decodeRecords(t, readDataFile(t, dataDir)) {
		room, ok := record.(map[string]any)
		if !ok {
			continue
		}
		name, _ := room["name"].(string)
		for _, bad := range []string{"缺时间房", "null时间房", "字符串时间房", "布尔时间房", "对象时间房", "数组时间房", "小数点时间房", "科学计数法时间房", "普通小数时间房"} {
			if name == bad {
				t.Fatalf("本地文件中出现曾被拒绝的房间 %q，说明拒绝时留下了记录", bad)
			}
		}
	}
}

// 整数 -1、1、9 和 601 属于范围错误：返回 400，提示应说明 0（不限时）或
// 10 至 600 秒的允许范围；不能返回成功房间，也不能归为服务内部故障。
// 五子棋与飞行棋遵循同一时间规则。全部拒绝后已有数据保持不变。
func TestCreateRoomRejectsOutOfRangeTurnSeconds(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		game     string
		capacity int
		turn     int
	}{
		{"gomoku", 2, -1},
		{"gomoku", 2, 1},
		{"gomoku", 2, 9},
		{"gomoku", 2, 601},
		{"ludo", 3, -1},
		{"ludo", 4, 1},
		{"ludo", 2, 9},
		{"ludo", 3, 601},
	}

	for _, tc := range cases {
		body := fmt.Sprintf(`{"name":"越界时间房","game":%q,"capacity":%d,"turnSeconds":%d}`,
			tc.game, tc.capacity, tc.turn)
		status, rejected := postRoom(t, baseURL, body)
		if status != http.StatusBadRequest {
			t.Fatalf("%s %d 秒：状态码 = %d，期望 400（不得返回成功房间或服务内部故障），响应: %v",
				tc.game, tc.turn, status, rejected)
		}
		errMsg, _ := rejected["error"].(string)
		// 提示应说明允许范围：0（不限时）或 10 至 600 秒。
		for _, part := range []string{"0", "10", "600"} {
			if !strings.Contains(errMsg, part) {
				t.Fatalf("%s %d 秒：error 应包含 %q 以说明允许范围（0 或 10 至 600 秒），实际: %q",
					tc.game, tc.turn, part, errMsg)
			}
		}
		if strings.Contains(errMsg, "缺少") {
			t.Fatalf("%s %d 秒：时间已明确提交，error 不应报缺少字段，实际: %q", tc.game, tc.turn, errMsg)
		}
		if strings.Contains(errMsg, "名称") || strings.Contains(errMsg, "capacity") || strings.Contains(errMsg, "人数") {
			t.Fatalf("%s %d 秒：名称、规则与人数均合法，error 不应落在无关字段上，实际: %q", tc.game, tc.turn, errMsg)
		}
		if _, ok := rejected["id"]; ok {
			t.Fatalf("%s %d 秒：被拒绝的请求不应返回房间编号，实际: %v", tc.game, tc.turn, rejected)
		}
	}

	// 全部拒绝后：已有房间的数量、次序、内容及附带字段保持不变，本地文件未被改写。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// 看到时间错误后只把时间改为合法整数、保留其余配置再提交，应正常创建：
// 新房间按修正后的秒数追加在原有记录之后，先前被拒的时间不留下任何记录，
// 名称、规则和人数沿用修正前的配置。
func TestCreateRoomAfterTurnSecondsRejectionRetry(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	// 先提交一个时间越界的请求，其余配置均合法。
	badBody := `{"name":"  修正时间房  ","game":"ludo","capacity":3,"turnSeconds":601}`
	status, rejected := postRoom(t, baseURL, badBody)
	if status != http.StatusBadRequest {
		t.Fatalf("越界时间状态码 = %d，期望 400，响应: %v", status, rejected)
	}
	if _, ok := rejected["id"]; ok {
		t.Fatalf("被拒绝的请求不应返回房间编号，实际: %v", rejected)
	}
	assertRoomsUnchanged(t, baseURL, dataDir, seed)

	// 只把时间改为合法整数，其余配置原样保留，再次提交。
	status, created := postRoom(t, baseURL, `{"name":"  修正时间房  ","game":"ludo","capacity":3,"turnSeconds":60}`)
	if status != http.StatusCreated {
		t.Fatalf("修正后创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	if got := created["turnSeconds"]; got != float64(60) {
		t.Fatalf("修正后保存的每步时间 = %v，期望 60", got)
	}
	if got := created["name"]; got != "修正时间房" {
		t.Fatalf("修正后名称 = %v，期望 %q（其余配置沿用）", got, "修正时间房")
	}
	if got := created["game"]; got != "ludo" {
		t.Fatalf("修正后规则 = %v，期望 ludo（其余配置沿用）", got)
	}
	if got := created["capacity"]; got != float64(3) {
		t.Fatalf("修正后人数 = %v，期望 3（其余配置沿用）", got)
	}

	// 新房间按修正后的秒数追加在原有记录之后；列表与本地文件一致。
	_, rooms := getRooms(t, baseURL)
	if len(rooms) != 3 {
		t.Fatalf("房间数量 = %d，期望 3（种子 2 条 + 修正后 1 条，被拒的 601 秒不得留记录）", len(rooms))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间被改动：\n得到: %v\n期望: %v", rooms[:2], want)
	}
	if !reflect.DeepEqual(rooms[2], created) {
		t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[2], created)
	}

	var fileRecords []map[string]any
	if err := json.Unmarshal(readDataFile(t, dataDir), &fileRecords); err != nil {
		t.Fatalf("本地数据文件不是合法 JSON: %v", err)
	}
	if len(fileRecords) != 3 {
		t.Fatalf("本地记录数量 = %d，期望 3（被拒的 601 秒不得留记录）", len(fileRecords))
	}
	last := fileRecords[2]
	if got := last["turnSeconds"]; got != float64(60) {
		t.Fatalf("本地保存的每步时间 = %v，期望 60（与创建响应、房间列表一致）", got)
	}
	for _, record := range fileRecords {
		if record["turnSeconds"] == float64(601) {
			t.Fatalf("本地文件中出现曾被拒绝的 601 秒记录: %v", record)
		}
	}
}
