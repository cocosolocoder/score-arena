package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// 本文件回归“多个用户在同一服务上同时提交创建请求”时的保存行为：
// 每份得到成功响应的合法提交都必须成为一个独立房间——已确认成功的房间不能被
// 其他同时提交的房间覆盖或挤掉，不能只留下最后完成的那一份。并行批次中既有
// 五子棋也有飞行棋，人数与每步时间按各自合法配置填写（含不限时 0 与有限时），
// 并混入一份规则与人数不匹配的无效提交（五子棋填四人），它必须仍返回 400、
// 不占保存记录，且不影响其他合法提交正常完成。
//
// 全部请求处理完成后：房间列表与本地保存内容都包含全部成功创建的房间，
// 每个返回编号恰好对应一条新记录且与创建响应一致；已有记录（含备注、数组、
// 嵌套附带字段，以及缺字段对象和非对象记录）原值、原相对次序保留在前，
// 新房间全部追加在后（并行新房间之间的排列不要求按提交或响应先后排序）。
// 与 main_test.go 一样以子进程方式运行真实服务，公开接口与校验规则保持原样。

// concurrentSeedRecords 构造并行创建前的已有数据：完整对象（带备注、数组、
// 嵌套附带字段）、缺字段对象以及非对象记录，用于验证并行创建后它们不被
// 补齐、清理、展开或重排。
var concurrentSeedRecords = []string{
	`{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"],"extra":{"rank":3,"meta":{"keep":true}}}`,
	`{"id":"legacy-incomplete","name":"缺少表单字段的老房间"}`,
	`null`,
	`"误入的字符串"`,
	`0`,
	`false`,
	`[{"id":"inside-array"}]`,
}

// concurrentValidCase 描述并行批次中一份合法提交及其期望保存结果。
type concurrentValidCase struct {
	rawName  string // 提交时的名称（含首尾空白、内部空格与表情）
	wantName string // 期望保存的名称（仅去掉首尾空白）
	game     string
	capacity int
	turn     int
}

// concurrentResult 收集一次并行提交的响应。
type concurrentResult struct {
	status int
	body   map[string]any
}

// 多个用户同时提交合法配置：每份成功响应都成为一个独立房间。
func TestConcurrentCreateRoomsAllPersisted(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, concurrentSeedRecords...)
	baseURL := startServer(t, dataDir)

	// 并行批次的合法提交：五子棋与飞行棋混合，人数按各自规则，时间含
	// 不限时 0 与有限时整数秒；其中两份名称相同，必须各自创建、不得按名称合并。
	validCases := []concurrentValidCase{
		{"  深夜 😀 五子棋 对局  ", "深夜 😀 五子棋 对局", "gomoku", 2, 0},
		{" 周末 飞行棋 大赛 ", "周末 飞行棋 大赛", "ludo", 4, 45},
		{"双人飞行棋快棋", "双人飞行棋快棋", "ludo", 2, 600},
		{"三人飞行棋热身", "三人飞行棋热身", "ludo", 3, 10},
		{"同名 棋室", "同名 棋室", "gomoku", 2, 30},
		{" 同名 棋室 ", "同名 棋室", "gomoku", 2, 0},
		{"  四人 🎲 飞行棋 不限时  ", "四人 🎲 飞行棋 不限时", "ludo", 4, 0},
		{"五子棋五百九十九秒", "五子棋五百九十九秒", "gomoku", 2, 599},
	}
	// 混入批次的无效提交：五子棋填四人，人数与规则不符。
	const invalidBody = `{"name":"四人五子棋无效房","game":"gomoku","capacity":4,"turnSeconds":30}`

	total := len(validCases) + 1
	results := make([]concurrentResult, total)

	// 所有请求尽量同时发出：先一起等在起点，再统一放行。
	var wg sync.WaitGroup
	start := make(chan struct{})
	post := func(idx int, body string) {
		defer wg.Done()
		<-start
		resp, err := httpClient.Post(baseURL+"/api/rooms", "application/json", strings.NewReader(body))
		if err != nil {
			results[idx] = concurrentResult{status: -1, body: map[string]any{"error": err.Error()}}
			return
		}
		defer resp.Body.Close()
		var decoded map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
			results[idx] = concurrentResult{status: -1, body: map[string]any{"error": "响应不是合法 JSON: " + err.Error()}}
			return
		}
		results[idx] = concurrentResult{status: resp.StatusCode, body: decoded}
	}
	for i, tc := range validCases {
		body, _ := json.Marshal(map[string]any{
			"name": tc.rawName, "game": tc.game,
			"capacity": tc.capacity, "turnSeconds": tc.turn,
		})
		wg.Add(1)
		go post(i, string(body))
	}
	wg.Add(1)
	go post(len(validCases), invalidBody)
	close(start)
	wg.Wait()

	// 逐份检查合法提交的响应：201、非空编号、自己提交的配置，
	// 规则/人数/时间不能串到另一份响应中，状态与公开范围固定。
	createdIDs := make(map[string]int, len(validCases)) // 编号 -> 提交序号
	for i, tc := range validCases {
		res := results[i]
		if res.status != http.StatusCreated {
			t.Fatalf("第 %d 份合法提交（%s %d 人 %d 秒）状态码 = %d，期望 201，响应: %v",
				i+1, tc.game, tc.capacity, tc.turn, res.status, res.body)
		}
		created := res.body
		id, _ := created["id"].(string)
		if id == "" {
			t.Fatalf("第 %d 份提交（%s）的新房间编号为空", i+1, tc.wantName)
		}
		if prev, dup := createdIDs[id]; dup {
			t.Fatalf("第 %d 份与第 %d 份提交得到相同编号 %q，并行创建不得复用编号", i+1, prev+1, id)
		}
		createdIDs[id] = i
		if got := created["name"]; got != tc.wantName {
			t.Fatalf("第 %d 份提交的名称 = %v，期望 %q（仅去首尾空白，内部空格与表情保留）", i+1, got, tc.wantName)
		}
		if got := created["game"]; got != tc.game {
			t.Fatalf("第 %d 份提交的规则 = %v，期望 %q（不得串用其他提交的配置）", i+1, got, tc.game)
		}
		if got := created["capacity"]; got != float64(tc.capacity) {
			t.Fatalf("第 %d 份提交的人数 = %v，期望 %d（不得串用其他提交的配置）", i+1, got, tc.capacity)
		}
		got, present := created["turnSeconds"]
		if !present {
			t.Fatalf("第 %d 份提交的响应缺少 turnSeconds 字段（0 也必须明确返回）", i+1)
		}
		if got != float64(tc.turn) {
			t.Fatalf("第 %d 份提交的每步时间 = %v，期望 %d（不得串用其他提交的配置）", i+1, got, tc.turn)
		}
		if got := created["status"]; got != "waiting" {
			t.Fatalf("第 %d 份提交的状态 = %v，期望 waiting（未开始）", i+1, got)
		}
		if got := created["visibility"]; got != "public" {
			t.Fatalf("第 %d 份提交的公开范围 = %v，期望 public", i+1, got)
		}
		createdAt, _ := created["createdAt"].(string)
		if _, err := time.Parse(time.RFC3339, createdAt); err != nil {
			t.Fatalf("第 %d 份提交的创建时间 %q 不是有效的 RFC3339 时间: %v", i+1, createdAt, err)
		}
	}

	// 新编号不得与已有房间编号冲突。
	for id := range createdIDs {
		for _, raw := range concurrentSeedRecords {
			var probe struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal([]byte(raw), &probe); err == nil && probe.ID == id {
				t.Fatalf("新房间编号 %q 与已有房间编号冲突", id)
			}
		}
	}

	// 同名两份提交必须各自创建：编号不同、都成功。
	sameNameIdx := []int{4, 5}
	var sameNameIDs []string
	for _, i := range sameNameIdx {
		id, _ := results[i].body["id"].(string)
		sameNameIDs = append(sameNameIDs, id)
	}
	if sameNameIDs[0] == sameNameIDs[1] {
		t.Fatalf("同名两份提交得到相同编号 %q，同名合法提交不得按名称合并", sameNameIDs[0])
	}

	// 混入的无效提交：400、error 明确说明人数与规则不符、不返回成功编号。
	invalidRes := results[len(validCases)]
	if invalidRes.status != http.StatusBadRequest {
		t.Fatalf("五子棋四人的无效提交状态码 = %d，期望 400，响应: %v", invalidRes.status, invalidRes.body)
	}
	errMsg, _ := invalidRes.body["error"].(string)
	if !strings.Contains(errMsg, "五子棋") || !strings.Contains(errMsg, "2") {
		t.Fatalf("无效提交的 error 应明确说明人数与规则不符（五子棋固定 2 人），实际: %q", errMsg)
	}
	if _, ok := invalidRes.body["id"]; ok {
		t.Fatalf("无效提交不应返回成功房间编号，实际: %v", invalidRes.body)
	}

	// 全部请求处理完成后：列表必须包含全部已有记录与全部成功创建的房间，
	// 最终增加的记录数只等于本批成功创建的数量（无效提交不占记录）。
	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	wantTotal := len(concurrentSeedRecords) + len(validCases)
	if len(rooms) != wantTotal {
		t.Fatalf("房间数量 = %d，期望 %d（已有 %d 条 + 成功创建 %d 条；不能只留下最后完成的提交，无效提交不占记录）",
			len(rooms), wantTotal, len(concurrentSeedRecords), len(validCases))
	}

	// 已有记录（含附带字段、缺字段对象与非对象记录）原值、原相对次序保留在前。
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:len(concurrentSeedRecords)], want) {
		t.Fatalf("已有记录被改动、补齐、清理或重排：\n得到: %v\n期望: %v", rooms[:len(concurrentSeedRecords)], want)
	}

	// 新房间全部追加在原记录之后：每个返回编号恰好对应一条新记录，
	// 且该记录与对应创建响应完全一致（新房间之间的排列不要求有序）。
	newRecords := rooms[len(concurrentSeedRecords):]
	seenIDs := make(map[string]bool, len(newRecords))
	for _, record := range newRecords {
		obj, ok := record.(map[string]any)
		if !ok {
			t.Fatalf("新记录不是对象: %v", record)
		}
		id, _ := obj["id"].(string)
		idx, known := createdIDs[id]
		if !known {
			t.Fatalf("列表中出现未返回过的新编号 %q（记录: %v）", id, record)
		}
		if seenIDs[id] {
			t.Fatalf("编号 %q 在列表中对应多条新记录，每个返回编号应恰好对应一条", id)
		}
		seenIDs[id] = true
		if !reflect.DeepEqual(obj, results[idx].body) {
			t.Fatalf("列表中的新记录与第 %d 份提交的创建响应不一致：\n列表: %v\n响应: %v", idx+1, obj, results[idx].body)
		}
	}
	for id, idx := range createdIDs {
		if !seenIDs[id] {
			t.Fatalf("第 %d 份提交已确认成功（编号 %q），但列表中没有对应记录——成功房间被覆盖或挤掉", idx+1, id)
		}
	}

	// 无效提交的配置不得出现在任何记录中。
	for _, record := range rooms {
		if obj, ok := record.(map[string]any); ok && obj["name"] == "四人五子棋无效房" {
			t.Fatalf("无效提交留下了记录: %v", obj)
		}
	}

	// 本地保存内容与列表一致：全部成功创建的房间都已落盘，
	// 已有记录解码后保持原值与原相对次序。
	saved := decodeRecords(t, readDataFile(t, dataDir))
	if !reflect.DeepEqual(saved, rooms) {
		t.Fatalf("本地保存记录与房间列表不一致：\n文件: %v\n列表: %v", saved, rooms)
	}
	if len(saved) != wantTotal {
		t.Fatalf("本地保存记录数量 = %d，期望 %d", len(saved), wantTotal)
	}
}
