package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

// 本文件是“首页创建公开房间”的页面级端到端回归测试。
// 现有 main_test.go 只覆盖创建接口与本地保存；这里用无头 Chrome 驱动真实页面，
// 覆盖用户实际看到的提示、表单与列表变化，重点区分两次请求的结果：
//
//	POST /api/rooms（创建结果）—— 决定成功/失败提示与表单是否清空；
//	GET  /api/rooms（列表刷新结果）—— 只决定列表区域，不能反过来改写创建结论。
//
// 完整成功链路使用真实服务；“服务拒绝创建”与“创建成功但列表刷新失败”两类
// 真实接口无法稳定构造的场景，通过页面脚本层的 fetch 测试替身合成响应，
// 页面自身的创建/渲染逻辑一行不改。

// pageSnapshot 是测试时刻页面用户可见状态与请求记录的快照。
type pageSnapshot struct {
	Name             string     `json:"name"`
	Game             string     `json:"game"`
	Capacity         string     `json:"capacity"`
	CapacityDisabled bool       `json:"capacityDisabled"`
	TurnSeconds      string     `json:"turnSeconds"`
	SubmitDisabled   bool       `json:"submitDisabled"`
	MsgText          string     `json:"msgText"`
	MsgShown         bool       `json:"msgShown"`
	MsgKind          string     `json:"msgKind"`
	EmptyShown       bool       `json:"emptyShown"`
	ListErrorShown   bool       `json:"listErrorShown"`
	ListErrorText    string     `json:"listErrorText"`
	HasTable         bool       `json:"hasTable"`
	Rows             [][]string `json:"rows"`
	RowTimes         []string   `json:"rowTimes"`
	PostCount        int        `json:"postCount"`
	PostBodies       []string   `json:"postBodies"`
	ListCalls        int        `json:"listCalls"`
}

func snapshotPage(t *testing.T, pg *cdpPage) pageSnapshot {
	t.Helper()
	var snap pageSnapshot
	if err := pg.evalInto("window.__e2eSnapshot()", &snap); err != nil {
		t.Fatalf("读取页面状态失败: %v", err)
	}
	return snap
}

// waitFor 轮询页面状态直到条件成立；页面反馈均为异步请求结果，必须等待而非立即断言。
func waitFor(t *testing.T, what string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("等待页面状态超时：%s", what)
}

func fillForm(t *testing.T, pg *cdpPage, name, game string, capacity, turnSeconds int) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"name": name, "game": game, "capacity": capacity, "turnSeconds": turnSeconds,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := pg.evalInto(fmt.Sprintf("window.__e2eFill(%s)", payload), nil); err != nil {
		t.Fatalf("填写表单失败: %v", err)
	}
}

func setName(t *testing.T, pg *cdpPage, name string) {
	t.Helper()
	payload, err := json.Marshal(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := pg.evalInto(fmt.Sprintf("window.__e2eSetName(%s)", payload), nil); err != nil {
		t.Fatalf("修改房间名称失败: %v", err)
	}
}

func clickSubmit(t *testing.T, pg *cdpPage) {
	t.Helper()
	if err := pg.evalInto("window.__e2eSubmit()", nil); err != nil {
		t.Fatalf("点击创建按钮失败: %v", err)
	}
}

// expectRow 按页面表格列顺序（编号/名称/规则/人数/时间/状态/创建时间）构造期望行。
func expectRow(id, name, gameLabel, capacityCell, turnCell, statusCell, timeCell string) []string {
	return []string{id, name, gameLabel, capacityCell, turnCell, statusCell, timeCell}
}

// waitForInitialList 等待首页首次读取列表完成并显示期望数量的房间行。
func waitForInitialList(t *testing.T, pg *cdpPage, wantRows int) pageSnapshot {
	t.Helper()
	waitFor(t, "首页首次加载房间列表", func() bool {
		s := snapshotPage(t, pg)
		return s.ListCalls >= 1 && s.HasTable && len(s.Rows) == wantRows
	})
	return snapshotPage(t, pg)
}

// TestHomePageCreateRoomFullSuccess 覆盖完整成功链路（真实服务）：
// 已有房间时填写首尾带空白、内部带空格的名称，选择五子棋/2 人/0 秒，
// 成功后看到服务返回的新编号、表单恢复初始状态、列表在原记录之后追加一行，
// 且新行的编号与配置与本次创建结果逐字段相符。
func TestHomePageCreateRoomFullSuccess(t *testing.T) {
	dataDir := t.TempDir()
	seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)
	browser := startChrome(t)
	pg := browser.openPage(t, baseURL+"/", buildBootstrap(nil))

	initSnap := waitForInitialList(t, pg, 2)
	wantSeedRows := [][]string{
		expectRow("seed-alpha", "晨间飞行棋", "飞行棋", "4 人", "30 秒", "playing", "2026-01-01 08:00:00"),
		expectRow("seed-beta", "午夜五子棋", "五子棋", "2 人", "不限时", "未开始", "2026-01-02 23:00:00"),
	}
	if !reflect.DeepEqual(initSnap.Rows, wantSeedRows) {
		t.Fatalf("初始列表与种子记录不一致：\n得到: %v\n期望: %v", initSnap.Rows, wantSeedRows)
	}

	const typedName = "  周末 五子棋 友谊赛  "
	fillForm(t, pg, typedName, "gomoku", 2, 0)
	before := snapshotPage(t, pg)
	if before.Name != typedName || before.Game != "gomoku" || before.Capacity != "2" || before.TurnSeconds != "0" {
		t.Fatalf("提交前表单状态与填写不符: %+v", before)
	}
	if before.SubmitDisabled {
		t.Fatal("提交前创建按钮不应处于禁用状态")
	}

	clickSubmit(t, pg)

	// 创建请求发出且列表刷新完成（同页列表显示新增房间）。
	waitFor(t, "创建成功并刷新列表", func() bool {
		s := snapshotPage(t, pg)
		return s.PostCount == 1 && s.ListCalls == 2 && s.HasTable && len(s.Rows) == 3
	})
	snap := snapshotPage(t, pg)

	// 页面发出的创建请求体必须是用户实际填写的内容（首尾空白原样提交，由服务端整理）。
	if len(snap.PostBodies) != 1 {
		t.Fatalf("创建请求次数 = %d，期望 1", len(snap.PostBodies))
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(snap.PostBodies[0]), &sent); err != nil {
		t.Fatalf("创建请求体不是合法 JSON: %v", err)
	}
	wantSent := map[string]any{
		"name": typedName, "game": "gomoku", "capacity": float64(2), "turnSeconds": float64(0),
	}
	if !reflect.DeepEqual(sent, wantSent) {
		t.Fatalf("创建请求体与填写内容不符：\n得到: %v\n期望: %v", sent, wantSent)
	}

	// 以接口查询本次创建结果作为基准（创建结果与列表刷新结果必须分别核对）。
	status, rooms := getRooms(t, baseURL)
	if status != http.StatusOK || len(rooms) != 3 {
		t.Fatalf("创建后接口房间数量异常：status=%d len=%d", status, len(rooms))
	}
	created, ok := rooms[2].(map[string]any)
	if !ok {
		t.Fatalf("接口中的新记录不是对象: %v", rooms[2])
	}
	newID, _ := created["id"].(string)
	if newID == "" || newID == "seed-alpha" || newID == "seed-beta" {
		t.Fatalf("服务返回的新房间编号异常: %q", newID)
	}

	// 成功提示必须展示“本次创建结果”的编号，而不是列表里任意一行的编号。
	if !snap.MsgShown || snap.MsgKind != "ok" {
		t.Fatalf("成功后应显示成功提示，实际 shown=%v kind=%q text=%q", snap.MsgShown, snap.MsgKind, snap.MsgText)
	}
	if wantMsg := "房间已创建，编号：" + newID; snap.MsgText != wantMsg {
		t.Fatalf("成功提示 = %q，期望 %q", snap.MsgText, wantMsg)
	}

	// 表单恢复到初始填写状态：输入清空、规则回到未选择、人数随之禁用、时间清空。
	if snap.Name != "" || snap.Game != "" || snap.Capacity != "" ||
		!snap.CapacityDisabled || snap.TurnSeconds != "" {
		t.Fatalf("成功后表单未恢复初始状态: %+v", snap)
	}

	// 列表：原有两条内容与次序不变，新记录出现在它们之后。
	if !reflect.DeepEqual(snap.Rows[:2], wantSeedRows) {
		t.Fatalf("原有房间被改写或重新排序：\n得到: %v\n期望: %v", snap.Rows[:2], wantSeedRows)
	}
	createdAt, _ := created["createdAt"].(string)
	parsedTime, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		t.Fatalf("新记录创建时间非法: %q", createdAt)
	}
	wantNewRow := expectRow(
		newID,
		"周末 五子棋 友谊赛", // 首尾空白去掉，内部空格保留
		"五子棋", "2 人", "不限时", "未开始",
		parsedTime.UTC().Format("2006-01-02 15:04:05"),
	)
	// 逐字段比对新行：编号、名称、规则、人数、时间显示、状态显示、创建时间。
	if !reflect.DeepEqual(snap.Rows[2], wantNewRow) {
		t.Fatalf("列表新行与本次创建结果不符：\n得到: %v\n期望: %v", snap.Rows[2], wantNewRow)
	}
	if snap.RowTimes[2] != createdAt {
		t.Fatalf("列表新行创建时间原始值 = %q，期望 %q", snap.RowTimes[2], createdAt)
	}
	if got := created["turnSeconds"]; got != float64(0) {
		t.Fatalf("创建结果 turnSeconds = %v，期望 0", got)
	}
	if got := created["status"]; got != "waiting" {
		t.Fatalf("创建结果 status = %v，期望 waiting", got)
	}

	if snap.EmptyShown || snap.ListErrorShown {
		t.Fatalf("成功后列表区域不应显示空提示或加载失败: %+v", snap)
	}
	if snap.SubmitDisabled {
		t.Fatal("完整成功后创建按钮应恢复可用，页面不能停在等待状态")
	}
}

// TestHomePageRejectedCreateKeepsFormAndAllowsResubmit 覆盖创建被服务拒绝：
// 页面显示服务返回的具体原因，保留全部已填内容，不显示成功提示、不刷新/追加列表；
// 用户只需直接修改保留的名称即可再次提交，第二次成功后按成功处理。
func TestHomePageRejectedCreateKeepsFormAndAllowsResubmit(t *testing.T) {
	dataDir := t.TempDir()
	seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)
	browser := startChrome(t)

	// 第一次 POST 合成 400 拒绝（“名称重复”是只有服务端才能判定的原因），
	// 用户仅改名后第二次 POST 透传给真实服务并成功。
	const serverReason = "房间名称与已有房间重复：晚间五子棋"
	spec := &fetchStubSpec{
		RejectStatus: http.StatusBadRequest,
		RejectBody:   map[string]any{"error": serverReason},
		PostActions:  []string{"reject", "pass"},
	}
	pg := browser.openPage(t, baseURL+"/", buildBootstrap(spec))

	initSnap := waitForInitialList(t, pg, 2)
	wantSeedRows := initSnap.Rows

	fillForm(t, pg, "晚间五子棋", "gomoku", 2, 0)
	clickSubmit(t, pg)

	waitFor(t, "创建被服务拒绝并显示原因", func() bool {
		s := snapshotPage(t, pg)
		return s.PostCount == 1 && s.MsgShown && s.MsgKind == "error"
	})
	snap := snapshotPage(t, pg)

	// 必须显示服务返回的具体原因原文，而不是笼统的失败提示。
	if snap.MsgText != serverReason {
		t.Fatalf("拒绝提示 = %q，期望服务返回的原因 %q", snap.MsgText, serverReason)
	}
	// 已填内容原样保留，用户不必重新填写整张表单。
	if snap.Name != "晚间五子棋" || snap.Game != "gomoku" ||
		snap.Capacity != "2" || snap.TurnSeconds != "0" {
		t.Fatalf("创建被拒绝后应保留已填内容: %+v", snap)
	}
	// 不显示成功提示；不触发列表刷新、不向列表追加本次房间。
	if snap.EmptyShown || snap.ListErrorShown || snap.HasTable != true || len(snap.Rows) != 2 {
		t.Fatalf("创建被拒绝后列表区域状态异常: %+v", snap)
	}
	if !reflect.DeepEqual(snap.Rows, wantSeedRows) {
		t.Fatalf("创建被拒绝后列表被改动：\n得到: %v\n期望: %v", snap.Rows, wantSeedRows)
	}
	if snap.ListCalls != 1 {
		t.Fatalf("创建被拒绝不应重新读取列表，列表请求次数 = %d，期望 1", snap.ListCalls)
	}
	if snap.SubmitDisabled {
		t.Fatal("创建被拒绝后创建按钮应恢复可用，页面不能停在等待状态")
	}
	// 服务端确实没有这条房间（请求在页面层被合成拒绝，真实服务无新记录）。
	if _, rooms := getRooms(t, baseURL); len(rooms) != 2 {
		t.Fatalf("被拒绝的创建不应产生服务端记录，实际房间数 = %d", len(rooms))
	}

	// 直接在保留内容上改名后再次提交，规则/人数/时间均沿用保留值。
	setName(t, pg, "  晚间五子棋二局  ")
	clickSubmit(t, pg)
	waitFor(t, "修改保留内容后再次创建成功", func() bool {
		s := snapshotPage(t, pg)
		return s.PostCount == 2 && s.ListCalls == 2 && s.HasTable && len(s.Rows) == 3
	})
	second := snapshotPage(t, pg)

	var secondBody map[string]any
	if err := json.Unmarshal([]byte(second.PostBodies[1]), &secondBody); err != nil {
		t.Fatalf("第二次创建请求体不是合法 JSON: %v", err)
	}
	if got := secondBody["game"]; got != "gomoku" {
		t.Fatalf("第二次提交的规则 = %v，期望沿用保留的 gomoku", got)
	}
	if got := secondBody["capacity"]; got != float64(2) {
		t.Fatalf("第二次提交的人数 = %v，期望沿用保留的 2", got)
	}
	if got := secondBody["turnSeconds"]; got != float64(0) {
		t.Fatalf("第二次提交的时间 = %v，期望沿用保留的 0", got)
	}
	if got := secondBody["name"]; got != "  晚间五子棋二局  " {
		t.Fatalf("第二次提交的名称 = %v，期望只修改名称且原样提交", got)
	}

	_, rooms := getRooms(t, baseURL)
	created, _ := rooms[2].(map[string]any)
	newID, _ := created["id"].(string)
	if second.MsgKind != "ok" || second.MsgText != "房间已创建，编号："+newID {
		t.Fatalf("第二次创建应按成功提示编号，实际 kind=%q text=%q", second.MsgKind, second.MsgText)
	}
	if !reflect.DeepEqual(second.Rows[:2], wantSeedRows) {
		t.Fatalf("第二次成功后原有房间被改动：\n得到: %v\n期望: %v", second.Rows[:2], wantSeedRows)
	}
	if got := second.Rows[2][1]; got != "晚间五子棋二局" {
		t.Fatalf("新追加房间名称 = %q，期望去掉首尾空白后的 %q", got, "晚间五子棋二局")
	}
	if got := second.Rows[2][4]; got != "不限时" {
		t.Fatalf("新追加房间时间显示 = %q，期望 不限时", got)
	}
	if got := second.Rows[2][5]; got != "未开始" {
		t.Fatalf("新追加房间状态 = %q，期望 未开始", got)
	}
	if second.Name != "" || second.Game != "" || second.Capacity != "" ||
		!second.CapacityDisabled || second.TurnSeconds != "" {
		t.Fatalf("第二次成功后表单应恢复初始状态: %+v", second)
	}
	if second.SubmitDisabled {
		t.Fatal("再次成功后创建按钮应恢复可用")
	}
}

// TestHomePageCreateSucceedsButListReloadFails 覆盖两次请求结果必须分开处理：
// POST 已成功、紧接着 GET 列表失败时，成功提示与编号保留、表单按成功清空，
// 列表区域明确显示加载失败；不能显示“还没有房间记录”，也不能把已完成的创建说成失败。
func TestHomePageCreateSucceedsButListReloadFails(t *testing.T) {
	dataDir := t.TempDir()
	seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)
	browser := startChrome(t)

	// 首次 GET（页面加载）透传成功；POST 透传真实服务并成功；
	// 创建后的第二次 GET（列表刷新）合成 500。
	spec := &fetchStubSpec{
		PostActions: []string{"pass"},
		FailListAt:  []int{2},
	}
	pg := browser.openPage(t, baseURL+"/", buildBootstrap(spec))
	waitForInitialList(t, pg, 2)

	fillForm(t, pg, "  深夜 五子棋 直播局 ", "gomoku", 2, 0)
	clickSubmit(t, pg)

	waitFor(t, "创建成功但列表刷新失败", func() bool {
		s := snapshotPage(t, pg)
		return s.PostCount == 1 && s.ListCalls == 2 && s.ListErrorShown
	})
	snap := snapshotPage(t, pg)

	// 创建确实已在服务端完成，新编号以接口结果为准。
	_, rooms := getRooms(t, baseURL)
	if len(rooms) != 3 {
		t.Fatalf("创建应已在服务端完成，房间数 = %d，期望 3", len(rooms))
	}
	created, _ := rooms[2].(map[string]any)
	newID, _ := created["id"].(string)

	// 成功结论不允许被随后的列表失败推翻：成功提示与服务返回的编号仍在。
	if !snap.MsgShown || snap.MsgKind != "ok" {
		t.Fatalf("列表刷新失败不应改变成功提示，实际 shown=%v kind=%q text=%q",
			snap.MsgShown, snap.MsgKind, snap.MsgText)
	}
	if wantMsg := "房间已创建，编号：" + newID; snap.MsgText != wantMsg {
		t.Fatalf("成功提示 = %q，期望保留 %q", snap.MsgText, wantMsg)
	}
	// 表单仍按创建成功处理。
	if snap.Name != "" || snap.Game != "" || snap.Capacity != "" ||
		!snap.CapacityDisabled || snap.TurnSeconds != "" {
		t.Fatalf("创建成功后表单应按成功清空: %+v", snap)
	}

	// 列表区域必须明确显示加载失败，且不能伪装成“还没有房间记录”。
	if !snap.ListErrorShown {
		t.Fatal("列表刷新失败时应显示加载失败提示")
	}
	if !strings.Contains(snap.ListErrorText, "加载失败") {
		t.Fatalf("列表失败提示语义不明确: %q", snap.ListErrorText)
	}
	if snap.EmptyShown || strings.Contains(snap.ListErrorText, "还没有房间记录") {
		t.Fatalf("加载失败不能显示空列表提示“还没有房间记录”: %+v", snap)
	}
	if snap.HasTable || len(snap.Rows) != 0 {
		t.Fatalf("加载失败时不应渲染房间表格: %+v", snap)
	}
	if snap.SubmitDisabled {
		t.Fatal("列表刷新失败后创建按钮应恢复可用，页面不能停在等待状态")
	}

	// 错误文案不能诱导用户重复创建：不得包含“创建失败”等把创建说成失败的字样。
	if strings.Contains(snap.ListErrorText, "创建失败") {
		t.Fatalf("列表失败提示把已完成的创建说成失败: %q", snap.ListErrorText)
	}
}

// TestHomePageSubmitButtonDisabledWhileWaiting 覆盖提交等待期间按钮暂时不可用，
// 并在请求结束（此处为服务拒绝）后恢复，页面不能一直停在等待状态。
func TestHomePageSubmitButtonDisabledWhileWaiting(t *testing.T) {
	dataDir := t.TempDir()
	seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)
	browser := startChrome(t)

	// 拒绝响应延迟 800ms，制造确定的“提交等待中”窗口。
	spec := &fetchStubSpec{
		DelayMS:      800,
		RejectStatus: http.StatusBadRequest,
		RejectBody:   map[string]any{"error": "服务暂时不可用（测试延迟拒绝）"},
		PostActions:  []string{"reject"},
	}
	pg := browser.openPage(t, baseURL+"/", buildBootstrap(spec))
	waitForInitialList(t, pg, 2)

	fillForm(t, pg, "等待中的房间", "gomoku", 2, 0)
	clickSubmit(t, pg)

	// 在拒绝响应返回前（800ms 窗口内）必须能观察到按钮禁用。
	sawDisabled := false
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if snapshotPage(t, pg).SubmitDisabled {
			sawDisabled = true
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if !sawDisabled {
		t.Fatal("提交等待期间创建按钮应暂时不可用")
	}

	// 请求结束后按钮恢复可用，并展示拒绝原因。
	waitFor(t, "拒绝响应返回后按钮恢复", func() bool {
		s := snapshotPage(t, pg)
		return s.PostCount == 1 && s.MsgShown && !s.SubmitDisabled
	})
	snap := snapshotPage(t, pg)
	if snap.MsgKind != "error" || snap.MsgText != "服务暂时不可用（测试延迟拒绝）" {
		t.Fatalf("拒绝结束后提示异常: kind=%q text=%q", snap.MsgKind, snap.MsgText)
	}
	if snap.Name != "等待中的房间" || snap.Game != "gomoku" || snap.Capacity != "2" || snap.TurnSeconds != "0" {
		t.Fatalf("拒绝后应保留已填内容: %+v", snap)
	}
	if len(snap.Rows) != 2 || snap.ListCalls != 1 {
		t.Fatalf("拒绝后不应刷新或改动列表: %+v", snap)
	}
}
