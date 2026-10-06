package main

import (
	"bytes"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// 本文件为创建公开房间补充“输入错误与房间数据错误互不混淆”的端到端回归：
// 用户提交的房间配置不合法时，必须先收到需要修改输入的原因（400），
// 即使服务当前保存的房间数据已经损坏（截断或整份为 null），也不能把这次提交
// 说成房间数据读取失败（500），更不能借拒绝创建的机会整理、补齐或替换损坏内容；
// 反过来，在同一份损坏数据上提交字段齐全、类型与取值均合法的配置时，才返回 500，
// 且原因落在已有房间数据的读取或解析上，而不是人数或时间输入错误。
// 本文件只钉住既有行为，沿用现有配置项与接口错误提示，不新增修复损坏数据的功能。

// 两份“只有一处无效、其余字段均合法”的五子棋配置：
// 前者名称与时间合法、唯独人数填成 4；后者名称、规则和人数合法、
// 唯独 turnSeconds 以字符串 "30" 提交。
const badCapacityGomokuBody = `{"name":"四人五子棋申请","game":"gomoku","capacity":4,"turnSeconds":30}`
const stringTurnGomokuBody = `{"name":"字符串时间五子棋","game":"gomoku","capacity":2,"turnSeconds":"30"}`

// 与损坏数据场景对照用的完全合法五子棋配置（字段齐全、类型与取值均合法）。
const validGomokuBody = `{"name":"合法配置五子棋","game":"gomoku","capacity":2,"turnSeconds":30}`

// dataScenarios 列出本地房间数据的三种状态：normal 为正常保存的已有房间
// （含附带字段），truncated 为被截断、不能构成完整数组的内容，
// nullTop 为整份保存内容是 JSON null。
var dataScenarios = []struct {
	id      string
	title   string
	corrupt bool
}{
	{"normal", "正常保存着已有房间的数据", false},
	{"truncated", "房间数据被截断、不能构成完整数组", true},
	{"nullTop", "整份保存内容为 null", true},
}

// seedDataScenario 按场景写入本地房间数据并返回写入的原始字节：
// normal 是两间带备注/数组/嵌套附带字段的正常房间；truncated 与
// main_test.go 中既有截断场景一致（前半段记录可辨、整体缺少收尾）；
// nullTop 直接写入 JSON null。
func seedDataScenario(t *testing.T, dataDir, scenario string) []byte {
	t.Helper()
	switch scenario {
	case "normal":
		return seedRooms(t, dataDir, seedRecord1, seedRecord2)
	case "truncated":
		return seedRaw(t, dataDir, "[\n"+seedRecord1+",\n"+seedRecord2+",\n{\"id\":\"seed-ga")
	case "nullTop":
		return seedRaw(t, dataDir, "null\n")
	default:
		t.Fatalf("未知数据场景: %q", scenario)
		return nil
	}
}

// assertInvalidCreateReportsInputError 断言一次配置不合法的创建请求被按“输入错误”
// 拒绝：返回 400；error 同时包含 wantParts 的全部片段、不包含 forbidParts 中任何
// 片段；不返回成功房间对象或新编号；本地文件在拒绝之后逐字保持提交前的内容。
func assertInvalidCreateReportsInputError(t *testing.T, baseURL, dataDir, scenario, body string, before []byte, wantParts, forbidParts []string) {
	t.Helper()
	status, resp := postRoom(t, baseURL, body)
	if status != http.StatusBadRequest {
		t.Fatalf("[%s] 无效配置应返回 400（输入原因优先于数据状态），实际 %d，响应: %v", scenario, status, resp)
	}
	errMsg, _ := resp["error"].(string)
	for _, part := range wantParts {
		if !strings.Contains(errMsg, part) {
			t.Fatalf("[%s] error 应包含 %q 以明确需要修改的输入，实际: %q", scenario, part, errMsg)
		}
	}
	for _, part := range forbidParts {
		if strings.Contains(errMsg, part) {
			t.Fatalf("[%s] error 不应包含 %q（输入原因不能被说成数据读取失败或缺字段等），实际: %q", scenario, part, errMsg)
		}
	}
	if _, ok := resp["id"]; ok {
		t.Fatalf("[%s] 被拒绝的请求不应返回成功房间或新编号，实际: %v", scenario, resp)
	}
	// 每次被拒绝后，本地原有内容都应逐字保持原样，损坏数据尤其不能被顺手整理。
	if got := readDataFile(t, dataDir); !bytes.Equal(got, before) {
		t.Fatalf("[%s] 拒绝创建后本地内容应逐字保持原样：\n得到: %s\n期望: %s", scenario, got, before)
	}
}

// 两种不同的无效配置，在正常数据与两种损坏数据下都必须先报输入原因：
// 五子棋 4 人返回 400 且明确说明五子棋固定为 2 人；turnSeconds 以字符串 "30"
// 提交返回 400 且明确说明 turnSeconds 必须是整数（不能先转成数字接受，
// 也不能说成缺少字段）。两份请求都不返回成功房间或新编号；每次拒绝后本地内容
// 逐字不变。损坏数据不会被解释成没有房间（随后的 GET 仍为 500），也不会因拒绝
// 创建而被整理、补齐或替换；正常数据中的房间数量、次序、配置与附带字段保持原样。
func TestCreateRoomReportsInputErrorBeforeDataError(t *testing.T) {
	for _, sc := range dataScenarios {
		t.Run(sc.title, func(t *testing.T) {
			dataDir := t.TempDir()
			before := seedDataScenario(t, dataDir, sc.id)
			baseURL := startServer(t, dataDir)

			// 无效配置一：名称与时间都合法，但五子棋人数填成 4。
			assertInvalidCreateReportsInputError(t, baseURL, dataDir, sc.id,
				badCapacityGomokuBody, before,
				[]string{"五子棋", "2"},
				[]string{"turnSeconds", "整数", "时间", "房间数据", "读取", "缺少必填字段"},
			)

			// 无效配置二：名称、规则和人数都合法，但每步时间以字符串 "30" 提交。
			assertInvalidCreateReportsInputError(t, baseURL, dataDir, sc.id,
				stringTurnGomokuBody, before,
				[]string{"turnSeconds", "整数"},
				[]string{"capacity", "人数", "房间数据", "读取", "缺少必填字段"},
			)

			if sc.corrupt {
				// 损坏内容不能被解释成“没有房间”，也没有在拒绝创建后被整理/补齐/替换：
				// 两次拒绝之后 GET 仍按既有约定返回 500，且不返回成功的房间列表。
				getStatus, getBody := getRoomsResponse(t, baseURL)
				if getStatus != http.StatusInternalServerError {
					t.Fatalf("[%s] 损坏数据上的 GET 应返回 500，实际 %d，响应: %v", sc.id, getStatus, getBody)
				}
				getErr, _ := getBody["error"].(string)
				if !strings.Contains(getErr, "房间数据") {
					t.Fatalf("[%s] GET 的 error 应指向房间数据的读取或解析，实际: %q", sc.id, getErr)
				}
				if _, ok := getBody["rooms"]; ok {
					t.Fatalf("[%s] 损坏数据不能被解释成空房间列表，实际: %v", sc.id, getBody)
				}
			} else {
				// 正常数据：房间数量、次序、配置与附带字段全部保留，不留下两次被拒请求的记录。
				assertRoomsUnchanged(t, baseURL, dataDir, before)
			}

			// 全部请求结束后，本地内容仍与提交前逐字一致。
			if got := readDataFile(t, dataDir); !bytes.Equal(got, before) {
				t.Fatalf("[%s] 全部请求结束后本地内容应逐字保持原样：\n得到: %s\n期望: %s", sc.id, got, before)
			}
		})
	}
}

// 在相同的损坏数据条件下，再提交字段齐全、类型和取值均合法的五子棋配置，
// 应返回 500，error 指向已有房间数据的读取或解析，而不是人数或时间输入错误；
// 不返回成功编号或成功房间，保存内容逐字保持原样。
func TestCreateRoomValidConfigOnCorruptDataReportsDataError(t *testing.T) {
	for _, sc := range dataScenarios {
		if !sc.corrupt {
			continue
		}
		t.Run(sc.title, func(t *testing.T) {
			dataDir := t.TempDir()
			before := seedDataScenario(t, dataDir, sc.id)
			baseURL := startServer(t, dataDir)

			status, resp := postRoom(t, baseURL, validGomokuBody)
			if status != http.StatusInternalServerError {
				t.Fatalf("[%s] 合法配置在损坏数据上应返回 500，实际 %d，响应: %v", sc.id, status, resp)
			}
			errMsg, _ := resp["error"].(string)
			if !strings.Contains(errMsg, "房间数据") {
				t.Fatalf("[%s] error 应指向已有房间数据的读取或解析，实际: %q", sc.id, errMsg)
			}
			// 合法配置不应再收到人数或时间方面的输入提示，也不能被说成缺字段。
			for _, part := range []string{"turnSeconds", "整数", "人数", "五子棋", "capacity", "缺少必填字段"} {
				if strings.Contains(errMsg, part) {
					t.Fatalf("[%s] 数据读取失败的 error 不应包含输入错误片段 %q，实际: %q", sc.id, part, errMsg)
				}
			}
			if _, ok := resp["id"]; ok {
				t.Fatalf("[%s] 数据错误时不应返回成功编号或成功房间，实际: %v", sc.id, resp)
			}
			if _, ok := resp["rooms"]; ok {
				t.Fatalf("[%s] 数据错误时不应返回房间列表，实际: %v", sc.id, resp)
			}

			// 损坏内容原样保留：不修复、不重置为空数组、不追加本次提交。
			if got := readDataFile(t, dataDir); !bytes.Equal(got, before) {
				t.Fatalf("[%s] 数据错误后本地内容应逐字保持原样：\n得到: %s\n期望: %s", sc.id, got, before)
			}
		})
	}
}

// 对照：正常保存的已有房间数据上，同一份合法配置继续按现有约定返回 201，
// 新房间只追加在已有记录之后，提交的规则、人数和时间与返回记录一致，
// 旧记录的数量、次序、配置与附带字段保持不变。
func TestCreateRoomValidConfigAppendsOnHealthyData(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	status, created := postRoom(t, baseURL, validGomokuBody)
	if status != http.StatusCreated {
		t.Fatalf("正常数据上合法配置应返回 201，实际 %d，响应: %v", status, created)
	}
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatal("新房间编号为空")
	}
	if id == "seed-alpha" || id == "seed-beta" {
		t.Fatalf("新房间编号 %q 与已有编号重复", id)
	}
	if got := created["name"]; got != "合法配置五子棋" {
		t.Fatalf("名称 = %v，期望 %q", got, "合法配置五子棋")
	}
	if got := created["game"]; got != "gomoku" {
		t.Fatalf("规则 = %v，期望与提交一致的 gomoku", got)
	}
	if got := created["capacity"]; got != float64(2) {
		t.Fatalf("人数 = %v，期望与提交一致的 2", got)
	}
	if got := created["turnSeconds"]; got != float64(30) {
		t.Fatalf("每步时间 = %v，期望与提交一致的 30", got)
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
		t.Fatalf("房间数量 = %d，期望 3（原有 2 条 + 新增 1 条，新房间只能追加）", len(rooms))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
		t.Fatalf("原有房间的数量、次序、配置或附带字段被改变：\n得到: %v\n期望: %v", rooms[:2], want)
	}
	if !reflect.DeepEqual(rooms[2], created) {
		t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[2], created)
	}
}
