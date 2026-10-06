package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// 本文件回归 /api/rooms 的方法入口约定：只允许 GET 查询与 POST 创建，
// 其他方法（DELETE、PUT、PATCH、OPTIONS、HEAD、未知方法）必须在读取请求体、
// 解析创建表单或读取房间数据之前就被判定为 405，并通过 Allow 头说明允许 GET、POST。
// 被拒请求不得产生任何房间操作：不能返回房间列表或成功编号，不能追加、删除或改写记录，
// 也不能改写本地保存内容；房间数据损坏时同样先判方法、再谈数据，不能改报读取失败。

// roomsRequest 以指定方法向 /api/rooms 发起请求，由调用方读取并关闭响应体。
func roomsRequest(t *testing.T, baseURL, method string, body string, hasBody bool) *http.Response {
	t.Helper()
	var reader io.Reader
	if hasBody {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, baseURL+"/api/rooms", reader)
	if err != nil {
		t.Fatalf("构造 %s 请求失败: %v", method, err)
	}
	if hasBody {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("%s /api/rooms 失败: %v", method, err)
	}
	return resp
}

// assertMethodNotAllowed 断言一次被拒方法的响应：
// 405、Allow: GET, POST；可携带正文的方法返回 JSON 错误且不含编号或列表；
// HEAD 遵守无正文约定（正文必须为空，不能因空正文被当成成功查询）。
func assertMethodNotAllowed(t *testing.T, resp *http.Response) {
	t.Helper()
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("%s /api/rooms 状态码 = %d，期望 405", resp.Request.Method, resp.StatusCode)
	}
	if got, want := resp.Header.Get("Allow"), "GET, POST"; got != want {
		t.Fatalf("%s 响应 Allow 头 = %q，期望 %q", resp.Request.Method, got, want)
	}

	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取 %s 响应失败: %v", resp.Request.Method, err)
	}

	if resp.Request.Method == http.MethodHead {
		// HEAD 响应只返回头部：必须仍是 405 与相同的 Allow 信息，但不能有响应正文。
		if len(payload) != 0 {
			t.Fatalf("HEAD 不应返回响应正文，实际得到: %s", payload)
		}
		return
	}

	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("%s 错误响应 Content-Type = %q，期望 application/json", resp.Request.Method, ct)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("%s 错误响应不是合法 JSON: %v（内容: %s）", resp.Request.Method, err, payload)
	}
	errMsg, _ := decoded["error"].(string)
	if errMsg != "method not allowed" {
		t.Fatalf("%s error = %q，期望清楚说明方法不受支持（method not allowed）", resp.Request.Method, errMsg)
	}
	if _, ok := decoded["id"]; ok {
		t.Fatalf("%s 被拒方法不应返回房间编号，实际: %v", resp.Request.Method, decoded)
	}
	if _, ok := decoded["rooms"]; ok {
		t.Fatalf("%s 被拒方法不应返回房间列表，实际: %v", resp.Request.Method, decoded)
	}
}

// 不支持的方法即使携带一份完全合法的创建配置，也必须返回 405：
// 不能被当成查询、创建或删除；无正文或正文不是合法 JSON 时同样是 405，
// 不能降级成创建表单的缺字段、格式错误或规则错误。
// 全部被拒请求之后，已有房间的数量、排列顺序、编号、配置与附带内容保持原样，
// 本地保存内容逐字节不变。
func TestUnsupportedMethodsRejectedWithoutTouchingRooms(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	validConfig := `{"name":"被拒方法夹带的房间","game":"gomoku","capacity":2,"turnSeconds":30}`
	cases := []struct {
		name    string
		method  string
		body    string
		hasBody bool
	}{
		{"DELETE 携带合法创建配置", http.MethodDelete, validConfig, true},
		{"PUT 携带合法创建配置", http.MethodPut, validConfig, true},
		{"PATCH 携带合法创建配置", http.MethodPatch, validConfig, true},
		{"OPTIONS 携带合法创建配置", http.MethodOptions, validConfig, true},
		{"未知方法 BREW 携带合法创建配置", "BREW", validConfig, true},
		{"DELETE 不携带正文", http.MethodDelete, "", false},
		{"PUT 不携带正文", http.MethodPut, "", false},
		{"PUT 正文不是合法 JSON", http.MethodPut, "{不是合法 JSON", true},
		{"DELETE 正文为空字符串", http.MethodDelete, "", true},
		{"HEAD 不携带正文", http.MethodHead, "", false},
		{"HEAD 携带合法创建配置", http.MethodHead, validConfig, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := roomsRequest(t, baseURL, tc.method, tc.body, tc.hasBody)
			assertMethodNotAllowed(t, resp)
		})
	}

	// 被拒方法没有造成任何房间操作：GET 结果与磁盘文件都和种子逐字节一致。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// 被拒方法要与原本允许的方法区分开：同一服务中先有被拒请求，
// GET 仍正常返回已有房间，POST 合法配置仍正常创建并只追加在原记录之后；
// 再次穿插被拒请求后继续创建，历史备注、数组与嵌套附带字段继续保留，
// 被拒请求不占任何记录、不消耗编号位置。
func TestAllowedMethodsStillWorkAfterRejectedMethods(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	// 先拒一个携带合法配置的 DELETE。
	assertMethodNotAllowed(t, roomsRequest(t, baseURL, http.MethodDelete,
		`{"name":"不应存在的房间","game":"gomoku","capacity":2,"turnSeconds":30}`, true))

	getStatus, rooms := getRooms(t, baseURL)
	if getStatus != http.StatusOK {
		t.Fatalf("被拒请求后 GET 状态码 = %d，期望 200", getStatus)
	}
	wantSeed := decodeRecords(t, seed)
	if !reflect.DeepEqual(rooms, wantSeed) {
		t.Fatalf("被拒请求后 GET 结果被改动：\n得到: %v\n期望: %v", rooms, wantSeed)
	}

	// 合法创建：只追加，原记录不动。
	status1, created1 := postRoom(t, baseURL, `{"name":"追加的五子棋房","game":"gomoku","capacity":2,"turnSeconds":0}`)
	if status1 != http.StatusCreated {
		t.Fatalf("第一次创建状态码 = %d，期望 201，响应: %v", status1, created1)
	}
	id1, _ := created1["id"].(string)
	if id1 == "" || id1 == "seed-alpha" || id1 == "seed-beta" {
		t.Fatalf("第一个新房间编号异常: %q", id1)
	}

	// 创建之后再来一个携带非法 JSON 的被拒方法，仍应只是 405。
	assertMethodNotAllowed(t, roomsRequest(t, baseURL, http.MethodPut, "{", true))

	status2, created2 := postRoom(t, baseURL, `{"name":"追加的飞行棋房","game":"ludo","capacity":3,"turnSeconds":60}`)
	if status2 != http.StatusCreated {
		t.Fatalf("第二次创建状态码 = %d，期望 201，响应: %v", status2, created2)
	}
	id2, _ := created2["id"].(string)
	if id2 == "" || id2 == id1 || id2 == "seed-alpha" || id2 == "seed-beta" {
		t.Fatalf("第二个新房间编号异常: %q（已有编号: %v）", id2, id1)
	}

	// 最终列表恰好是“旧记录 + 两个新房间”，数量、次序、附带字段都对。
	finalStatus, finalRooms := getRooms(t, baseURL)
	if finalStatus != http.StatusOK {
		t.Fatalf("最终 GET 状态码 = %d，期望 200", finalStatus)
	}
	if got, want := len(finalRooms), 4; got != want {
		t.Fatalf("最终房间数量 = %d，期望 %d（被拒请求不应占记录）", got, want)
	}
	if !reflect.DeepEqual(finalRooms[0], wantSeed[0]) || !reflect.DeepEqual(finalRooms[1], wantSeed[1]) {
		t.Fatalf("历史记录被改动：\n得到: %v\n%v\n期望: %v\n%v",
			finalRooms[0], finalRooms[1], wantSeed[0], wantSeed[1])
	}
	if !reflect.DeepEqual(finalRooms[2], created1) {
		t.Fatalf("第三个位置应是第一个创建响应的房间：\n得到: %v\n期望: %v", finalRooms[2], created1)
	}
	if !reflect.DeepEqual(finalRooms[3], created2) {
		t.Fatalf("第四个位置应是第二个创建响应的房间：\n得到: %v\n期望: %v", finalRooms[3], created2)
	}

	// 本地保存与接口列表一致：恰好四条，新房间只在末尾追加，文件未被重排。
	if onDisk := decodeRecords(t, readDataFile(t, dataDir)); !reflect.DeepEqual(onDisk, finalRooms) {
		t.Fatalf("本地保存与列表不一致：\n磁盘: %v\n列表: %v", onDisk, finalRooms)
	}
}

// 房间数据无法读取或已损坏时，方法判断仍然独立在前：不支持的方法依旧返回 405
// 与 Allow: GET, POST，不能改报数据读取失败，更不能把损坏内容当成空列表后重新保存。
func TestUnsupportedMethodsRejectedWhenRoomDataUnreadable(t *testing.T) {
	cases := []struct {
		name    string
		content string
	}{
		{"数据被截断无法解析", "[\n" + seedRecord1 + ",\n{\"id\":\"seed-ga"},
		{"顶层为 JSON null", "null\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dataDir := t.TempDir()
			seed := seedRaw(t, dataDir, tc.content)
			baseURL := startServer(t, dataDir)

			// 携带完全合法创建配置的 DELETE、无正文 PUT、HEAD：与请求内容无关，一律先判 405。
			assertMethodNotAllowed(t, roomsRequest(t, baseURL, http.MethodDelete,
				`{"name":"损坏数据下不应创建的房间","game":"gomoku","capacity":2,"turnSeconds":30}`, true))
			assertMethodNotAllowed(t, roomsRequest(t, baseURL, http.MethodPut, "", false))
			assertMethodNotAllowed(t, roomsRequest(t, baseURL, http.MethodHead, "", false))

			// 损坏文件逐字节保留：没有被当成空列表重写，也没有被修复或追加。
			if got := readDataFile(t, dataDir); !bytes.Equal(got, seed) {
				t.Fatalf("损坏的数据文件被改动：\n得到: %s\n期望: %s", got, seed)
			}

			// 对照：同样的损坏数据下，允许的 GET 才按既有约定报 500，
			// 证明“方法不受支持”和“房间数据读取失败”是两条互不混淆的结论。
			getStatus, getBody := getRoomsResponse(t, baseURL)
			if getStatus != http.StatusInternalServerError {
				t.Fatalf("损坏数据下 GET 状态码 = %d，期望 500，响应: %v", getStatus, getBody)
			}
			getErr, _ := getBody["error"].(string)
			if !strings.Contains(getErr, "房间数据") {
				t.Fatalf("GET 的 error 应说明房间数据读取失败，实际: %q", getErr)
			}
			if got := readDataFile(t, dataDir); !bytes.Equal(got, seed) {
				t.Fatalf("GET 检查后损坏的数据文件被改动：\n得到: %s\n期望: %s", got, seed)
			}
		})
	}
}
