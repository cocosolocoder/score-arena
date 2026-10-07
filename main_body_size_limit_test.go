package main

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

// 本文件回归 POST /api/rooms 对请求正文大小的既有上限：超过 1 MiB
// （1,048,576 字节）的正文必须被拒绝。正文大小按实际发送的字节计算，
// 中文、表情、JSON 转义写法以及空白都属于正文内容，不能以字符数或整理后的
// 名称长度代替请求大小。恰好 1 MiB 的合法提交照常创建；超过上限时即使整份
// 内容是单个完整的 JSON 对象、配置完全合法，也必须返回 400 且说明读取请求体
// 失败、正文过大——不能先保存房间再报告失败，也不能把被截短的内容当成一次
// 合法创建。被拒绝前后已有房间与本地保存内容保持原样，随后正常提交仍可创建。
//
// 与 main_test.go 一样以子进程方式运行真实服务，不改动任何现有代码。

// bodyLimit 是创建接口的正文上限，与 handleCreateRoom 中的 1<<20 一致。
const bodyLimit = 1 << 20

// exactOneMiBBody 构造一份恰好 1 MiB 的合法创建请求：名称含中文、以 JSON
// 转义写法给出的表情以及内部空格，首尾留待服务端去掉的空白；其余字节用
// 尾部空白补齐——空白同样是正文内容，必须计入 1 MiB 上限。
func exactOneMiBBody(t *testing.T) string {
	t.Helper()
	// \ud83d\ude00 是 😀 的 JSON 转义写法；名称去掉首尾空白后为“深夜 五子棋😀友谊赛”。
	base := `{"name":"  深夜 五子棋\ud83d\ude00友谊赛  ","game":"ludo","capacity":3,"turnSeconds":60}`
	if len(base) > bodyLimit {
		t.Fatalf("基础正文长度 %d 已超过 1 MiB，无法构造边界正文", len(base))
	}
	body := base + strings.Repeat(" ", bodyLimit-len(base))
	if got := len(body); got != bodyLimit {
		t.Fatalf("构造的正文长度 = %d 字节，期望恰好 %d", got, bodyLimit)
	}
	return body
}

// 正文恰好为 1 MiB、名称去掉首尾空白后符合要求且规则、人数、每步时间均合法时，
// 应返回 201 并生成非空的新编号；名称仍只整理首尾空白，内部文字与表情保留，
// 人数、时间、未开始状态和公开范围沿用已有创建行为，不因正文较大而缺字段或
// 串用配置；房间列表能查到与返回结果一致的一条新房间，本地保存与列表一致。
func TestCreateRoomAcceptsExactlyOneMiBBody(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	status, created := postRoom(t, baseURL, exactOneMiBBody(t))
	if status != http.StatusCreated {
		t.Fatalf("恰好 1 MiB 的合法创建状态码 = %d，期望 201，响应: %v", status, created)
	}

	id, _ := created["id"].(string)
	if id == "" {
		t.Fatal("恰好 1 MiB 创建的新房间编号为空")
	}
	if id == "seed-alpha" || id == "seed-beta" {
		t.Fatalf("新房间编号 %q 与已有编号重复", id)
	}
	// 名称仍只整理首尾空白：JSON 转义的表情解出后与内部空格一起保留。
	if got, want := created["name"], "深夜 五子棋😀友谊赛"; got != want {
		t.Fatalf("名称 = %q，期望 %q（仅去掉首尾空白，内部文字与表情保留）", got, want)
	}
	if got := created["game"]; got != "ludo" {
		t.Fatalf("规则 = %v，期望 ludo（正文较大不得串用配置）", got)
	}
	if got := created["capacity"]; got != float64(3) {
		t.Fatalf("人数 = %v，期望 3（按提交值保存）", got)
	}
	if got := created["turnSeconds"]; got != float64(60) {
		t.Fatalf("每步时间 = %v，期望 60（按提交值保存）", got)
	}
	if got := created["status"]; got != "waiting" {
		t.Fatalf("状态 = %v，期望 waiting（未开始）", got)
	}
	if got := created["visibility"]; got != "public" {
		t.Fatalf("公开范围 = %v，期望 public", got)
	}
	createdAt, _ := created["createdAt"].(string)
	if _, err := time.Parse(time.RFC3339, createdAt); err != nil {
		t.Fatalf("创建时间 %q 不是有效的 RFC3339 时间（大正文不得缺字段）: %v", createdAt, err)
	}

	// 房间列表：原有 2 条之后追加与创建响应一致的一条新房间。
	listStatus, rooms := getRooms(t, baseURL)
	if listStatus != http.StatusOK {
		t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
	}
	if len(rooms) != 3 {
		t.Fatalf("房间数量 = %d，期望 3（原有 2 条 + 新增 1 条）", len(rooms))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间被改写或重新排序：\n得到: %v\n期望: %v", rooms[:2], want)
	}
	if !reflect.DeepEqual(rooms[2], created) {
		t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[2], created)
	}

	// 本地保存内容与列表一致，大正文创建的记录完整落盘。
	if saved := decodeRecords(t, readDataFile(t, dataDir)); !reflect.DeepEqual(saved, rooms) {
		t.Fatalf("本地保存记录与房间列表不一致：\n文件: %v\n列表: %v", saved, rooms)
	}
}

// 正文超过 1 MiB 时必须返回 400：即使整份内容是单个完整的 JSON 对象、配置
// 完全合法，只是后续空白让整份正文超限，也不能先保存房间再报告失败；多字节
// 文字按字符数看似未超限、实际字节数已超限的正文同样被拒绝。error 说明读取
// 请求体失败且正文过大，与缺少字段、名称过长等配置错误可区分，也不能说成
// 已有房间数据损坏。被拒绝前已有房间的数量、次序、编号、配置与附带字段保持
// 原样，本地文件逐字节不变；随后正常提交仍可创建，被拒绝的那份不出现。
func TestCreateRoomRejectsBodyOverOneMiB(t *testing.T) {
	// 字段齐全、类型和取值均合法的完整配置对象：即使它在正文中已经完整出现，
	// 只要整份正文超限就必须整体拒绝，不能截短后当成一次合法创建。
	validObject := `{"name":"超限正文房","game":"gomoku","capacity":2,"turnSeconds":30}`

	cases := []struct {
		name string
		body func(t *testing.T) string
	}{
		{
			name: "完整合法对象后的空白让正文超限",
			body: func(t *testing.T) string {
				// 合法对象已经完整出现，仅尾部空白让整份正文超出上限 1 字节。
				body := validObject + strings.Repeat(" ", bodyLimit-len(validObject)+1)
				if got := len(body); got != bodyLimit+1 {
					t.Fatalf("构造的正文长度 = %d 字节，期望 %d", got, bodyLimit+1)
				}
				return body
			},
		},
		{
			name: "多字节文字字符数未超限但字节数超限",
			body: func(t *testing.T) string {
				// 40 万个中文字符：字符数远小于 1 MiB，UTF-8 字节数约 1.2 MiB。
				// 正文大小按字节计算，这份正文必须被拒绝。
				body := `{"name":"多字节正文房","game":"ludo","capacity":3,"turnSeconds":60,"note":"` +
					strings.Repeat("棋", 400000) + `"}`
				if got := len(body); got <= bodyLimit {
					t.Fatalf("构造的正文字节数 = %d，应超过 %d", got, bodyLimit)
				}
				if got := len([]rune(body)); got >= bodyLimit {
					t.Fatalf("构造的正文字符数 = %d，应小于 %d（按字符数看似未超限）", got, bodyLimit)
				}
				return body
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dataDir := t.TempDir()
			seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
			baseURL := startServer(t, dataDir)

			status, rejected := postRoom(t, baseURL, tc.body(t))
			if status != http.StatusBadRequest {
				t.Fatalf("超限正文状态码 = %d，期望 400，响应: %v", status, rejected)
			}
			errMsg, _ := rejected["error"].(string)
			for _, part := range []string{"读取请求体失败", "too large"} {
				if !strings.Contains(errMsg, part) {
					t.Fatalf("error 应包含 %q 以说明读取请求体失败且正文过大，实际: %q", part, errMsg)
				}
			}
			// 与缺少字段、名称过长等配置错误保持可区分，
			// 也不能把这次拒绝说成已有房间数据损坏。
			for _, part := range []string{"缺少必填字段", "不能为空", "超过 40", "房间数据", "名称", "turnSeconds", "capacity"} {
				if strings.Contains(errMsg, part) {
					t.Fatalf("error 不应包含 %q（不能与配置错误或数据损坏混淆），实际: %q", part, errMsg)
				}
			}
			if _, ok := rejected["id"]; ok {
				t.Fatalf("被拒绝的超限请求不应返回成功房间或新编号，实际: %v", rejected)
			}

			// 已有房间的数量、相对次序、编号、配置和附带字段保持原样，
			// 本地保存内容逐字节不变，不留下半条新记录。
			assertRoomsUnchanged(t, baseURL, dataDir, seed)

			// 超限请求处理完后，正常提交大小与配置均合法的正文仍可创建。
			status, created := postRoom(t, baseURL, `{"name":"超限后正常房","game":"gomoku","capacity":2,"turnSeconds":30}`)
			if status != http.StatusCreated {
				t.Fatalf("超限拒绝后正常创建状态码 = %d，期望 201，响应: %v", status, created)
			}
			if id, _ := created["id"].(string); id == "" {
				t.Fatal("超限拒绝后正常创建的新房间编号为空")
			}

			listStatus, rooms := getRooms(t, baseURL)
			if listStatus != http.StatusOK {
				t.Fatalf("GET /api/rooms 状态码 = %d，期望 200", listStatus)
			}
			if len(rooms) != 3 {
				t.Fatalf("房间数量 = %d，期望 3（种子 2 条 + 正常创建 1 条，被拒正文不得留记录）", len(rooms))
			}
			if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
				t.Fatalf("已有房间被改写或重新排序：\n得到: %v\n期望: %v", rooms[:2], want)
			}
			if !reflect.DeepEqual(rooms[2], created) {
				t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[2], created)
			}
			// 被拒绝的那份不会随后出现在列表中。
			for _, record := range rooms {
				room, _ := record.(map[string]any)
				if room["name"] == "超限正文房" || room["name"] == "多字节正文房" {
					t.Fatalf("被拒绝的超限请求不应留下任何记录，实际: %v", room)
				}
			}
			if saved := decodeRecords(t, readDataFile(t, dataDir)); !reflect.DeepEqual(saved, rooms) {
				t.Fatalf("本地保存记录与房间列表不一致：\n文件: %v\n列表: %v", saved, rooms)
			}
		})
	}
}
