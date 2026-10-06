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

// 本文件回归 /api/rooms 的方法处理约定：只允许 GET（查询）与 POST（创建），
// 其余方法必须返回 405 并通过 Allow 响应头说明允许 GET、POST，且不产生任何
// 房间操作。方法是否受支持与请求正文是否合法、房间数据是否正常相互独立：
// 即使携带一份完全合法的创建配置，DELETE、PUT 等方法也必须被拒绝；
// 无正文或正文不是合法 JSON 时同样是 405，不能转成创建表单的校验错误；
// 房间数据损坏时仍是 405，不能改报数据读取失败，更不能改写本地文件。
// 与 main_test.go 一样以子进程方式启动真实服务，复用其中的辅助函数。

// sendRoomsRequest 以指定方法请求 /api/rooms，返回状态码、响应头与原始响应体。
// body 为空串时表示不携带请求正文。
func sendRoomsRequest(t *testing.T, method, baseURL, body string) (int, http.Header, []byte) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, baseURL+"/api/rooms", reader)
	if err != nil {
		t.Fatalf("构造 %s 请求失败: %v", method, err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		t.Fatalf("%s /api/rooms 失败: %v", method, err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取 %s 响应失败: %v", method, err)
	}
	return resp.StatusCode, resp.Header, payload
}

// assertMethodNotAllowed 断言一次被拒的方法调用：状态码 405，Allow 头说明
// 允许 GET、POST，响应正文是说明方法不受支持的 JSON 错误，且不含房间列表、
// 成功编号或新房间对象，也不是创建表单的字段校验错误。
func assertMethodNotAllowed(t *testing.T, method string, status int, header http.Header, payload []byte) {
	t.Helper()
	if status != http.StatusMethodNotAllowed {
		t.Fatalf("%s /api/rooms 状态码 = %d，期望 405，响应: %s", method, status, payload)
	}
	if got := header.Get("Allow"); got != "GET, POST" {
		t.Fatalf("%s /api/rooms 的 Allow 头 = %q，期望 %q（说明允许 GET、POST）", method, got, "GET, POST")
	}
	var body map[string]any
	if err := json.Unmarshal(payload, &body); err != nil {
		t.Fatalf("%s /api/rooms 的 405 响应不是合法 JSON: %v（内容: %s）", method, err, payload)
	}
	errMsg, _ := body["error"].(string)
	if !strings.Contains(strings.ToLower(errMsg), "method") {
		t.Fatalf("%s /api/rooms 的 error 应说明方法不受支持，实际: %q", method, errMsg)
	}
	if strings.Contains(errMsg, "缺少") || strings.Contains(errMsg, "请求体") || strings.Contains(errMsg, "房间数据") {
		t.Fatalf("%s /api/rooms 的 error 不应落成表单校验或数据读取错误，实际: %q", method, errMsg)
	}
	if _, ok := body["rooms"]; ok {
		t.Fatalf("%s /api/rooms 被拒绝时不应返回房间列表，实际: %v", method, body)
	}
	if _, ok := body["id"]; ok {
		t.Fatalf("%s /api/rooms 被拒绝时不应返回成功编号或新房间对象，实际: %v", method, body)
	}
}

// DELETE、PUT、PATCH 携带一份完全合法的创建配置时，也必须返回 405 而不是
// 创建成功或查询结果；全部拒绝后，已有房间的数量、次序、编号、配置与附带
// 字段保持原样，本地文件逐字节不变。
func TestRoomsRejectUnsupportedMethodsWithValidConfig(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	validConfig := `{"name":"方法拒绝验证房","game":"gomoku","capacity":2,"turnSeconds":30}`
	for _, method := range []string{http.MethodDelete, http.MethodPut, http.MethodPatch} {
		status, header, payload := sendRoomsRequest(t, method, baseURL, validConfig)
		assertMethodNotAllowed(t, method, status, header, payload)
	}

	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// HEAD 同样返回 405 和相同的 Allow 信息，但遵守 HEAD 约定不返回响应正文；
// 空正文不能被当成成功的空结果——随后的 GET 必须正常返回已有房间，
// 以此区分“被拒的 HEAD”与“成功的查询”。
func TestRoomsHeadRejectedWithoutBody(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	status, header, payload := sendRoomsRequest(t, http.MethodHead, baseURL, "")
	if status != http.StatusMethodNotAllowed {
		t.Fatalf("HEAD /api/rooms 状态码 = %d，期望 405（空正文不代表成功查询）", status)
	}
	if got := header.Get("Allow"); got != "GET, POST" {
		t.Fatalf("HEAD /api/rooms 的 Allow 头 = %q，期望 %q", got, "GET, POST")
	}
	if len(payload) != 0 {
		t.Fatalf("HEAD /api/rooms 不应返回响应正文，实际: %s", payload)
	}

	// 被拒的 HEAD 不影响后续允许的方法：GET 正常返回原有房间，文件未被改写。
	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// 方法是否受支持与请求内容分开判断：不支持的方法在没有正文、正文不是合法
// JSON、或正文是缺字段的合法 JSON 时，都仍然是 405，不能转成创建表单的
// 缺字段、格式错误或规则错误。
func TestRoomsMethodRejectedRegardlessOfBody(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	cases := []struct {
		desc   string
		method string
		body   string
	}{
		{"DELETE 无正文", http.MethodDelete, ""},
		{"PUT 无正文", http.MethodPut, ""},
		{"DELETE 正文不是合法 JSON", http.MethodDelete, `{"name":"残缺的请求"`},
		{"PUT 正文不是合法 JSON", http.MethodPut, `not json at all`},
		{"DELETE 正文缺字段", http.MethodDelete, `{"name":"缺字段的配置"}`},
		{"PUT 正文违反人数规则", http.MethodPut, `{"name":"规则错误房","game":"gomoku","capacity":4,"turnSeconds":30}`},
	}
	for _, tc := range cases {
		status, header, payload := sendRoomsRequest(t, tc.method, baseURL, tc.body)
		if status == http.StatusBadRequest {
			t.Fatalf("%s：状态码 = 400，方法不受支持不应转成表单校验错误，响应: %s", tc.desc, payload)
		}
		assertMethodNotAllowed(t, tc.method, status, header, payload)
	}

	assertRoomsUnchanged(t, baseURL, dataDir, seed)
}

// 房间数据已损坏时，不支持的方法仍应被 405 拒绝：方法判断先于数据读取，
// 不能改报 500 数据读取失败，更不能把损坏内容当成空列表后重新保存。
func TestRoomsMethodRejectedWhenDataCorrupt(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRaw(t, dataDir, "[\n"+seedRecord1+",\n{\"id\":\"seed-ga")
	baseURL := startServer(t, dataDir)

	for _, method := range []string{http.MethodDelete, http.MethodPut, http.MethodHead} {
		status, header, payload := sendRoomsRequest(t, method, baseURL, `{"name":"损坏数据验证房","game":"ludo","capacity":3,"turnSeconds":60}`)
		if status == http.StatusInternalServerError {
			t.Fatalf("%s /api/rooms 状态码 = 500，数据损坏不应改报读取失败，响应: %s", method, payload)
		}
		if method == http.MethodHead {
			if status != http.StatusMethodNotAllowed {
				t.Fatalf("HEAD /api/rooms 状态码 = %d，期望 405", status)
			}
			if got := header.Get("Allow"); got != "GET, POST" {
				t.Fatalf("HEAD /api/rooms 的 Allow 头 = %q，期望 %q", got, "GET, POST")
			}
			continue
		}
		assertMethodNotAllowed(t, method, status, header, payload)
	}

	// 损坏的数据文件逐字节保留：不被清空、不被改写、不被当成空列表重新保存。
	if got := readDataFile(t, dataDir); !bytes.Equal(got, seed) {
		t.Fatalf("数据文件被改动：\n得到: %s\n期望: %s", got, seed)
	}
}

// 被拒的请求与允许的方法要能区分：同一服务中先有一批被拒请求，随后 GET
// 仍正常返回已有房间（含备注、数组与嵌套附带字段），POST 合法配置仍正常
// 创建并仅追加在原记录之后；被拒请求不占用任何记录。
func TestRoomsAllowedMethodsUnaffectedByRejections(t *testing.T) {
	dataDir := t.TempDir()
	seed := seedRooms(t, dataDir, seedRecord1, seedRecord2)
	baseURL := startServer(t, dataDir)

	// 先制造一批被拒请求：带合法配置的 DELETE、无正文的 PUT、HEAD。
	validConfig := `{"name":"拒绝后新建房","game":"ludo","capacity":4,"turnSeconds":60}`
	for _, method := range []string{http.MethodDelete, http.MethodPut, http.MethodHead} {
		body := validConfig
		if method == http.MethodPut || method == http.MethodHead {
			body = ""
		}
		status, header, payload := sendRoomsRequest(t, method, baseURL, body)
		if method == http.MethodHead {
			if status != http.StatusMethodNotAllowed || header.Get("Allow") != "GET, POST" {
				t.Fatalf("HEAD /api/rooms 应为 405 且 Allow 为 %q，实际状态 %d、Allow %q", "GET, POST", status, header.Get("Allow"))
			}
			continue
		}
		assertMethodNotAllowed(t, method, status, header, payload)
	}

	// GET 仍正常返回已有房间：数量、次序、内容与附带字段（note/tags/extra）不变。
	getStatus, rooms := getRooms(t, baseURL)
	if getStatus != http.StatusOK {
		t.Fatalf("被拒请求后 GET /api/rooms 状态码 = %d，期望 200", getStatus)
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(rooms, want) {
		t.Fatalf("被拒请求后房间列表被改动：\n得到: %v\n期望: %v", rooms, want)
	}
	if first, _ := rooms[0].(map[string]any); first["note"] != "保留我" {
		t.Fatalf("首条房间的备注附带字段应保留，实际: %v", rooms[0])
	}

	// POST 合法配置仍正常创建，新房间仅追加在原记录之后。
	createStatus, created := postRoom(t, baseURL, validConfig)
	if createStatus != http.StatusCreated {
		t.Fatalf("被拒请求后 POST /api/rooms 状态码 = %d，期望 201，响应: %v", createStatus, created)
	}
	if id, _ := created["id"].(string); id == "" {
		t.Fatal("新房间编号为空")
	}

	_, after := getRooms(t, baseURL)
	if len(after) != 3 {
		t.Fatalf("房间数量 = %d，期望 3（种子 2 条 + 新建 1 条，被拒请求不得占用记录）", len(after))
	}
	if want := decodeRecords(t, seed); !reflect.DeepEqual(after[:2], want) {
		t.Fatalf("原有房间被改写或重新排序：\n得到: %v\n期望: %v", after[:2], want)
	}
	last, ok := after[2].(map[string]any)
	if !ok {
		t.Fatalf("新记录不是对象: %v", after[2])
	}
	if !reflect.DeepEqual(last, created) {
		t.Fatalf("列表中的新记录与创建响应不一致：\n列表: %v\n响应: %v", last, created)
	}
}
