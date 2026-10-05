package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// 本文件围绕 POST /api/rooms 的入口约定做端到端回归：
// “每次提交只能包含一个完整的 JSON 对象”。直接调用接口的请求不经过首页校验，
// 即使载荷中能找到合法的房间名称、游戏规则、人数和时间，也不能只取其中一部分
// 就创建房间；也不能在一个合法对象之后还跟着内容时先保存前面对象再报告失败。
// 这些都属于“请求内容不符合约定”，error 必须说明请求体必须是单个 JSON 对象，
// 不能被说成房间数据读取失败（那是 500）。

// singleObjectErr 是入口约定被违反时的固定错误信息。
const singleObjectErr = "请求体必须是单个 JSON 对象"

// validRoomBody 是一份字段齐全、配置合法的房间对象，供各用例前后拼接。
const validRoomBody = `{"name":"晚间五子棋","game":"gomoku","capacity":2,"turnSeconds":0}`

// secondValidRoomBody 是另一份完整合法的房间对象（飞行棋），用于拼接尾随内容。
const secondValidRoomBody = `{"name":"深夜飞行棋","game":"ludo","capacity":3,"turnSeconds":30}`

// assertSingleObjectRejected 断言一次违反“单个 JSON 对象”约定的提交：
// 返回 400、error 明确说明请求体必须是单个 JSON 对象（且不是房间数据读取失败、
// 不是字段级错误），响应中不携带新房间编号；已有房间数量、次序、配置、附带字段
// 与本地文件内容保持不变。
func assertSingleObjectRejected(t *testing.T, baseURL, dataDir string, seed []byte, body string) {
	t.Helper()
	status, resp := postRoom(t, baseURL, body)
	if status != http.StatusBadRequest {
		t.Fatalf("状态码 = %d，期望 400（载荷: %q，响应: %v）", status, body, resp)
	}
	errMsg, _ := resp["error"].(string)
	if !strings.Contains(errMsg, "单个 JSON 对象") {
		t.Fatalf("error 应说明请求体必须是单个 JSON 对象，实际: %q（载荷: %q）", errMsg, body)
	}
	// 这是请求内容不符合约定，不能被归为房间数据读取失败或字段缺失/类型错误。
	if strings.Contains(errMsg, "房间数据") {
		t.Fatalf("请求体格式错误不应被说成房间数据读取失败，实际: %q（载荷: %q）", errMsg, body)
	}
	if strings.Contains(errMsg, "缺少必填字段") {
		t.Fatalf("请求体不是单个对象时不应进入字段级校验，实际: %q（载荷: %q）", errMsg, body)
	}
	if _, ok := resp["id"]; ok {
		t.Fatalf("被拒绝的请求不应返回新房间编号，实际: %v（载荷: %q）", resp, body)
	}
	if room, ok := resp["name"]; ok {
		t.Fatalf("被拒绝的请求不应返回房间内容（name=%v），载荷: %q", room, body)
	}
	// 无效请求不能改变原有房间的数量、次序、配置和附带字段，本地文件也不得被改写。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// 请求内容为空、只有空白、不是合法 JSON，或顶层是 null、字符串、数字、布尔值、数组时，
// 都必须返回 400 并说明请求体必须是单个 JSON 对象，即使载荷中含有完整合法的房间配置
// （例如数组里包着唯一一个合法房间对象），也不能只取出其中一部分就创建房间。
func TestCreateRoomRejectsBodyThatIsNotSingleJSONObject(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		desc string
		body string
	}{
		{"空请求体", ""},
		{"只有空格", "     "},
		{"空格、制表符与换行", " \t\r\n  \n\t "},
		{"不是合法 JSON：单词", "not json"},
		{"不是合法 JSON：残缺花括号", "{"},
		{"不是合法 JSON：对象键无引号", `{name:"晚间五子棋"}`},
		{"不是合法 JSON：尾部多逗号", `{"name":"晚间五子棋",}`},
		{"顶层 null", `null`},
		{"null 前后带合法空白", " \t\r\nnull\r\n\t "},
		{"顶层字符串", `"晚间五子棋"`},
		{"顶层空字符串", `""`},
		{"顶层数字", `42`},
		{"顶层数字 0", `0`},
		{"顶层布尔值 true", `true`},
		{"顶层布尔值 false", `false`},
		{"顶层空数组", `[]`},
		{"数组中只有一个完整且配置合法的房间对象", `[` + validRoomBody + `]`},
		{"数组中合法房间对象前后带空白", " [\n" + validRoomBody + "\n] "},
		{"数组中有两个合法房间对象", `[` + validRoomBody + `,` + secondValidRoomBody + `]`},
		{"数组中除合法房间对象外还有其他值", `[` + validRoomBody + `,"多余"]`},
		{"合法对象被字符串包裹", `"` + validRoomBody + `"`},
	}

	for _, tc := range cases {
		assertSingleObjectRejected(t, baseURL, dataDir, seed, tc.body)
	}

	// 全部拒绝后再复验一次：房间仍只有种子的 2 条，被拒绝请求不占据任何记录。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// 对象尚未结束就中断的内容同样不能留下半条记录：缺右花括号、字符串未闭合、
// 半截字段名等截断写法都必须在入口被拒绝，已有房间与本地文件保持原样。
func TestCreateRoomRejectsTruncatedObject(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		desc string
		body string
	}{
		{"缺右花括号", `{"name":"半截房","game":"gomoku","capacity":2,"turnSeconds":0`},
		{"最后一个字符串未闭合", `{"name":"半截房","game":"gomoku","capacity":2,"turnSeconds":3`},
		{"字段名写到一半中断", `{"name":"半截房","game":"gomoku","capac`},
		{"值写到一半中断", `{"name":"半截房","game":"gomoku","capacity":2,"turnSeconds":30`},
		{"开头是左花括号后立即中断", `{`},
		{"完整房间对象之后数组未闭合", validRoomBody + `[`},
	}

	for _, tc := range cases {
		assertSingleObjectRejected(t, baseURL, dataDir, seed, tc.body)
	}
}

// 尤其保护“完整对象之后还有内容”：一个合法配置后接第二个对象、其他 JSON 值或
// 非空白字符时，整个请求都必须被拒绝——绝不能先保存前面的房间再报告失败。
func TestCreateRoomRejectsContentAfterCompleteObject(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		desc string
		body string
	}{
		{"合法对象后接第二个完整对象", validRoomBody + secondValidRoomBody},
		{"两个对象之间只有空白", validRoomBody + " \t\r\n " + secondValidRoomBody},
		{"合法对象后接 null", validRoomBody + `null`},
		{"合法对象后接字符串", validRoomBody + `"x"`},
		{"合法对象后接数字", validRoomBody + `42`},
		{"合法对象后接布尔值", validRoomBody + `true`},
		{"合法对象后接空数组", validRoomBody + `[]`},
		{"合法对象后接包含房间对象的数组", validRoomBody + `[` + secondValidRoomBody + `]`},
		{"合法对象后接非空白字母", validRoomBody + `x`},
		{"合法对象后接逗号", validRoomBody + `,`},
		{"合法对象后接多余右花括号", validRoomBody + `}`},
		{"合法对象后接多余右方括号", validRoomBody + `]`},
		{"合法对象后接冒号", validRoomBody + `:`},
		{"空白之后再接非空白字母", validRoomBody + "   x"},
		{"合法对象被第二个对象的左花括号接上", validRoomBody + `{`},
	}

	for _, tc := range cases {
		assertSingleObjectRejected(t, baseURL, dataDir, seed, tc.body)
	}

	// 明确验证“不能先保存前面对象”：所有尾随内容场景结束后仍只有种子的 2 条记录，
	// 第一条合法配置没有因为抢先落盘而留下房间。
	status, rooms := getRooms(t, baseURL)
	if status != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", status)
	}
	if len(rooms) != 2 {
		t.Fatalf("房间数量 = %d，期望 2：完整对象后的多余内容必须整体拒绝，不能先保存前面对象", len(rooms))
	}
	for _, record := range rooms {
		room, _ := record.(map[string]any)
		switch room["name"] {
		case "晚间五子棋", "深夜飞行棋":
			t.Fatalf("被整体拒绝请求中的房间 %q 仍被保存，说明先写入后报错: %v", room["name"], record)
		}
	}
}

// 一个合法配置前后只有 JSON 允许的空格、制表符或换行时仍应正常创建；
// 名称字符串内部的花括号、方括号以及按 JSON 规则转义后的引号都属于名称内容，
// 不能被误认为第二份配置或结构损坏。保存后的名称继续遵循已有的首尾空白整理规则。
func TestCreateRoomAcceptsSingleObjectWithWhitespaceAndNamePunctuation(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	wrappers := []struct {
		desc string
		head string
		tail string
	}{
		{"前后空格", "   ", "   "},
		{"前后制表符", "\t\t", "\t"},
		{"前后 CRLF 与换行", "\r\n \n", "\n\r\n "},
		{"前有空白后无内容", " \t\r\n", ""},
		{"前无内容后有空白", "", " \t\r\n"},
	}

	wantCreated := make([]map[string]any, 0, len(wrappers)+2)
	for _, w := range wrappers {
		status, created := postRoom(t, baseURL, w.head+validRoomBody+w.tail)
		if status != http.StatusCreated {
			t.Fatalf("%s：创建状态码 = %d，期望 201，响应: %v", w.desc, status, created)
		}
		if id, _ := created["id"].(string); id == "" {
			t.Fatalf("%s：新房间编号为空", w.desc)
		}
		if got, want := created["name"], "晚间五子棋"; got != want {
			t.Fatalf("%s：名称 = %v，期望 %q", w.desc, got, want)
		}
		if got := created["game"]; got != "gomoku" {
			t.Fatalf("%s：规则 = %v，期望 gomoku", w.desc, got)
		}
		if got := created["capacity"]; got != float64(2) {
			t.Fatalf("%s：人数 = %v，期望 2", w.desc, got)
		}
		if got := created["turnSeconds"]; got != float64(0) {
			t.Fatalf("%s：每步时间 = %v，期望 0", w.desc, got)
		}
		wantCreated = append(wantCreated, created)
	}

	// 名称内部的花括号、方括号与转义引号必须作为名称内容原样保存（首尾空白仍按现有规则整理）。
	punctNames := []struct {
		desc    string
		rawName string // JSON 字符串字面量中“名称内容”的写法（转义直接写在 Go 原始串里）
		want    string
	}{
		{"名称内含花括号", `房{间}大赛`, `房{间}大赛`},
		{"名称内含方括号", `周末[五子棋]`, `周末[五子棋]`},
		{"名称内含转义引号", `深夜\"复盘\"局`, `深夜"复盘"局`},
		{"名称含花括号与转义引号并带首尾空白", `  杯赛{决\"赛\"}[A]  `, `杯赛{决"赛"}[A]`},
		{"名称以花括号开头结尾", `{友谊赛}`, `{友谊赛}`},
	}
	for _, tc := range punctNames {
		body := `{"name":"` + tc.rawName + `","game":"ludo","capacity":4,"turnSeconds":60}`
		// 先确保构造出的载荷本身是合法 JSON，避免测试用例自身写错转义。
		var probe map[string]any
		if err := json.Unmarshal([]byte(body), &probe); err != nil {
			t.Fatalf("%s：测试载荷不是合法 JSON: %v（%s）", tc.desc, err, body)
		}
		status, created := postRoom(t, baseURL, body)
		if status != http.StatusCreated {
			t.Fatalf("%s：创建状态码 = %d，期望 201（含标点的名称不应被当成结构问题），响应: %v", tc.desc, status, created)
		}
		if got := created["name"]; got != tc.want {
			t.Fatalf("%s：保存的名称 = %v，期望 %q（标点是名称内容，首尾空白仍整理）", tc.desc, got, tc.want)
		}
		if got := created["game"]; got != "ludo" {
			t.Fatalf("%s：规则 = %v，期望 ludo", tc.desc, got)
		}
		if got := created["capacity"]; got != float64(4) {
			t.Fatalf("%s：人数 = %v，期望 4", tc.desc, got)
		}
		if got := created["turnSeconds"]; got != float64(60) {
			t.Fatalf("%s：每步时间 = %v，期望 60", tc.desc, got)
		}
		wantCreated = append(wantCreated, created)
	}

	// 列表仅在原有 2 条记录之后按提交次序增加成功创建的记录，每条与创建响应一致。
	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if want := 2 + len(wantCreated); len(rooms) != want {
		t.Fatalf("房间数量 = %d，期望 %d（种子 2 条 + 成功创建 %d 条）", len(rooms), want, len(wantCreated))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间被改动或重新排序：\n得到: %v\n期望: %v", rooms[:2], want)
	}
	for i, created := range wantCreated {
		if !reflect.DeepEqual(rooms[2+i], created) {
			t.Fatalf("列表第 %d 条新记录与创建响应不一致：\n列表: %v\n响应: %v", i+1, rooms[2+i], created)
		}
	}

	// 本地保存的内容与查询结果一致，且原有记录的附带字段逐字段保留。
	saved := decodeRecords(t, readDataFile(t, dataDir))
	if !reflect.DeepEqual(saved, rooms) {
		t.Fatalf("本地保存记录与房间列表不一致：\n文件: %v\n列表: %v", saved, rooms)
	}
	first, _ := saved[0].(map[string]any)
	if first["note"] != "保留我" {
		t.Fatalf("首条种子记录的附带字段被改写: %v", saved[0])
	}
}

// 被各种不符合约定的请求拒绝后，用户把请求修正为一个合法对象：
// 应收到 201 和新房间，列表仅在原有记录之后增加这一条（内容与创建响应一致），
// 此前被拒绝的请求不占据任何房间记录。
func TestCreateRoomRecoversAfterMalformedBodies(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	// 先制造一批覆盖各拒绝分支的错误请求。
	badBodies := []string{
		"",
		"   ",
		"not json",
		"null",
		`"晚间五子棋"`,
		"42",
		"true",
		"[" + validRoomBody + "]",
		validRoomBody + secondValidRoomBody,
		validRoomBody + `x`,
		`{"name":"半截房","game":"gomoku","capacity":2,"turnSeconds":3`,
	}
	for _, body := range badBodies {
		assertSingleObjectRejected(t, baseURL, dataDir, seed, body)
	}

	// 修正为一个合法对象后正常创建。
	status, created := postRoom(t, baseURL, validRoomBody)
	if status != http.StatusCreated {
		t.Fatalf("修正后创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	id, _ := created["id"].(string)
	if id == "" || id == "seed-alpha" || id == "seed-beta" {
		t.Fatalf("修正后新房间编号异常: %q", id)
	}
	if got, want := created["name"], "晚间五子棋"; got != want {
		t.Fatalf("名称 = %v，期望 %q", got, want)
	}

	// 列表仅在原有记录之后增加这一次成功创建的记录；被拒绝请求不占记录。
	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if len(rooms) != 3 {
		t.Fatalf("房间数量 = %d，期望 3（种子 2 条 + 修正成功 1 条，被拒请求不得留记录）", len(rooms))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间的数量、次序、配置或附带字段被改动：\n得到: %v\n期望: %v", rooms[:2], want)
	}
	if !reflect.DeepEqual(rooms[2], created) {
		t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[2], created)
	}
	if got := readDataFile(t, dataDir); bytes.Contains(got, []byte("深夜飞行棋")) || bytes.Contains(got, []byte("半截房")) {
		t.Fatalf("被拒绝请求的内容不应写入本地文件，实际: %s", got)
	}
}

// 错误信息要保持稳定可辨：所有入口拒绝都返回同一条“请求体必须是单个 JSON 对象”，
// 与已有的字段校验错误（缺少字段 / 类型不符 / 房间名称不能为空）能明确区分。
func TestCreateRoomSingleObjectErrorIsDistinctFromFieldErrors(t *testing.T) {
	dataDir := t.TempDir()
	seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	// 入口错误。
	for _, body := range []string{"null", "[" + validRoomBody + "]", validRoomBody + "x"} {
		status, resp := postRoom(t, baseURL, body)
		if status != http.StatusBadRequest {
			t.Fatalf("状态码 = %d，期望 400（载荷: %q）", status, body)
		}
		if errMsg, _ := resp["error"].(string); errMsg != singleObjectErr {
			t.Fatalf("载荷 %q 的 error = %q，期望固定信息 %q", body, errMsg, singleObjectErr)
		}
	}

	// 字段级错误仍沿用各自原有的提示，入口规则的收紧不得改变这些既有行为。
	fieldCases := []struct {
		body    string
		wantSub string
	}{
		{`{"name":"缺时间房","game":"gomoku","capacity":2}`, "缺少必填字段"},
		{`{"name":"","game":"gomoku","capacity":2,"turnSeconds":0}`, "不能为空"},
		{`{"name":"字符串人数房","game":"gomoku","capacity":"2","turnSeconds":0}`, "整数"},
		{`{"name":"未知规则房","game":"chess","capacity":2,"turnSeconds":0}`, "游戏规则"},
	}
	for _, tc := range fieldCases {
		status, resp := postRoom(t, baseURL, tc.body)
		if status != http.StatusBadRequest {
			t.Fatalf("状态码 = %d，期望 400（载荷: %q，响应: %v）", status, tc.body, resp)
		}
		errMsg, _ := resp["error"].(string)
		if !strings.Contains(errMsg, tc.wantSub) {
			t.Fatalf("载荷 %q 的 error 应仍包含 %q，实际: %q", tc.body, tc.wantSub, errMsg)
		}
		if strings.Contains(errMsg, singleObjectErr) {
			t.Fatalf("载荷 %q 是单个对象，不应报入口格式错误，实际: %q", tc.body, errMsg)
		}
	}
}
