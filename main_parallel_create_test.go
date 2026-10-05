package main

import (
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// 本文件回归“多个用户在同一服务中同时提交合法房间配置”时的保存结果：
// 每一份得到 201 的提交都必须落成一个独立房间——编号非空且互不重复，
// 名称（只去首尾空白，内部空格与表情保留）、规则、人数、每步时间、状态与
// 公开范围只属于自己那份响应，不能被并发中后完成的提交覆盖或挤掉；
// 全部处理完成后，房间列表与本地保存内容必须包含全部成功房间，
// 每个成功编号恰好对应一条追加在旧记录之后的新记录（新房间之间不要求按提交先后排序）。
// 同名的两份合法配置也各自创建，不按名称合并。
// 同一批里混入的无效提交（五子棋填 4 人）仍返回 400、说明人数与规则不符，
// 不返回编号、不占保存记录；旧记录中的缺字段对象与非对象记录
// （null、字符串、数字、布尔值、数组）原样保留，不被补齐、清理或展开。
//
// 与 main_test.go 相同，以子进程方式启动真实服务；区别只在于这里用多个 goroutine
// 在同一时刻向同一服务发起 POST，专门钉住并行保存的结果。

// concurrentResult 是单个并发提交的结果（不在 goroutine 内直接 t.Fatal，
// 以免失败时 WaitGroup 之外丢失上下文）。
type concurrentResult struct {
	status int
	body   map[string]any
	err    error
}

// postRoomConcurrent 发起一次创建请求并读完整响应，任何网络或解码错误都放进 err 返回。
func postRoomConcurrent(baseURL, body string) concurrentResult {
	resp, err := httpClient.Post(baseURL+"/api/rooms", "application/json", strings.NewReader(body))
	if err != nil {
		return concurrentResult{err: err}
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return concurrentResult{err: err}
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return concurrentResult{status: resp.StatusCode, err: err}
	}
	return concurrentResult{status: resp.StatusCode, body: decoded}
}

// parallelSubmission 描述一份并发提交：请求体与该提交成功后应当保存的配置。
type parallelSubmission struct {
	body     string
	wantName string
	game     string
	capacity int
	turn     int
	valid    bool
}

// launchParallelSubmissions 让所有提交在同一时刻发出（关闭 start 闸门放行），
// 等待全部完成后返回与 submissions 等长、按下标对齐的结果切片。
func launchParallelSubmissions(t *testing.T, baseURL string, submissions []parallelSubmission) []concurrentResult {
	t.Helper()
	results := make([]concurrentResult, len(submissions))
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i, sub := range submissions {
		wg.Add(1)
		go func(i int, sub parallelSubmission) {
			defer wg.Done()
			<-start // 等所有 goroutine 就绪后一起放行，尽量制造真实的保存重叠。
			results[i] = postRoomConcurrent(baseURL, sub.body)
		}(i, sub)
	}
	close(start)
	wg.Wait()
	return results
}

// 并发用的历史数据：两条完整对象（含字符串备注、数组、嵌套附带字段）之外，
// 再混入 null、字符串、数字、布尔值、空数组和缺字段对象。
// 并发创建不得补齐、清理或展开其中任何一条，也不得改变它们的相对次序。
var parallelSeedLegacy = `{"id":"legacy-missing-fields","name":"缺字段的老房间"}`

func parallelSeedRecords(t *testing.T, dataDir string) []byte {
	t.Helper()
	return seedRooms(t, dataDir,
		seedRecord1,
		seedRecord2,
		`null`,
		`"误入的字符串老记录"`,
		`42`,
		`true`,
		`[]`,
		parallelSeedLegacy,
	)
}

// 一批同时提交中既有五子棋也有飞行棋、既有限时也有不限时房间，
// 其中两份使用相同名称（不同规则与人数）；另外混入一份五子棋填 4 人的无效提交。
func parallelMixedSubmissions(t *testing.T) []parallelSubmission {
	t.Helper()
	mk := func(name, game string, capacity, turn int) parallelSubmission {
		body, err := json.Marshal(map[string]any{
			"name": name, "game": game,
			"capacity": capacity, "turnSeconds": turn,
		})
		if err != nil {
			t.Fatalf("构造请求体失败: %v", err)
		}
		return parallelSubmission{
			body:     string(body),
			wantName: strings.TrimSpace(name),
			game:     game,
			capacity: capacity,
			turn:     turn,
			valid:    true,
		}
	}
	return []parallelSubmission{
		mk("  并行 😀 五子棋 对局  ", "gomoku", 2, 0), // 五子棋 + 不限时，首尾空白待去、内部空格与表情保留
		mk(" 内部 空格 五子棋 ", "gomoku", 2, 10),    // 五子棋 + 有限时
		mk("限时五子棋", "gomoku", 2, 600),         // 五子棋 + 有限时端点
		mk(" 双人 飞行棋 ", "ludo", 2, 0),          // 飞行棋 2 人 + 不限时
		mk("三人飞行棋😀", "ludo", 3, 45),           // 飞行棋 3 人 + 有限时
		mk("四人飞行棋", "ludo", 4, 600),           // 飞行棋 4 人 + 有限时端点
		mk("飞行棋十秒", "ludo", 2, 10),            // 飞行棋 2 人 + 有限时端点
		mk("不限时飞行棋", "ludo", 3, 0),            // 飞行棋 3 人 + 不限时
		mk(" 同名对局 😀", "gomoku", 2, 0),         // 同名（其一）：五子棋 2 人、不限时
		mk("同名对局 😀 ", "ludo", 4, 30),          // 同名（其二）：飞行棋 4 人、有限时，不按名称合并
		// 无效提交：五子棋只能 2 人，填 4 人必须 400，且不占保存记录。
		{
			body:     `{"name":"四人五子棋","game":"gomoku","capacity":4,"turnSeconds":30}`,
			wantName: "四人五子棋",
			game:     "gomoku",
			capacity: 4,
			turn:     30,
			valid:    false,
		},
	}
}

// 多个用户在已有混合历史数据的同一服务中同时提交：每份合法提交都独立创建成功，
// 编号互不重复且不与已有编号冲突，响应里的名称/规则/人数/时间只属于自己那份配置；
// 五子棋 4 人的无效提交拿到 400（人数与规则不符），不返回编号也不占记录。
// 全部处理完成后，列表与本地文件都包含全部成功房间，每个编号恰好对应一条新记录，
// 新记录全部追加在原记录之后，旧记录（含备注、数组、嵌套字段、缺字段对象与非对象记录）
// 的原值与相对次序不变。
func TestParallelRoomCreationAllValidSucceedIndependently(t *testing.T) {
	dataDir := t.TempDir()
	seed := parallelSeedRecords(t, dataDir)
	baseURL := startServer(t, dataDir)

	submissions := parallelMixedSubmissions(t)
	results := launchParallelSubmissions(t, baseURL, submissions)

	// 已有的全部编号，新编号不得与之冲突。
	oldIDs := map[string]bool{}
	for _, rec := range decodeRecords(t, seed) {
		obj, ok := rec.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := obj["id"].(string); id != "" {
			oldIDs[id] = true
		}
	}

	var validCount int
	idToRoom := map[string]map[string]any{}
	for i, sub := range submissions {
		res := results[i]
		if res.err != nil {
			t.Fatalf("第 %d 份提交请求失败: %v", i+1, res.err)
		}
		if !sub.valid {
			// 五子棋填 4 人：400 且明确说明人数与规则不符，不返回成功房间编号。
			if res.status != http.StatusBadRequest {
				t.Fatalf("五子棋 4 人提交状态码 = %d，期望 400，响应: %v", res.status, res.body)
			}
			errMsg, _ := res.body["error"].(string)
			if !strings.Contains(errMsg, "五子棋") || !strings.Contains(errMsg, "2") {
				t.Fatalf("error 应明确说明五子棋人数固定为 2 人（人数与规则不符），实际: %q", errMsg)
			}
			if strings.Contains(errMsg, "名称") || strings.Contains(errMsg, "turnSeconds") {
				t.Fatalf("名称与时间均合法，error 不应落在无关字段上，实际: %q", errMsg)
			}
			if _, ok := res.body["id"]; ok {
				t.Fatalf("无效提交不应返回房间编号，实际: %v", res.body)
			}
			continue
		}

		validCount++
		if res.status != http.StatusCreated {
			t.Fatalf("第 %d 份合法提交状态码 = %d，期望 201，响应: %v", i+1, res.status, res.body)
		}
		room := res.body
		id, _ := room["id"].(string)
		if id == "" {
			t.Fatalf("第 %d 份合法提交返回的编号为空，响应: %v", i+1, room)
		}
		if oldIDs[id] {
			t.Fatalf("新房间编号 %q 与已有房间编号冲突", id)
		}
		if _, dup := idToRoom[id]; dup {
			t.Fatalf("并发成功的房间编号出现重复: %q", id)
		}

		// 每份成功响应只携带自己提交的配置，规则、人数、时间不能串到另一份响应；
		// 同名两份也要能靠不同的规则/人数区分开。
		if got := room["name"]; got != sub.wantName {
			t.Fatalf("第 %d 份提交的名称 = %v，期望 %q（首尾空白已去，内部空格与表情保留）", i+1, got, sub.wantName)
		}
		if got := room["game"]; got != sub.game {
			t.Fatalf("第 %d 份提交的规则 = %v，期望 %q（配置不能串到其他并发响应）", i+1, got, sub.game)
		}
		if got := room["capacity"]; got != float64(sub.capacity) {
			t.Fatalf("第 %d 份提交的人数 = %v，期望 %d（配置不能串到其他并发响应）", i+1, got, sub.capacity)
		}
		if got := room["turnSeconds"]; got != float64(sub.turn) {
			t.Fatalf("第 %d 份提交的每步时间 = %v，期望 %d（0=不限时必须原样保存）", i+1, got, sub.turn)
		}
		if got := room["status"]; got != "waiting" {
			t.Fatalf("第 %d 份提交的状态 = %v，期望 waiting（未开始）", i+1, got)
		}
		if got := room["visibility"]; got != "public" {
			t.Fatalf("第 %d 份提交的公开范围 = %v，期望 public", i+1, got)
		}
		createdAt, _ := room["createdAt"].(string)
		if _, err := time.Parse(time.RFC3339, createdAt); err != nil {
			t.Fatalf("第 %d 份提交的创建时间 %q 不是有效的 RFC3339 时间: %v", i+1, createdAt, err)
		}
		idToRoom[id] = room
	}
	if validCount == 0 {
		t.Fatal("测试用例本身有误：没有任何合法提交")
	}
	if len(idToRoom) != validCount {
		t.Fatalf("成功编号去重后数量 = %d，期望 %d（每份成功提交都应是独立房间）", len(idToRoom), validCount)
	}

	// 全部处理完成后查询：最终记录数只等于“旧记录 + 本批成功数量”，
	// 无效提交不占记录；不能只留下最后完成的提交。
	oldCount := len(decodeRecords(t, seed))
	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("并发创建后 GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if want := oldCount + validCount; len(rooms) != want {
		t.Fatalf("并发创建后记录数量 = %d，期望 %d（旧 %d 条 + 成功 %d 条，无效提交不占记录）",
			len(rooms), want, oldCount, validCount)
	}

	// 旧记录的值与相对次序必须原样保留（含非对象记录与缺字段对象）。
	if !reflect.DeepEqual(rooms[:oldCount], decodeRecords(t, seed)) {
		t.Fatalf("并发创建后旧记录被改动：\n得到: %v\n期望: %v", rooms[:oldCount], decodeRecords(t, seed))
	}
	// 对非对象与缺字段老记录再逐位置钉住类型，防止“数量对了”但被补齐或展开。
	if rooms[2] != nil {
		t.Fatalf("旧 null 记录应原样保留，实际 %v (%T)", rooms[2], rooms[2])
	}
	if got := rooms[3]; got != "误入的字符串老记录" {
		t.Fatalf("旧字符串记录应原样保留，实际 %v", got)
	}
	if got := rooms[4]; got != float64(42) {
		t.Fatalf("旧数字记录应原样保留，实际 %v", got)
	}
	if got := rooms[5]; got != true {
		t.Fatalf("旧布尔记录应原样保留，实际 %v", got)
	}
	if arr, ok := rooms[6].([]any); !ok || len(arr) != 0 {
		t.Fatalf("旧空数组记录应作为一条数组记录整体保留、不展开，实际 %v", rooms[6])
	}
	if partial, ok := rooms[7].(map[string]any); !ok || len(partial) != 2 ||
		partial["id"] != "legacy-missing-fields" {
		t.Fatalf("缺字段旧对象应原样保留、不被补齐默认值，实际 %v", rooms[7])
	}

	// 新记录全部在旧记录之后；新房间之间不要求按提交先后排序，因此按编号做无序比对：
	// 每个成功编号恰好出现一次，且记录与对应创建响应完全一致。
	seen := map[string]int{}
	for _, rec := range rooms[oldCount:] {
		obj, ok := rec.(map[string]any)
		if !ok {
			t.Fatalf("新追加的记录应为对象，实际 %v (%T)", rec, rec)
		}
		id, _ := obj["id"].(string)
		want, ok := idToRoom[id]
		if !ok {
			t.Fatalf("列表新记录编号 %q 不属于任何成功创建响应（无效提交不得留记录）", id)
		}
		if !reflect.DeepEqual(obj, want) {
			t.Fatalf("编号 %q 的列表记录与创建响应不一致（配置被覆盖或串用）：\n列表: %v\n响应: %v", id, obj, want)
		}
		seen[id]++
	}
	if len(seen) != validCount {
		t.Fatalf("列表中新房间编号数 = %d，期望 %d", len(seen), validCount)
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("编号 %q 在列表中出现 %d 次，期望恰好 1 次", id, n)
		}
	}

	// 本地保存内容与列表完全一致：旧记录原位不动，每个成功编号恰好对应一条落盘新记录。
	saved := decodeRecords(t, readDataFile(t, dataDir))
	if !reflect.DeepEqual(saved, rooms) {
		t.Fatalf("本地保存内容与房间列表不一致：\n文件: %v\n列表: %v", saved, rooms)
	}
}

// 同名的两份合法提交在同一时刻到达也必须各自创建一间房，不能按名称合并、
// 互相覆盖或只保留最后完成的一份；两份响应与两条记录靠规则、人数、时间和编号区分。
func TestParallelRoomCreationSameNameCreatesSeparateRooms(t *testing.T) {
	dataDir := t.TempDir()
	baseURL := startServer(t, dataDir)

	submissions := []parallelSubmission{}
	for _, sub := range parallelMixedSubmissions(t) {
		if sub.wantName == "同名对局 😀" {
			submissions = append(submissions, sub)
		}
	}
	if len(submissions) != 2 {
		t.Fatalf("测试用例本身有误：应找到 2 份同名提交，实际 %d", len(submissions))
	}

	results := launchParallelSubmissions(t, baseURL, submissions)
	ids := map[string]bool{}
	var gotGames []string
	for i := range submissions {
		res := results[i]
		if res.err != nil {
			t.Fatalf("同名提交 %d 请求失败: %v", i+1, res.err)
		}
		if res.status != http.StatusCreated {
			t.Fatalf("同名提交 %d 状态码 = %d，期望 201，响应: %v", i+1, res.status, res.body)
		}
		id, _ := res.body["id"].(string)
		if id == "" {
			t.Fatalf("同名提交 %d 返回的编号为空", i+1)
		}
		if ids[id] {
			t.Fatalf("两份同名房间编号重复: %q", id)
		}
		ids[id] = true
		if got := res.body["name"]; got != "同名对局 😀" {
			t.Fatalf("同名提交 %d 的名称 = %v，期望 %q", i+1, got, "同名对局 😀")
		}
		gotGames = append(gotGames, res.body["game"].(string))
	}

	_, rooms := getRooms(t, baseURL)
	if len(rooms) != 2 {
		t.Fatalf("同名两份合法提交后记录数量 = %d，期望 2（同名也各自创建，不按名称合并）", len(rooms))
	}
	gameSeen := map[string]bool{}
	for _, rec := range rooms {
		obj, _ := rec.(map[string]any)
		if obj["name"] != "同名对局 😀" {
			t.Fatalf("列表中出现非本次同名提交的记录: %v", obj)
		}
		gameSeen[obj["game"].(string)] = true
	}
	if !gameSeen["gomoku"] || !gameSeen["ludo"] {
		t.Fatalf("两份同名房间应分别为 gomoku 与 ludo，实际: %v（gotGames=%v）", gameSeen, gotGames)
	}
}

// 没有历史房间时并发创建：每一份合法提交同样全部落盘，
// 不能因为初始为空而互相覆盖成只剩最后完成的一条。
func TestParallelRoomCreationOnEmptyHistory(t *testing.T) {
	dataDir := t.TempDir()
	baseURL := startServer(t, dataDir)

	submissions := []parallelSubmission{}
	for _, sub := range parallelMixedSubmissions(t) {
		if sub.valid {
			submissions = append(submissions, sub)
		}
	}
	results := launchParallelSubmissions(t, baseURL, submissions)

	idToRoom := map[string]map[string]any{}
	for i, sub := range submissions {
		res := results[i]
		if res.err != nil {
			t.Fatalf("第 %d 份提交请求失败: %v", i+1, res.err)
		}
		if res.status != http.StatusCreated {
			t.Fatalf("空历史上第 %d 份合法提交状态码 = %d，期望 201，响应: %v", i+1, res.status, res.body)
		}
		id, _ := res.body["id"].(string)
		if id == "" {
			t.Fatalf("第 %d 份合法提交返回的编号为空", i+1)
		}
		if _, dup := idToRoom[id]; dup {
			t.Fatalf("空历史并发创建仍出现重复编号: %q", id)
		}
		if got := roomConfigOf(res.body); !reflect.DeepEqual(got, submittedConfig(sub)) {
			t.Fatalf("第 %d 份响应配置与提交不一致：\n得到: %v\n期望: %v", i+1, got, submittedConfig(sub))
		}
		idToRoom[id] = res.body
	}

	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if len(rooms) != len(submissions) {
		t.Fatalf("空历史并发创建后记录数量 = %d，期望 %d（不能只剩最后完成的提交）", len(rooms), len(submissions))
	}
	for _, rec := range rooms {
		obj, _ := rec.(map[string]any)
		id, _ := obj["id"].(string)
		if want, ok := idToRoom[id]; !ok || !reflect.DeepEqual(obj, want) {
			t.Fatalf("编号 %q 的列表记录与创建响应不一致或不属于本次提交", id)
		}
	}
	if saved := decodeRecords(t, readDataFile(t, dataDir)); !reflect.DeepEqual(saved, rooms) {
		t.Fatalf("本地保存内容与房间列表不一致：\n文件: %v\n列表: %v", saved, rooms)
	}
}

// roomConfigOf 从创建响应中取出参与校验的四项配置，用于逐份比对。
func roomConfigOf(room map[string]any) map[string]any {
	return map[string]any{
		"name":        room["name"],
		"game":        room["game"],
		"capacity":    room["capacity"],
		"turnSeconds": room["turnSeconds"],
	}
}

// submittedConfig 返回一份提交按公开规则整理后的期望配置（名称去首尾空白、数值为 JSON 数字）。
func submittedConfig(sub parallelSubmission) map[string]any {
	return map[string]any{
		"name":        sub.wantName,
		"game":        sub.game,
		"capacity":    float64(sub.capacity),
		"turnSeconds": float64(sub.turn),
	}
}
