package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const product = "ScoreArena"
const resourceName = "rooms"
const page = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScoreArena · 桌面规则游戏与赛事管理</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:56rem;margin:2.5rem auto;padding:0 1rem;line-height:1.6}
h1{margin-bottom:.25rem}
.sub{color:#666;margin-top:0}
h2{margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.3rem}
form{display:grid;gap:.8rem;max-width:32rem}
label{display:grid;gap:.25rem;font-weight:600}
input,select{padding:.5rem;font-size:1rem;border:1px solid #bbb;border-radius:.4rem;background:inherit;color:inherit}
button{padding:.55rem 1.1rem;font-size:1rem;border:0;border-radius:.4rem;background:#175b9c;color:#fff;cursor:pointer;justify-self:start}
button:hover{background:#134a80}
.hint{color:#666;font-size:.85rem;font-weight:400}
#form-error{color:#b00020;font-weight:600;min-height:1.2em;margin:0}
table{border-collapse:collapse;width:100%;margin-top:.5rem}
th,td{border:1px solid #ccc;padding:.45rem .6rem;text-align:left;font-size:.95rem}
th{background:#f0f4f8}
#empty-hint{color:#666}
a{color:#175b9c}
</style>
<main>
<h1>ScoreArena</h1>
<p class="sub">桌面规则游戏与赛事管理</p>

<h2>创建公开房间</h2>
<form id="create-form">
  <label>房间名称
    <input id="name" name="name" type="text" required maxlength="80" placeholder="例如：欢乐五子棋">
  </label>
  <label>游戏规则
    <select id="game" name="game">
      <option value="gomoku">五子棋</option>
      <option value="ludo">飞行棋</option>
    </select>
  </label>
  <p class="hint" id="rule-hint">五子棋人数上限固定为 2 人。</p>
  <label>人数上限
    <input id="capacity" name="capacity" type="number" required min="2" max="2" step="1" value="2">
  </label>
  <label>每步操作时间限制（秒）
    <input id="turnSeconds" name="turnSeconds" type="number" required min="0" max="600" step="1" value="0">
    <span class="hint">填 0 表示不限时，否则为 10 至 600 的整数。</span>
  </label>
  <button type="submit">创建房间</button>
  <p id="form-error" role="alert"></p>
</form>

<h2>房间列表</h2>
<p id="empty-hint">还没有房间记录。</p>
<div id="table-wrap" hidden>
<table>
<thead><tr><th>房间编号</th><th>名称</th><th>规则</th><th>人数上限</th><th>时间限制</th><th>状态</th><th>创建时间</th></tr></thead>
<tbody id="rooms-body"></tbody>
</table>
</div>

<p><a href="/api/rooms">查看房间列表接口</a> · <a href="/health">服务状态</a></p>
</main>
<script>
(function(){
  var form = document.getElementById('create-form');
  var gameSel = document.getElementById('game');
  var capInput = document.getElementById('capacity');
  var ruleHint = document.getElementById('rule-hint');
  var errBox = document.getElementById('form-error');
  var emptyHint = document.getElementById('empty-hint');
  var tableWrap = document.getElementById('table-wrap');
  var tbody = document.getElementById('rooms-body');

  function updateRuleHint(){
    if(gameSel.value === 'gomoku'){
      ruleHint.textContent = '五子棋人数上限固定为 2 人。';
      capInput.min = 2; capInput.max = 2; capInput.value = 2;
    }else{
      ruleHint.textContent = '飞行棋允许 2 至 4 人。';
      capInput.min = 2; capInput.max = 4;
      if(capInput.value < 2 || capInput.value > 4){ capInput.value = 2; }
    }
  }
  gameSel.addEventListener('change', updateRuleHint);

  function gameText(g){ return g === 'gomoku' ? '五子棋' : (g === 'ludo' ? '飞行棋' : g); }
  function statusText(s){ return s === 'waiting' ? '未开始' : s; }
  function turnText(t){ return t === 0 ? '不限时' : String(t); }
  function fmtTime(iso){
    var d = new Date(iso);
    if(isNaN(d.getTime())){ return iso; }
    return d.toLocaleString('zh-CN');
  }

  function render(rooms){
    tbody.innerHTML = '';
    if(!rooms || rooms.length === 0){
      emptyHint.hidden = false;
      tableWrap.hidden = true;
      return;
    }
    emptyHint.hidden = true;
    tableWrap.hidden = false;
    rooms.forEach(function(r){
      var tr = document.createElement('tr');
      var cells = [r.id, r.name, gameText(r.game), r.capacity, turnText(r.turnSeconds), statusText(r.status), fmtTime(r.createdAt)];
      cells.forEach(function(v){
        var td = document.createElement('td');
        td.textContent = (v === null || v === undefined) ? '' : String(v);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function load(){
    emptyHint.textContent = '还没有房间记录。';
    return fetch('/api/rooms').then(function(res){
      if(!res.ok){ throw new Error('HTTP ' + res.status); }
      return res.json();
    }).then(function(data){
      render(data.rooms || []);
    }).catch(function(){
      emptyHint.hidden = false;
      emptyHint.textContent = '房间列表加载失败，请稍后重试。';
      tableWrap.hidden = true;
    });
  }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    errBox.textContent = '';
    var payload = {
      name: document.getElementById('name').value,
      game: gameSel.value,
      capacity: Number(capInput.value),
      turnSeconds: Number(document.getElementById('turnSeconds').value)
    };
    fetch('/api/rooms', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    }).then(function(res){
      return res.json().then(function(data){ return {ok: res.ok, status: res.status, data: data}; });
    }).then(function(r){
      if(r.ok && r.status === 201){
        document.getElementById('name').value = '';
        return load();
      }
      errBox.textContent = (r.data && r.data.error) ? r.data.error : ('创建失败（HTTP ' + r.status + '）。');
    }).catch(function(){
      errBox.textContent = '创建失败：无法连接服务。';
    });
  });

  load();
})();
</script>
</html>`

// Room is the persisted, publicly visible representation of a room.
type Room struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Game        string `json:"game"`
	Capacity    int    `json:"capacity"`
	TurnSeconds int    `json:"turnSeconds"`
	Status      string `json:"status"`
	Visibility  string `json:"visibility"`
	CreatedAt   string `json:"createdAt"`
}

type createRoomRequest struct {
	Name        *string  `json:"name"`
	Game        *string  `json:"game"`
	Capacity    *float64 `json:"capacity"`
	TurnSeconds *float64 `json:"turnSeconds"`
}

type roomStore struct {
	path string
	mu   sync.Mutex
}

func newRoomStore(path string) *roomStore {
	return &roomStore{path: path}
}

// load reads rooms.json. It fails when the file is unreadable or its
// top-level value is not a JSON array; callers must not overwrite the
// file in that case.
func (s *roomStore) load() ([]json.RawMessage, error) {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return nil, err
	}
	var records []json.RawMessage
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, err
	}
	if records == nil {
		return nil, errors.New("rooms file is not a JSON array")
	}
	return records, nil
}

// append validates the request, assigns the next id and atomically
// persists the expanded array. On failure the existing file is never
// replaced and the returned room must not be reported as created.
func (s *roomStore) append(room Room) (Room, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.load()
	if err != nil {
		return room, err
	}
	room.ID = nextRoomID(records)
	data, err := json.Marshal(room)
	if err != nil {
		return room, err
	}
	records = append(records, json.RawMessage(data))
	out, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return room, err
	}
	out = append(out, '\n')
	if err := atomicWrite(s.path, out); err != nil {
		return room, err
	}
	return room, nil
}

func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".rooms-*.json.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	return os.Rename(tmpName, path)
}

// nextRoomID derives the next sequential id from existing records,
// accepting both decimal-string and numeric ids.
func nextRoomID(records []json.RawMessage) string {
	var max int64
	for _, rec := range records {
		var head struct {
			ID json.RawMessage `json:"id"`
		}
		if err := json.Unmarshal(rec, &head); err != nil || len(head.ID) == 0 {
			continue
		}
		var n int64
		if err := json.Unmarshal(head.ID, &n); err != nil {
			var s string
			if json.Unmarshal(head.ID, &s) != nil {
				continue
			}
			if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
				continue
			}
		}
		if n > max {
			max = n
		}
	}
	return fmt.Sprint(max + 1)
}

func buildRoom(req createRoomRequest) (Room, string) {
	if req.Name == nil {
		return Room{}, "name is required"
	}
	name := strings.TrimSpace(*req.Name)
	if n := utf8.RuneCountInString(name); n < 1 || n > 40 {
		return Room{}, "name must be 1 to 40 Unicode code points after trimming surrounding whitespace"
	}
	if req.Game == nil {
		return Room{}, "game is required"
	}
	game := *req.Game
	if game != "gomoku" && game != "ludo" {
		return Room{}, "game must be \"gomoku\" or \"ludo\""
	}
	if req.Capacity == nil {
		return Room{}, "capacity is required"
	}
	capacityFloat := *req.Capacity
	if capacityFloat != math.Trunc(capacityFloat) {
		return Room{}, "capacity must be an integer"
	}
	capacity := int(capacityFloat)
	if game == "gomoku" && capacity != 2 {
		return Room{}, "capacity for gomoku must be 2"
	}
	if game == "ludo" && (capacity < 2 || capacity > 4) {
		return Room{}, "capacity for ludo must be between 2 and 4"
	}
	if req.TurnSeconds == nil {
		return Room{}, "turnSeconds is required"
	}
	turnFloat := *req.TurnSeconds
	if turnFloat != math.Trunc(turnFloat) {
		return Room{}, "turnSeconds must be an integer"
	}
	turnSeconds := int(turnFloat)
	if turnSeconds != 0 && (turnSeconds < 10 || turnSeconds > 600) {
		return Room{}, "turnSeconds must be 0 (unlimited) or an integer between 10 and 600"
	}
	return Room{
		Name:        name,
		Game:        game,
		Capacity:    capacity,
		TurnSeconds: turnSeconds,
		Status:      "waiting",
		Visibility:  "public",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}, ""
}

func (s *roomStore) handleList(w http.ResponseWriter, _ *http.Request) {
	records, err := s.load()
	if err != nil {
		respond(w, http.StatusInternalServerError, map[string]string{"error": "unable to read rooms"})
		return
	}
	respond(w, http.StatusOK, map[string]any{resourceName: records})
}

func (s *roomStore) handleCreate(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		respond(w, http.StatusBadRequest, map[string]string{"error": "unable to read request body"})
		return
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		respond(w, http.StatusBadRequest, map[string]string{"error": "request body must be a single JSON object"})
		return
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		respond(w, http.StatusBadRequest, map[string]string{"error": "request body must be a single JSON object"})
		return
	}
	if dec.More() {
		respond(w, http.StatusBadRequest, map[string]string{"error": "request body must contain exactly one JSON object"})
		return
	}
	var req createRoomRequest
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&req); err != nil {
		respond(w, http.StatusBadRequest, map[string]string{"error": "invalid request: " + err.Error()})
		return
	}
	room, errMsg := buildRoom(req)
	if errMsg != "" {
		respond(w, http.StatusBadRequest, map[string]string{"error": errMsg})
		return
	}
	saved, err := s.append(room)
	if err != nil {
		respond(w, http.StatusInternalServerError, map[string]string{"error": "unable to save room"})
		return
	}
	respond(w, http.StatusCreated, saved)
}

func respond(w http.ResponseWriter, status int, value any, allow ...string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if len(allow) > 0 {
		w.Header().Set("Allow", allow[0])
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func run() error {
	if len(os.Args) < 2 {
		printHelp()
		return errors.New("expected serve or --help")
	}
	if os.Args[1] == "--help" || os.Args[1] == "-h" {
		printHelp()
		return nil
	}
	if os.Args[1] != "serve" {
		return errors.New("expected serve or --help")
	}
	args := flag.NewFlagSet("score-arena serve", flag.ContinueOnError)
	args.SetOutput(os.Stdout)
	host := args.String("host", "127.0.0.1", "address to bind")
	port := args.Int("port", 8080, "port to bind; 0 selects an available port")
	data := args.String("data-dir", "data", "directory for local records")
	if err := args.Parse(os.Args[2:]); errors.Is(err, flag.ErrHelp) {
		return nil
	} else if err != nil {
		return err
	}
	if args.NArg() != 0 {
		return errors.New("unexpected positional argument")
	}
	if *port < 0 || *port > 65535 {
		return errors.New("port must be between 0 and 65535")
	}
	if err := os.MkdirAll(*data, 0700); err != nil {
		return err
	}
	dataFile := filepath.Join(*data, "rooms.json")
	file, err := os.OpenFile(dataFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		_, writeErr := file.WriteString("[]\n")
		closeErr := file.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
	} else if !errors.Is(err, os.ErrExist) {
		return err
	}
	store := newRoomStore(dataFile)
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second}
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				respond(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"}, "GET")
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = fmt.Fprint(w, page)
		case "/health":
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				respond(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"}, "GET")
				return
			}
			respond(w, http.StatusOK, map[string]string{"status": "ok", "product": product})
		case "/api/rooms":
			switch r.Method {
			case http.MethodGet, http.MethodHead:
				store.handleList(w, r)
			case http.MethodPost:
				store.handleCreate(w, r)
			default:
				respond(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"}, "GET, POST")
			}
		default:
			respond(w, http.StatusNotFound, map[string]string{"error": "not found"})
		}
	})
	listener, err := net.Listen("tcp", net.JoinHostPort(*host, fmt.Sprint(*port)))
	if err != nil {
		return err
	}
	fmt.Printf("%s listening on http://%s\n", product, listener.Addr().String())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	failures := make(chan error, 1)
	go func() { failures <- server.Serve(listener) }()
	select {
	case err := <-failures:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			return err
		}
	}
	return nil
}

func printHelp() {
	fmt.Println("ScoreArena - 桌面规则游戏与赛事管理")
	fmt.Println("Usage: go run . serve [--host ADDRESS] [--port PORT] [--data-dir DIRECTORY]")
	fmt.Println("       go run . --help")
	fmt.Println("Defaults: --host 127.0.0.1 --port 8080 --data-dir data")
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
