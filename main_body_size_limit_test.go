package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// 本文件围绕 POST /api/rooms 既有的请求体大小限制（1 MiB = 1,048,576 字节）做端到端回归。
// 正文大小一律按实际发送的字节计算：JSON 空白、中文与表情的多字节编码、字符串里的转义
// 写法都属于正文内容，不能用字符数或整理后的名称长度代替请求大小。正文恰好为 1 MiB 且
// 配置合法时必须照常创建；超过哪怕一个字节——即使整份内容是一个完整合法的 JSON 对象、
// 合法对象后面只是多了空白——也必须在读取请求体阶段返回 400，不能先保存房间再报告失败，
// 更不能把读到的截断内容当成一次合法创建。失败提示固定说明读取请求体失败且正文过大，
// 与缺少字段、名称过长等配置错误以及已有房间数据损坏（500）都能区分开。
//
// 与 main_test.go 一样以子进程方式运行真实服务，不改动任何现有代码。

const maxBodyBytes = 1 << 20 // 1 MiB：与 handleCreateRoom 中 MaxBytesReader 的上限一致

// postRoomRaw 以原始字节提交创建请求（请求大小按字节计），返回状态码与解码后的响应体。
func postRoomRaw(t *testing.T, baseURL string, body []byte) (int, map[string]any) {
	t.Helper()
	resp, err := httpClient.Post(baseURL+"/api/rooms", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /api/rooms 失败: %v（正文 %d 字节）", err, len(body))
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

// buildExactLimitBody 用 JSON 合法空白把一份配置合法的房间对象补齐到恰好 size 个字节：
// 填充空白全部放在对象之前，名称自带首尾空白（去掉后仍合法），名称内部含中文、表情与
// 经 JSON 转义的引号，用以证明空白、多字节文字和转义写法都按字节计入正文。
func buildExactLimitBody(t *testing.T, size int) string {
	t.Helper()
	// 整理后的名称只有 12 个码点左右，远小于 40 码点上限；大小只能由实际字节决定。
	obj, err := json.Marshal(map[string]any{
		"name": "  边界 \"决胜\" 😀 对局  ", "game": "gomoku",
		"capacity": 2, "turnSeconds": 0,
	})
	if err != nil {
		t.Fatalf("构造边界对象失败: %v", err)
	}
	pad := size - len(obj)
	if pad < 0 {
		t.Fatalf("基础对象已有 %d 字节，无法填充到 %d 字节", len(obj), size)
	}
	body := strings.Repeat(" ", pad) + string(obj)
	if len(body) != size {
		t.Fatalf("构造的正文 = %d 字节，期望恰好 %d", len(body), size)
	}
	var probe map[string]any
	if err := json.Unmarshal([]byte(body), &probe); err != nil {
		t.Fatalf("构造的边界正文不是合法 JSON 对象: %v", err)
	}
	return body
}

// buildMultibyteOversizeBody 构造一份“按字符数看似未超限、按字节数已超限”的正文：
// 用 3 字节的中文“中”填充一个被业务忽略的额外字段，让总字节数略超 1 MiB，
// 而总码点数远低于 1 MiB；整份内容仍是单个完整合法的 JSON 对象，房间配置也合法。
func buildMultibyteOversizeBody(t *testing.T) (body string, runeCount int) {
	t.Helper()
	const prefix = `{"name":"多字节超大房😀对局","game":"gomoku","capacity":2,"turnSeconds":0,"_pad":"`
	const suffix = `"}`
	need := maxBodyBytes - len(prefix) - len(suffix)
	if need < 0 {
		t.Fatalf("基础前缀已超过上限: %d", len(prefix)+len(suffix))
	}
	// “中”每个码点占 3 字节；向上多取一个，保证实际字节数超限而码点数不超限。
	filler := strings.Repeat("中", need/3+1)
	body = prefix + filler + suffix
	if !utf8.ValidString(body) {
		t.Fatal("构造的多字节正文不是合法 UTF-8")
	}
	var probe map[string]any
	if err := json.Unmarshal([]byte(body), &probe); err != nil {
		t.Fatalf("构造的多字节正文不是合法 JSON 对象: %v", err)
	}
	if len(body) <= maxBodyBytes {
		t.Fatalf("构造的多字节正文未超过字节上限: %d 字节", len(body))
	}
	runeCount = utf8.RuneCountInString(body)
	if runeCount >= maxBodyBytes {
		t.Fatalf("构造的多字节正文字符数也已超限: %d 码点 / %d 字节", runeCount, len(body))
	}
	return body, runeCount
}

// assertOversizeRejected 断言一次正文超限的提交：返回 400、error 同时说明读取请求体
// 失败与正文过大，且不能被说成字段级配置错误或已有房间数据损坏；不返回成功房间或新
// 编号；已有房间的数量、相对次序、编号、配置与附带字段保持原样，本地文件不被改写、
// 不留半条新记录。
func assertOversizeRejected(t *testing.T, baseURL, dataDir string, seed, body []byte) {
	t.Helper()
	if len(body) <= maxBodyBytes {
		t.Fatalf("用例正文只有 %d 字节，必须先超过 %d 才能验证超限拒绝", len(body), maxBodyBytes)
	}
	status, resp := postRoomRaw(t, baseURL, body)
	if status != http.StatusBadRequest {
		t.Fatalf("超过 1 MiB 的正文状态码 = %d，期望 400（正文 %d 字节，响应: %v）", status, len(body), resp)
	}
	errMsg, _ := resp["error"].(string)
	for _, part := range []string{"读取请求体失败", "too large"} {
		if !strings.Contains(errMsg, part) {
			t.Fatalf("error 应包含 %q 以说明读取请求体失败且正文过大，实际: %q（正文 %d 字节）", part, errMsg, len(body))
		}
	}
	// 必须与缺少字段、名称过长等配置错误以及已有房间数据损坏保持可区分。
	for _, part := range []string{"缺少必填字段", "名称", "字符", "房间数据"} {
		if strings.Contains(errMsg, part) {
			t.Fatalf("正文超限的 error 不应包含 %q（不能与配置错误或已有房间数据损坏混淆），实际: %q", part, errMsg)
		}
	}
	if _, ok := resp["id"]; ok {
		t.Fatalf("正文超限不应返回成功房间或新编号，实际: %v", resp)
	}
	if _, ok := resp["name"]; ok {
		t.Fatalf("正文超限不应返回已保存房间的内容，实际: %v", resp)
	}
	// 数量、次序、编号、配置、附带字段与本地文件全部保持原样。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// 正文恰好为 1 MiB（1,048,576 字节）、名称去掉首尾空白后合法、规则人数时间也合法时，
// 必须返回 201 并生成非空新编号；名称仍只整理首尾空白（内部文字、表情与转义引号
// 解码后保留），人数、时间、未开始状态与公开范围沿用既有创建行为，不因正文大而缺字段；
// 房间列表能查到与返回结果逐字一致的一条新房间，追加在已有记录之后。
func TestCreateRoomAcceptsBodyExactlyOneMiB(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	body := buildExactLimitBody(t, maxBodyBytes)
	if len(body) != maxBodyBytes {
		t.Fatalf("正文 = %d 字节，期望恰好 1 MiB（%d）", len(body), maxBodyBytes)
	}

	status, created := postRoomRaw(t, baseURL, []byte(body))
	if status != http.StatusCreated {
		t.Fatalf("恰好 1 MiB 的合法正文创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatal("新房间编号为空")
	}
	if id == "seed-alpha" || id == "seed-beta" {
		t.Fatalf("新房间编号 %q 与已有编号重复", id)
	}
	// 名称只去掉首尾空白：内部空格、中文、表情保留，JSON 转义引号解码为普通引号。
	if got, want := created["name"], `边界 "决胜" 😀 对局`; got != want {
		t.Fatalf("名称 = %v，期望 %q（仅去首尾空白，内部文字与表情保留）", got, want)
	}
	if got := created["game"]; got != "gomoku" {
		t.Fatalf("规则 = %v，期望 gomoku（不能因正文较大串用配置）", got)
	}
	if got := created["capacity"]; got != float64(2) {
		t.Fatalf("人数 = %v，期望 2", got)
	}
	if got := created["turnSeconds"]; got != float64(0) {
		t.Fatalf("每步时间 = %v，期望 0（不限时）", got)
	}
	if got := created["status"]; got != "waiting" {
		t.Fatalf("状态 = %v，期望 waiting（未开始）", got)
	}
	if got := created["visibility"]; got != "public" {
		t.Fatalf("公开范围 = %v，期望 public", got)
	}
	createdAt, _ := created["createdAt"].(string)
	if _, err := time.Parse(time.RFC3339, createdAt); err != nil {
		t.Fatalf("创建时间 %q 不是有效的 RFC3339 时间: %v", createdAt, err)
	}

	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if len(rooms) != 3 {
		t.Fatalf("房间数量 = %d，期望 3（原有 2 条 + 恰好 1 MiB 的新 1 条）", len(rooms))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间被改写或重新排序：\n得到: %v\n期望: %v", rooms[:2], want)
	}
	if !reflect.DeepEqual(rooms[2], created) {
		t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[2], created)
	}

	// 本地保存内容与列表一致，新记录确实落盘，且不缺 status/visibility 等字段。
	saved := decodeRecords(t, readDataFile(t, dataDir))
	if !reflect.DeepEqual(saved, rooms) {
		t.Fatalf("本地保存记录与房间列表不一致：\n文件: %v\n列表: %v", saved, rooms)
	}
}

// 正文超过上限时一律 400：即使整份内容是单个完整合法的 JSON 对象、配置完全合法，
// 甚至合法对象已经完整出现、只是后续空白把整份正文推过上限，也不能先保存房间再报告
// 失败；按字符数看似未超限、实际字节数已超限的多字节正文同样拒绝。已有房间与本地
// 文件保持原样，被截短读到的内容不能被当成一次合法创建。
func TestCreateRoomRejectsBodyLargerThanOneMiB(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	// 已知恰好 1 MiB 时可以成功的完整合法对象（见上一用例），在其后只加空白即可超限。
	exact := buildExactLimitBody(t, maxBodyBytes)
	multi, multiRunes := buildMultibyteOversizeBody(t)
	t.Logf("多字节正文：%d 字节 / %d 个码点——字符数远低于上限，字节数已超过 %d",
		len(multi), multiRunes, maxBodyBytes)

	cases := []struct {
		desc  string
		body  []byte
		runes int // 正文中的码点数；-1 表示本用例不强调字符数
	}{
		{"完整合法对象之后多 1 个空格", []byte(exact + " "), -1},
		{"完整合法对象之后是空白组合（空格/制表/CRLF）", []byte(exact + " \t\r\n "), -1},
		{"合法对象后接五个空格", []byte(exact + "     "), -1},
		{"多字节填充：字符数未超限、字节数超限", []byte(multi), multiRunes},
	}

	for _, tc := range cases {
		t.Run(tc.desc, func(t *testing.T) {
			if tc.runes >= 0 && tc.runes >= maxBodyBytes {
				t.Fatalf("用例前提不成立：字符数 %d 已达到上限，无法体现多字节影响", tc.runes)
			}
			if len(tc.body) <= maxBodyBytes {
				t.Fatalf("用例前提不成立：正文只有 %d 字节", len(tc.body))
			}
			assertOversizeRejected(t, baseURL, dataDir, seed, tc.body)
		})
	}

	// 明确验证“不能先保存再报错”：所有超限请求结束后仍只有种子的 2 条记录，
	// 合法对象虽然在第 1 MiB 处已经完整出现，也没有抢先落盘。
	status, rooms := getRooms(t, baseURL)
	if status != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", status)
	}
	if len(rooms) != 2 {
		t.Fatalf("房间数量 = %d，期望 2：超限正文必须整体拒绝，不能先保存合法对象再报错", len(rooms))
	}
	for _, record := range rooms {
		room, _ := record.(map[string]any)
		switch room["name"] {
		case `边界 "决胜" 😀 对局`, "多字节超大房😀对局":
			t.Fatalf("被超限请求拒绝的房间 %q 仍被保存，说明先写入后报错或截断内容被当成合法创建: %v",
				room["name"], record)
		}
	}
	// 本地文件中同样不能出现被拒内容，也不允许留下只有部分字段的半条记录痕迹。
	raw := readDataFile(t, dataDir)
	if bytes.Contains(raw, []byte("决胜")) || bytes.Contains(raw, []byte("多字节超大房")) || bytes.Contains(raw, []byte("_pad")) {
		t.Fatalf("超限请求的内容被写入本地文件：\n%s", raw)
	}
}

// 超限请求处理完后，再提交一份大小和配置都合法的正文，仍可正常创建并在列表中查到；
// 被拒绝的那两份（尾随空白超限、多字节超限）不会随后出现，已有记录保持原样。
func TestCreateRoomRecoversAfterOversizedBody(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	exact := buildExactLimitBody(t, maxBodyBytes)
	multi, _ := buildMultibyteOversizeBody(t)

	assertOversizeRejected(t, baseURL, dataDir, seed, []byte(exact+" "))
	assertOversizeRejected(t, baseURL, dataDir, seed, []byte(exact+" \t\r\n "))
	assertOversizeRejected(t, baseURL, dataDir, seed, []byte(multi))

	// 被连续拒绝后，已有房间数量、次序、编号、配置与附带字段仍与创建前一致。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)

	// 再正常提交一份大小与配置均合法的正文：照常创建。
	status, created := postRoom(t, baseURL, `{"name":"恢复正常的飞行棋","game":"ludo","capacity":3,"turnSeconds":30}`)
	if status != http.StatusCreated {
		t.Fatalf("超限拒绝后正常创建状态码 = %d，期望 201，响应: %v", status, created)
	}
	id, _ := created["id"].(string)
	if id == "" || id == "seed-alpha" || id == "seed-beta" {
		t.Fatalf("新房间编号异常: %q", id)
	}
	if got, want := created["name"], "恢复正常的飞行棋"; got != want {
		t.Fatalf("名称 = %v，期望 %q", got, want)
	}
	if got := created["game"]; got != "ludo" {
		t.Fatalf("规则 = %v，期望 ludo", got)
	}
	if got := created["capacity"]; got != float64(3) {
		t.Fatalf("人数 = %v，期望 3", got)
	}
	if got := created["turnSeconds"]; got != float64(30) {
		t.Fatalf("每步时间 = %v，期望 30", got)
	}
	if got := created["status"]; got != "waiting" {
		t.Fatalf("状态 = %v，期望 waiting", got)
	}
	if got := created["visibility"]; got != "public" {
		t.Fatalf("公开范围 = %v，期望 public", got)
	}

	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if len(rooms) != 3 {
		t.Fatalf("房间数量 = %d，期望 3（种子 2 条 + 恢复后 1 条，被拒正文不得留记录）", len(rooms))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间的数量、次序、编号、配置或附带字段被改动：\n得到: %v\n期望: %v", rooms[:2], want)
	}
	if !reflect.DeepEqual(rooms[2], created) {
		t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[2], created)
	}

	// 被拒绝的两份内容不会随后出现在本地保存中。
	raw := readDataFile(t, dataDir)
	if bytes.Contains(raw, []byte("决胜")) || bytes.Contains(raw, []byte("多字节超大房")) || bytes.Contains(raw, []byte("_pad")) {
		t.Fatalf("此前超限请求的内容出现在本地文件中：\n%s", raw)
	}
}
