package main

import (
	"bytes"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// 本文件回归“创建请求的输入错误与数据错误不会混淆”这一既有约定：
// 用户提交的房间配置不合法时，必须先收到需要修改输入的具体原因（400），
// 即使服务当前保存的房间数据已经损坏（被截断、或整份内容为 null），
// 也不能把这次提交说成数据读取失败（500）；反过来，配置完全合法而数据
// 损坏时必须返回 500 且原因落在已有房间数据的读取或解析上，不能算到
// 人数或时间输入头上。无论哪种拒绝，本地原有内容都逐字节保持原样，
// 损坏数据不能被解释成没有房间，更不能因拒绝创建而被整理、补齐或替换。
//
// 与 main_test.go 一样以子进程方式运行真实服务，不改动任何现有代码。

// 重点保护的两份无效配置：其余字段全部合法，收到的错误原因必须对应本次错误。
const (
	// 名称与时间合法，但五子棋的人数填成 4（五子棋固定为 2 人）。
	invalidCapacityBody = `{"name":"深夜五子棋对局","game":"gomoku","capacity":4,"turnSeconds":30}`
	// 名称、规则和人数合法，但每步时间以字符串 "30" 提交（必须先拒绝，
	// 不能先转换成数字 30 再接受，也不能说成缺少字段）。
	invalidTurnSecondsBody = `{"name":"字符串时间五子棋","game":"gomoku","capacity":2,"turnSeconds":"30"}`
	// 字段齐全、类型和取值均合法的五子棋配置，用于对照数据错误。
	validGomokuBody = `{"name":"合法五子棋对局","game":"gomoku","capacity":2,"turnSeconds":30}`
)

// assertInputErrorRejection 断言一次创建提交被按输入错误拒绝：
// 状态码 400、error 同时包含 wantParts 且不含任何 notParts、不返回成功房间或新编号；
// 拒绝后本地文件与 seed 逐字节一致（不被整理、补齐或替换）。
func assertInputErrorRejection(t *testing.T, baseURL, dataDir string, seed []byte, body string, wantParts, notParts []string) {
	t.Helper()

	status, resp := postRoom(t, baseURL, body)
	if status != http.StatusBadRequest {
		t.Fatalf("无效配置状态码 = %d，期望 400（输入错误优先于数据错误），响应: %v", status, resp)
	}
	errMsg, _ := resp["error"].(string)
	for _, part := range wantParts {
		if !strings.Contains(errMsg, part) {
			t.Fatalf("error 应包含 %q 以说明需要修改输入的原因，实际: %q", part, errMsg)
		}
	}
	for _, part := range notParts {
		if strings.Contains(errMsg, part) {
			t.Fatalf("error 不应包含 %q（不能把本次提交说成数据读取失败或归到无关字段），实际: %q", part, errMsg)
		}
	}
	if _, ok := resp["id"]; ok {
		t.Fatalf("被拒绝的请求不应返回成功房间或新编号，实际: %v", resp)
	}

	// 每次被拒绝后，本地原有内容逐字保持原样。
	if got := readDataFile(t, dataDir); !bytes.Equal(got, seed) {
		t.Fatalf("拒绝创建改写了本地内容：\n得到: %s\n期望: %s", got, seed)
	}
}

// 同两份无效配置，分别作用于正常保存的已有房间、被截断的房间数据、
// 整份为 null 的保存内容：结果都必须是 400 输入错误而不是 500 数据错误。
func TestInvalidCreateConfigStaysInputErrorOnAnyData(t *testing.T) {
	states := []struct {
		name   string
		seed   func(t *testing.T, dataDir string) []byte
		normal bool // 数据可正常读取时，还要验证已有记录保留与合法创建照常追加
	}{
		{
			name: "正常保存着已有房间",
			seed: func(t *testing.T, dataDir string) []byte {
				return seedRooms(t, dataDir, seedRecord1, seedRecord2)
			},
			normal: true,
		},
		{
			name: "房间数据被截断",
			seed: func(t *testing.T, dataDir string) []byte {
				// 前半段能辨认出已有房间，但整体缺少收尾，不能构成完整数组。
				return seedRaw(t, dataDir, "[\n"+seedRecord1+",\n"+seedRecord2+",\n{\"id\":\"seed-ga")
			},
		},
		{
			name: "整份保存内容为 null",
			seed: func(t *testing.T, dataDir string) []byte {
				return seedRaw(t, dataDir, "null\n")
			},
		},
	}

	for _, st := range states {
		t.Run(st.name, func(t *testing.T) {
			dataDir := t.TempDir()
			seed := st.seed(t, dataDir)
			baseURL := startServer(t, dataDir)

			// 五子棋人数填成 4：400，原因明确说明五子棋固定为 2 人；
			// 名称与时间合法，错误不能落在无关字段或房间数据上。
			assertInputErrorRejection(t, baseURL, dataDir, seed, invalidCapacityBody,
				[]string{"五子棋", "2"},
				[]string{"房间数据", "读取", "名称", "时间", "turnSeconds"})

			// 每步时间以字符串 "30" 提交：400，原因明确说明 turnSeconds 必须是整数；
			// 不能先转换成数字再接受，也不能说成缺少字段或数据读取失败。
			assertInputErrorRejection(t, baseURL, dataDir, seed, invalidTurnSecondsBody,
				[]string{"turnSeconds", "整数"},
				[]string{"房间数据", "读取", "缺少", "名称", "人数", "capacity"})

			if st.normal {
				// 正常数据：两次拒绝后已有房间的数量、次序、配置和附带字段保留。
				assertRoomsUnchanged(t, baseURL, dataDir, seed)

				// 合法配置继续按现有约定返回 201，新房间只追加在已有记录之后。
				status, created := postRoom(t, baseURL, validGomokuBody)
				if status != http.StatusCreated {
					t.Fatalf("合法配置创建状态码 = %d，期望 201，响应: %v", status, created)
				}
				id, _ := created["id"].(string)
				if id == "" {
					t.Fatal("合法创建的新房间编号为空")
				}
				if id == "seed-alpha" || id == "seed-beta" {
					t.Fatalf("新房间编号 %q 与已有编号重复", id)
				}
				// 提交的规则、人数和时间与返回记录一致。
				if got := created["game"]; got != "gomoku" {
					t.Fatalf("返回记录的规则 = %v，期望 gomoku", got)
				}
				if got := created["capacity"]; got != float64(2) {
					t.Fatalf("返回记录的人数 = %v，期望 2", got)
				}
				if got := created["turnSeconds"]; got != float64(30) {
					t.Fatalf("返回记录的每步时间 = %v，期望 30", got)
				}

				listStatus, rooms := getRooms(t, baseURL)
				if listStatus != http.StatusOK {
					t.Fatalf("创建后查询状态码 = %d，期望 200", listStatus)
				}
				if len(rooms) != 3 {
					t.Fatalf("创建后房间数量 = %d，期望 3（原有 2 条 + 新 1 条，被拒请求不留记录）", len(rooms))
				}
				if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms[:2], want) {
					t.Fatalf("已有记录被改写或重新排序：\n得到: %v\n期望: %v", rooms[:2], want)
				}
				if !reflect.DeepEqual(rooms[2], created) {
					t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", rooms[2], created)
				}
				return
			}

			// 损坏数据：字段齐全、类型和取值均合法的配置应返回 500，
			// 错误指向已有房间数据的读取或解析，而不是人数或时间输入错误。
			status, resp := postRoom(t, baseURL, validGomokuBody)
			if status != http.StatusInternalServerError {
				t.Fatalf("损坏数据上合法创建状态码 = %d，期望 500，响应: %v", status, resp)
			}
			errMsg, _ := resp["error"].(string)
			if !strings.Contains(errMsg, "房间数据") {
				t.Fatalf("error 应指向已有房间数据的读取或解析，实际: %q", errMsg)
			}
			for _, part := range []string{"五子棋", "人数", "时间", "turnSeconds", "整数", "缺少"} {
				if strings.Contains(errMsg, part) {
					t.Fatalf("配置完全合法，error 不应落在人数或时间输入上，实际: %q", errMsg)
				}
			}
			if _, ok := resp["id"]; ok {
				t.Fatalf("数据读取失败不应返回成功编号，实际: %v", resp)
			}

			// 损坏内容保持原样：不被解释成没有房间，也不被整理、补齐或替换。
			if got := readDataFile(t, dataDir); !bytes.Equal(got, seed) {
				t.Fatalf("拒绝创建后损坏内容被改动：\n得到: %s\n期望: %s", got, seed)
			}
		})
	}
}
