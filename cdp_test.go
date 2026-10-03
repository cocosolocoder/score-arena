package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// 本文件提供页面级端到端回归测试所需的最小浏览器驱动能力：
// 启动本机无头 Chrome，通过 Chrome DevTools Protocol（CDP）驱动真实页面。
// 仅依赖 Go 标准库（自带一个极简 RFC6455 WebSocket 客户端），不引入任何
// 第三方模块或 npm 依赖；现有接口级测试的启动方式（真实服务子进程）保持不变。

// ---------------------------------------------------------------------------
// 极简 RFC6455 客户端（仅实现 CDP 所需的文本帧收发与控制帧处理）
// ---------------------------------------------------------------------------

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type wsConn struct {
	nc net.Conn
	br *bufio.Reader
}

func wsDial(rawURL string) (*wsConn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	var keyBytes [16]byte
	if _, err := rand.Read(keyBytes[:]); err != nil {
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes[:])

	nc, err := net.DialTimeout("tcp", u.Host, 5*time.Second)
	if err != nil {
		return nil, err
	}
	req := &http.Request{Method: http.MethodGet, URL: u, Host: u.Host, Header: http.Header{}}
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Sec-WebSocket-Key", key)
	req.Header.Set("Sec-WebSocket-Version", "13")
	if err := req.Write(nc); err != nil {
		_ = nc.Close()
		return nil, err
	}

	br := bufio.NewReader(nc)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		_ = nc.Close()
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		_ = nc.Close()
		return nil, fmt.Errorf("websocket 握手失败：%s", resp.Status)
	}
	sum := sha1.Sum([]byte(key + wsGUID))
	if got := resp.Header.Get("Sec-WebSocket-Accept"); got != base64.StdEncoding.EncodeToString(sum[:]) {
		_ = nc.Close()
		return nil, fmt.Errorf("websocket 握手返回的 Sec-WebSocket-Accept 不正确")
	}
	return &wsConn{nc: nc, br: br}, nil
}

// writeFrame 发送一帧；客户端发送的帧必须带掩码。
func (c *wsConn) writeFrame(opcode byte, payload []byte) error {
	_ = c.nc.SetWriteDeadline(time.Now().Add(10 * time.Second))
	header := []byte{0x80 | opcode} // 本客户端只发送未分片帧，FIN 置 1。
	switch n := len(payload); {
	case n < 126:
		header = append(header, 0x80|byte(n))
	case n <= 0xFFFF:
		header = append(header, 0x80|126, 0, 0)
		binary.BigEndian.PutUint16(header[2:4], uint16(n))
	default:
		header = append(header, 0x80|127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(header[2:10], uint64(n))
	}
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	header = append(header, mask[:]...)
	masked := make([]byte, len(payload))
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	if _, err := c.nc.Write(append(header, masked...)); err != nil {
		return err
	}
	return nil
}

// readFrame 读取一帧，返回操作码、FIN 位与已去掩码的载荷。
func (c *wsConn) readFrame() (opcode byte, fin bool, payload []byte, err error) {
	var head [2]byte
	if _, err = io.ReadFull(c.br, head[:]); err != nil {
		return 0, false, nil, err
	}
	opcode = head[0] & 0x0f
	fin = head[0]&0x80 != 0
	length := int(head[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return 0, false, nil, err
		}
		length = int(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return 0, false, nil, err
		}
		length = int(binary.BigEndian.Uint64(ext[:]))
	}
	var mask [4]byte
	if head[1]&0x80 != 0 {
		if _, err = io.ReadFull(c.br, mask[:]); err != nil {
			return 0, false, nil, err
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(c.br, payload); err != nil {
		return 0, false, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return opcode, fin, payload, nil
}

func (c *wsConn) close() {
	_ = c.writeFrame(0x8, nil)
	_ = c.nc.Close()
}

// ---------------------------------------------------------------------------
// CDP 客户端
// ---------------------------------------------------------------------------

type cdpMessage struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type cdpClient struct {
	ws      *wsConn
	writeMu sync.Mutex
	nextID  int64

	pendingMu sync.Mutex
	pending   map[int64]chan cdpMessage

	eventMu sync.Mutex
	onEvent func(method string, params json.RawMessage)

	closeOnce sync.Once
	done      chan struct{}
}

func newCDPClient(rawURL string) (*cdpClient, error) {
	ws, err := wsDial(rawURL)
	if err != nil {
		return nil, err
	}
	c := &cdpClient{ws: ws, pending: make(map[int64]chan cdpMessage), done: make(chan struct{})}
	go c.readLoop()
	return c, nil
}

func (c *cdpClient) readLoop() {
	var fragments []byte
	for {
		op, fin, payload, err := c.ws.readFrame()
		if err != nil {
			c.closeOnce.Do(func() { close(c.done) })
			return
		}
		switch op {
		case 0x0: // 分片续帧
			fragments = append(fragments, payload...)
		case 0x1, 0x2: // 文本 / 二进制数据帧
			fragments = append(fragments[:0:0], payload...)
		case 0x9: // Ping → 原样回 Pong
			_ = c.ws.writeFrame(0xA, payload)
			continue
		case 0xA: // Pong
			continue
		case 0x8: // Close
			c.closeOnce.Do(func() { close(c.done) })
			return
		default:
			continue
		}
		if !fin {
			continue
		}
		complete := append(json.RawMessage(nil), fragments...)
		fragments = nil

		var msg cdpMessage
		if err := json.Unmarshal(complete, &msg); err != nil {
			continue
		}
		if msg.Method != "" {
			c.eventMu.Lock()
			handler := c.onEvent
			c.eventMu.Unlock()
			if handler != nil {
				handler(msg.Method, msg.Params)
			}
			continue
		}
		c.pendingMu.Lock()
		ch := c.pending[msg.ID]
		delete(c.pending, msg.ID)
		c.pendingMu.Unlock()
		if ch != nil {
			ch <- msg
		}
	}
}

// call 发送一个 CDP 命令并等待对应响应；按编号路由，支持并发调用。
func (c *cdpClient) call(method string, params any) (json.RawMessage, error) {
	c.writeMu.Lock()
	c.nextID++
	id := c.nextID
	req := map[string]any{"id": id, "method": method}
	if params != nil {
		req["params"] = params
	}
	encoded, err := json.Marshal(req)
	if err != nil {
		c.writeMu.Unlock()
		return nil, err
	}
	ch := make(chan cdpMessage, 1)
	c.pendingMu.Lock()
	c.pending[id] = ch
	c.pendingMu.Unlock()
	if err := c.ws.writeFrame(0x1, encoded); err != nil {
		c.writeMu.Unlock()
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, err
	}
	c.writeMu.Unlock()

	select {
	case msg := <-ch:
		if msg.Error != nil {
			return nil, fmt.Errorf("CDP %s 返回错误 %d: %s", method, msg.Error.Code, msg.Error.Message)
		}
		return msg.Result, nil
	case <-c.done:
		return nil, fmt.Errorf("CDP 连接已关闭：%s", method)
	case <-time.After(15 * time.Second):
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, fmt.Errorf("等待 CDP %s 响应超时", method)
	}
}

func (c *cdpClient) setEventHandler(handler func(method string, params json.RawMessage)) {
	c.eventMu.Lock()
	c.onEvent = handler
	c.eventMu.Unlock()
}

func (c *cdpClient) close() {
	c.ws.close()
}

// ---------------------------------------------------------------------------
// 无头 Chrome 进程与页面
// ---------------------------------------------------------------------------

type chromeBrowser struct {
	cmd  *exec.Cmd
	port string
}

func findChrome() (string, error) {
	for _, name := range []string{"google-chrome", "chromium", "chromium-browser", "chrome"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("未找到 Chrome/Chromium 可执行文件")
}

// startChrome 启动一个独立的无头 Chrome，测试结束时自动回收。
func startChrome(t *testing.T) *chromeBrowser {
	t.Helper()
	bin, err := findChrome()
	if err != nil {
		t.Fatalf("启动浏览器失败: %v", err)
	}
	profileDir := t.TempDir()
	cmd := exec.Command(bin,
		"--headless=new",
		"--no-sandbox",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--window-size=1280,900",
		"--remote-debugging-port=0",
		"--user-data-dir="+profileDir,
		"about:blank",
	)
	var logs strings.Builder
	cmd.Stdout = &logs
	cmd.Stderr = &logs
	// 固定时区，页面按本地时间渲染“创建时间”，UTC 下可直接与服务端 RFC3339 时间比对。
	cmd.Env = append(os.Environ(), "TZ=UTC")
	if err := cmd.Start(); err != nil {
		t.Fatalf("启动 Chrome 失败: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	portFile := filepath.Join(profileDir, "DevToolsActivePort")
	deadline := time.Now().Add(15 * time.Second)
	var port string
	for {
		if content, err := os.ReadFile(portFile); err == nil {
			if lines := strings.Split(strings.TrimSpace(string(content)), "\n"); len(lines) > 0 && lines[0] != "" {
				port = lines[0]
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("等待 Chrome 调试端口超时，浏览器输出:\n%s", logs.String())
		}
		time.Sleep(30 * time.Millisecond)
	}
	return &chromeBrowser{cmd: cmd, port: port}
}

type cdpPage struct {
	browser  *chromeBrowser
	targetID string
	client   *cdpClient
}

type devToolsTarget struct {
	ID                   string `json:"id"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

var devToolsHTTPClient = &http.Client{Timeout: 10 * time.Second}

// openPage 新建标签页，注入测试引导脚本（可空），随后导航到 pageURL。
// bootstrap 会在页面自身脚本执行前注入，可用于包装 fetch 以模拟服务端响应。
func (b *chromeBrowser) openPage(t *testing.T, pageURL string, bootstrap string) *cdpPage {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut,
		fmt.Sprintf("http://127.0.0.1:%s/json/new?about:blank", b.port), nil)
	if err != nil {
		t.Fatalf("构造新建标签页请求失败: %v", err)
	}
	create, err := devToolsHTTPClient.Do(req)
	if err != nil {
		t.Fatalf("新建浏览器标签页失败: %v", err)
	}
	defer create.Body.Close()
	var target devToolsTarget
	if err := json.NewDecoder(create.Body).Decode(&target); err != nil {
		t.Fatalf("解析标签页信息失败: %v", err)
	}

	client, err := newCDPClient(target.WebSocketDebuggerURL)
	if err != nil {
		t.Fatalf("连接浏览器调试通道失败: %v", err)
	}
	pg := &cdpPage{browser: b, targetID: target.ID, client: client}
	t.Cleanup(pg.close)

	// 把页面控制台输出接到测试日志，失败排查时可见。
	client.setEventHandler(func(method string, params json.RawMessage) {
		if method != "Runtime.consoleAPICalled" {
			return
		}
		var ev struct {
			Args []struct {
				Value json.RawMessage `json:"value"`
			} `json:"args"`
		}
		if json.Unmarshal(params, &ev) == nil && len(ev.Args) > 0 {
			parts := make([]string, 0, len(ev.Args))
			for _, a := range ev.Args {
				parts = append(parts, strings.Trim(string(a.Value), `"`))
			}
			t.Logf("浏览器控制台: %s", strings.Join(parts, " "))
		}
	})

	if _, err := client.call("Page.enable", map[string]any{}); err != nil {
		t.Fatalf("启用 Page 域失败: %v", err)
	}
	if _, err := client.call("Runtime.enable", map[string]any{}); err != nil {
		t.Fatalf("启用 Runtime 域失败: %v", err)
	}
	if bootstrap != "" {
		if err := pg.addScriptOnNewDocument(bootstrap); err != nil {
			t.Fatalf("注入测试引导脚本失败: %v", err)
		}
	}
	if _, err := client.call("Page.navigate", map[string]any{"url": pageURL}); err != nil {
		t.Fatalf("页面导航失败: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			t.Fatalf("等待首页加载完成超时: %v", ctx.Err())
		default:
		}
		var ready bool
		if err := pg.evalInto(`document.readyState === 'complete' &&
			!!document.getElementById('room-form') &&
			typeof window.__e2eSnapshot === 'function'`, &ready); err != nil {
			t.Fatalf("检查页面就绪状态失败: %v", err)
		}
		if ready {
			return pg
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func (p *cdpPage) close() {
	p.client.close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%s/json/close/%s", p.browser.port, p.targetID), nil)
	_, _ = devToolsHTTPClient.Do(req)
}

// addScriptOnNewDocument 注入在每个新文档执行前运行的脚本。
// 新版 Chrome（约 150 起）把参数改为字符串字段 source，旧版使用 expression：
// 优先新参数，遇到参数错误时回退旧参数，使测试不绑定单一 Chrome 版本。
func (p *cdpPage) addScriptOnNewDocument(script string) error {
	if _, err := p.client.call("Page.addScriptToEvaluateOnNewDocument", map[string]any{
		"source": script,
	}); err == nil {
		return nil
	}
	_, err := p.client.call("Page.addScriptToEvaluateOnNewDocument", map[string]any{
		"expression": script,
	})
	return err
}

// evalInto 执行表达式并把 returnByValue 结果解码到 out。
func (p *cdpPage) evalInto(expr string, out any) error {
	raw, err := p.client.call("Runtime.evaluate", map[string]any{
		"expression":    expr,
		"returnByValue": true,
		"awaitPromise":  false,
	})
	if err != nil {
		return err
	}
	var ev struct {
		Result struct {
			Type  string          `json:"type"`
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails json.RawMessage `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return fmt.Errorf("解析脚本执行结果失败: %w", err)
	}
	if len(ev.ExceptionDetails) > 0 && string(ev.ExceptionDetails) != "null" {
		return fmt.Errorf("页面脚本抛出异常: %s", ev.ExceptionDetails)
	}
	if out != nil && len(ev.Result.Value) > 0 && string(ev.Result.Value) != "null" {
		if err := json.Unmarshal(ev.Result.Value, out); err != nil {
			return fmt.Errorf("解码脚本返回值失败: %w（原始值: %s）", err, ev.Result.Value)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// 页面引导脚本：提供填表、提交与状态快照钩子，可附带 fetch 测试替身
// ---------------------------------------------------------------------------

// fetchStubSpec 描述对 /api/rooms 的 fetch 替身策略。
//   - PostActions：第 i 次 POST 依次取对应动作（"reject" 用 RejectStatus/RejectBody
//     合成拒绝响应，"pass" 透传给真实服务）；超出长度后重复最后一个动作。
//   - FailListAt：第 N 次（从 1 开始）GET /api/rooms 合成 500，其余透传。
//   - DelayMS：合成的拒绝响应延迟毫秒数，用于制造“提交等待中”的窗口。
type fetchStubSpec struct {
	DelayMS      int            `json:"delayMS"`
	RejectStatus int            `json:"rejectStatus"`
	RejectBody   map[string]any `json:"rejectBody"`
	PostActions  []string       `json:"postActions"`
	FailListAt   []int          `json:"failListAt"`
}

// e2ePrelude 中 /*__FETCH_HOOK__*/ 位置由具体的 fetch 包装实现替换。
// 引导脚本在页面脚本之前运行：既可以只做调用记录（真实服务模式），
// 也可以按 fetchStubSpec 合成服务端拒绝或列表读取失败（真实接口无法稳定构造的场景）。
const e2ePrelude = `
(function () {
  if (window.__E2E__) return;
  var E = window.__E2E__ = { posts: [], lists: 0 };

  function cellText(el) { return el.textContent.replace(/^\s+|\s+$/g, ''); }

  window.__e2eSnapshot = function () {
    var msg = document.getElementById('form-msg');
    var rows = [];
    var rowTimes = [];
    var trs = document.querySelectorAll('#list-area table tbody tr');
    for (var i = 0; i < trs.length; i++) {
      var cells = trs[i].querySelectorAll('td');
      var row = [];
      for (var j = 0; j < cells.length; j++) row.push(cellText(cells[j]));
      rows.push(row);
      rowTimes.push(cells.length > 6 ? cells[6].title : '');
    }
    var empty = document.querySelector('#list-area .empty');
    var listErr = document.querySelector('#list-area .list-error');
    return {
      name: document.getElementById('name').value,
      game: document.getElementById('game').value,
      capacity: document.getElementById('capacity').value,
      capacityDisabled: document.getElementById('capacity').disabled,
      turnSeconds: document.getElementById('turnSeconds').value,
      submitDisabled: document.getElementById('submit').disabled,
      msgText: msg.textContent,
      msgShown: msg.className.indexOf('show') !== -1,
      msgKind: msg.className.indexOf('ok') !== -1 ? 'ok'
             : (msg.className.indexOf('error') !== -1 ? 'error' : ''),
      emptyShown: !!empty,
      listErrorShown: !!listErr,
      listErrorText: listErr ? cellText(listErr) : '',
      hasTable: !!document.querySelector('#list-area table'),
      rows: rows,
      rowTimes: rowTimes,
      postCount: E.posts.length,
      postBodies: E.posts.map(function (p) { return p.body; }),
      listCalls: E.lists
    };
  };

  // 按真实用户路径赋值并派发 change/input 事件（选择游戏规则会联动重建人数选项）。
  window.__e2eFill = function (v) {
    function set(id, value, eventName) {
      var el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event(eventName, { bubbles: true }));
    }
    set('name', v.name, 'input');
    set('game', v.game, 'change');
    set('capacity', String(v.capacity), 'change');
    set('turnSeconds', String(v.turnSeconds), 'input');
  };
  window.__e2eSetName = function (value) {
    var el = document.getElementById('name');
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  window.__e2eSubmit = function () {
    document.getElementById('submit').click();
    return true;
  };

  function recordCall(input, init) {
    var url = String(input && input.url ? input.url : input);
    if (url.indexOf('/api/rooms') === -1) return;
    var method = (init && init.method) || 'GET';
    if (method === 'POST') E.posts.push({ body: init && init.body ? init.body : '' });
    if (method === 'GET') E.lists += 1;
  }

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  /*__FETCH_HOOK__*/
})();
`

const loggingFetchHook = `
window.fetch = function (input, init) {
  recordCall(input, init);
  return realFetch(input, init);
};
`

const stubFetchHook = `
var CFG = /*__STUB_CONFIG__*/;
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { 'Content-Type': 'application/json' }
  });
}
window.fetch = function (input, init) {
  recordCall(input, init);
  var url = String(input && input.url ? input.url : input);
  var method = (init && init.method) || 'GET';

  if (url.indexOf('/api/rooms') !== -1 && method === 'POST') {
    var idx = E.posts.length - 1;
    var action = CFG.postActions.length > 0
      ? CFG.postActions[Math.min(idx, CFG.postActions.length - 1)]
      : 'pass';
    if (action === 'reject') {
      var reply = jsonResponse(CFG.rejectStatus, CFG.rejectBody);
      if (CFG.delayMS > 0) {
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(reply); }, CFG.delayMS);
        });
      }
      return Promise.resolve(reply);
    }
  }
  if (url.indexOf('/api/rooms') !== -1 && method === 'GET' &&
      CFG.failListAt.indexOf(E.lists) !== -1) {
    return Promise.resolve(jsonResponse(500, { error: '无法读取房间数据（测试注入的列表故障）' }));
  }
  return realFetch(input, init);
};
`

// buildBootstrap 生成注入脚本；spec 为 nil 时仅记录请求，全部透传真实服务。
func buildBootstrap(spec *fetchStubSpec) string {
	if spec == nil {
		return strings.Replace(e2ePrelude, "/*__FETCH_HOOK__*/", loggingFetchHook, 1)
	}
	if spec.PostActions == nil {
		spec.PostActions = []string{"pass"}
	}
	if spec.FailListAt == nil {
		spec.FailListAt = []int{}
	}
	cfg, err := json.Marshal(spec)
	if err != nil {
		panic(err)
	}
	hook := strings.Replace(stubFetchHook, "/*__STUB_CONFIG__*/", string(cfg), 1)
	return strings.Replace(e2ePrelude, "/*__FETCH_HOOK__*/", hook, 1)
}
