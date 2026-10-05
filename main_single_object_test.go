package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// 本文件回归 POST /api/rooms 的“每次提交只能包含一个完整的 JSON 对象”规则：
// 直接调用接口的请求不经过首页校验，服务端必须把整个请求体当作一份提交来判定——
// 即使内容里能找到合法的房间名称、游戏规则、人数和时间，也不能只取其中一部分
// 就创建房间。空内容、非对象顶层、截断的对象、完整对象之后还有内容，都必须整体
// 拒绝且不留下任何记录；只有单个完整对象（前后允许 JSON 空白）才能正常创建。
// 与 main_test.go 一样以子进程方式启动真实服务，通过公开接口验证响应与随后查询
// 的结果，不改动任何现有代码。

// assertRejectedNotSingleObject 断言一次创建请求因“不是单个 JSON 对象”被整体拒绝：
// 返回 400，error 说明请求体必须是单个 JSON 对象；这是请求内容不符合约定，
// 不能被说成房间数据读取失败；不返回新房间编号。
func assertRejectedNotSingleObject(t *testing.T, baseURL, desc, body string) {
	t.Helper()
	status, resp := postRoom(t, baseURL, body)
	if status != http.StatusBadRequest {
		t.Fatalf("%s：状态码 = %d，期望 400，响应: %v", desc, status, resp)
	}
	errMsg, _ := resp["error"].(string)
	if !strings.Contains(errMsg, "单个 JSON 对象") {
		t.Fatalf("%s：error 应说明请求体必须是单个 JSON 对象，实际: %q", desc, errMsg)
	}
	if strings.Contains(errMsg, "房间数据") {
		t.Fatalf("%s：请求内容不符合约定不应被说成房间数据读取失败，实际: %q", desc, errMsg)
	}
	if _, ok := resp["id"]; ok {
		t.Fatalf("%s：被拒绝的请求不应返回新房间编号，实际: %v", desc, resp)
	}
}

// 空内容、非对象顶层、截断对象以及完整对象前后混有其他内容时，整个请求都必须
// 被拒绝：返回 400 且 error 指向“单个 JSON 对象”约定，不返回新房间编号；
// 已有房间的数量、次序、配置与附带字段不变，本地文件逐字节保留。
// 把请求修正为单个合法对象后应正常创建，列表仅在原有记录之后追加这一条，
// 被拒绝的请求不占据任何房间记录。
func TestCreateRoomRequiresSingleCompleteJSONObject(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	valid := `{"name":"完整配置房","game":"gomoku","capacity":2,"turnSeconds":30}`

	cases := []struct {
		desc string
		body string
	}{
		{"请求体为空", ""},
		{"请求体只有空白", "  \t\r\n  "},
		{"请求体不是合法 JSON", "{not json"},
		{"顶层为 null", "null"},
		{"顶层为字符串", `"直接给名称"`},
		{"顶层为数字", "42"},
		{"顶层为布尔值", "true"},
		{"顶层为空数组", "[]"},
		// 数组里即使只装一个完整且配置合法的房间对象，也不是一次正常创建。
		{"顶层数组只装一个完整合法的房间对象", `[{"name":"数组中的房间","game":"ludo","capacity":3,"turnSeconds":60}]`},
		// 对象尚未结束就中断：不能留下半条记录。
		{"对象尚未结束就中断", `{"name":"截断房","game":"gomoku","capacity":2,"turnSe`},
		// 完整对象之后还有内容：整个请求拒绝，不能先保存前面的房间再报告失败。
		{"合法对象后接第二个对象", valid + `{"name":"第二份配置","game":"ludo","capacity":4,"turnSeconds":0}`},
		{"合法对象后接其他 JSON 值", valid + " 123"},
		{"合法对象后接 null", valid + "\nnull"},
		{"合法对象后接非空白字符", valid + "}"},
		{"合法对象前有其他内容", "null " + valid},
	}

	for _, tc := range cases {
		assertRejectedNotSingleObject(t, baseURL, tc.desc, tc.body)
		// 每次拒绝后：已有房间数量、次序、配置与附带字段不变，本地文件未被改写。
		assertRoomsUnchanged(t, baseURL, dataDir, seed)
	}

	// 把请求修正为单个合法对象后，应收到 201 和新房间。
	status, created := postRoom(t, baseURL, valid)
	if status != http.StatusCreated {
		t.Fatalf("修正后创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	if id, _ := created["id"].(string); id == "" {
		t.Fatal("修正后创建的新房间编号为空")
	}
	if got := created["name"]; got != "完整配置房" {
		t.Fatalf("修正后保存的名称 = %v，期望 %q", got, "完整配置房")
	}

	// 列表仅在原有记录之后增加这次成功创建的记录，其内容与创建响应一致；
	// 之前被拒绝的请求不占据任何房间记录。
	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if len(rooms) != 3 {
		t.Fatalf("房间数量 = %d，期望 3（种子 2 条 + 修正后 1 条，被拒请求不得留记录）", len(rooms))
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
}

// 单个合法对象前后只有 JSON 允许的空白（空格、制表符、换行）时仍应正常创建，
// 不能因为有空白就误判为多份内容。
func TestCreateRoomAcceptsJSONWhitespaceAroundObject(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1)
	baseURL := startServer(t, dataDir)

	body := " \t\r\n{\"name\":\"空白环绕房\",\"game\":\"ludo\",\"capacity\":3,\"turnSeconds\":45}\n\t \r\n"
	status, created := postRoom(t, baseURL, body)
	if status != http.StatusCreated {
		t.Fatalf("创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	if id, _ := created["id"].(string); id == "" {
		t.Fatal("新房间编号为空")
	}
	if got := created["name"]; got != "空白环绕房" {
		t.Fatalf("名称 = %v，期望 %q", got, "空白环绕房")
	}
	if got := created["game"]; got != "ludo" {
		t.Fatalf("规则 = %v，期望 ludo", got)
	}
	if got := created["capacity"]; got != float64(3) {
		t.Fatalf("人数 = %v，期望 3", got)
	}
	if got := created["turnSeconds"]; got != float64(45) {
		t.Fatalf("每步时间 = %v，期望 45", got)
	}

	// 列表在原有记录之后追加这一条，与创建响应一致。
	_, rooms := getRooms(t, baseURL)
	if len(rooms) != 2 {
		t.Fatalf("房间数量 = %d，期望 2（种子 1 条 + 新增 1 条）", len(rooms))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:1], want) {
		t.Fatalf("原有房间被改动：\n得到: %v\n期望: %v", rooms[:1], want)
	}
	if !reflect.DeepEqual(rooms[1], created) {
		t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[1], created)
	}
}

// 名称字符串内部的花括号、方括号以及按 JSON 规则转义后的引号都属于名称内容，
// 不能被误认为第二份配置或结构损坏；即使名称内容本身看起来像一份完整配置，
// 也仍按字符串保存。保存后的名称继续遵循已有的首尾空白整理规则。
func TestCreateRoomNameBracesAndEscapedQuotesAreContent(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		desc     string
		rawName  string
		wantName string
	}{
		{"名称含花括号与方括号", "  花括号{房}与[方括号]  ", "花括号{房}与[方括号]"},
		{"名称含转义引号", `名称里的"引号"`, `名称里的"引号"`},
		{"名称内容像一份完整配置", `{"game":"ludo","capacity":4}`, `{"game":"ludo","capacity":4}`},
	}

	createdRooms := make([]map[string]any, 0, len(cases))
	for _, tc := range cases {
		body, _ := json.Marshal(map[string]any{
			"name": tc.rawName, "game": "gomoku", "capacity": 2, "turnSeconds": 0,
		})
		status, created := postRoom(t, baseURL, string(body))
		if status != http.StatusCreated {
			t.Fatalf("%s：创建状态码 = %d，期望 201，响应: %v", tc.desc, status, created)
		}
		if got := created["name"]; got != tc.wantName {
			t.Fatalf("%s：保存的名称 = %q，期望 %q（仍按现有方式去掉首尾空白，内部内容不动）", tc.desc, got, tc.wantName)
		}
		createdRooms = append(createdRooms, created)
	}

	// 列表在原有 2 条之后按创建次序追加，每条与创建响应一致；
	// 名称里的括号与引号没有被当成第二份配置或结构损坏。
	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if len(rooms) != 2+len(cases) {
		t.Fatalf("房间数量 = %d，期望 %d（原有 2 条 + 新增 %d 条）", len(rooms), 2+len(cases), len(cases))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间被改动：\n得到: %v\n期望: %v", rooms[:2], want)
	}
	for i, created := range createdRooms {
		if !reflect.DeepEqual(rooms[2+i], created) {
			t.Fatalf("列表第 %d 条新记录与创建响应不一致：\n列表: %v\n响应: %v", i+1, rooms[2+i], created)
		}
	}

	// 本地保存记录与列表一致，名称内容原样落盘。
	saved := decodeRecords(t, readDataFile(t, dataDir))
	if !reflect.DeepEqual(saved, rooms) {
		t.Fatalf("本地保存记录与房间列表不一致：\n文件: %v\n列表: %v", saved, rooms)
	}
}
