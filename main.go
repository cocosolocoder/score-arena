package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const product = "ScoreArena"
const resourceName = "rooms"

//go:embed index.html
var indexPage []byte

// roomConfig 是创建房间时接受的配置。字段是否缺失在 parseRoomFields 中显式检查，
// 不允许把漏填的值悄悄替换为默认值。
type roomConfig struct {
	Name        string `json:"name"`
	Game        string `json:"game"`
	Capacity    int    `json:"capacity"`
	TurnSeconds int    `json:"turnSeconds"`
}

type room struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Game        string `json:"game"`
	Capacity    int    `json:"capacity"`
	TurnSeconds int    `json:"turnSeconds"`
	Status      string `json:"status"`
	Visibility  string `json:"visibility"`
	CreatedAt   string `json:"createdAt"`
}

type roomStore struct {
	mu   sync.Mutex
	path string
}

func newRoomStore(path string) *roomStore {
	return &roomStore{path: path}
}

// load 读取数据文件，返回顶层数组中的原始记录以及已占用的房间编号。
// 文件无法读取或不是合法数组时返回错误，绝不重置已有数据。
// 顶层 JSON 值必须是数组：null、对象、字符串等都不是“没有房间”，
// （Go 把顶层 null 解进切片会当成无操作而得到空切片，因此必须先辨别类型）
// 只有空数组才表示没有记录。数组中的非对象元素原样保留（兼容历史记录及其附带字段）。
func (s *roomStore) load() ([]json.RawMessage, map[string]bool, error) {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return nil, nil, fmt.Errorf("读取房间数据失败: %w", err)
	}
	// 先解出顶层原始值：json.Decoder 会跳过 null 前后的合法 JSON 空白，
	// 既能精确判断顶层类型，也顺带拒绝尾随多余内容。
	var top json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, nil, fmt.Errorf("房间数据不是合法的数组: %w", err)
	}
	trimmed := strings.TrimSpace(string(top))
	if trimmed == "" || trimmed[0] != '[' {
		return nil, nil, errors.New("房间数据必须是数组，不能是 null 或其他非数组内容")
	}
	var records []json.RawMessage
	if err := json.Unmarshal(top, &records); err != nil {
		return nil, nil, fmt.Errorf("房间数据不是合法的数组: %w", err)
	}
	used := make(map[string]bool, len(records))
	for _, rec := range records {
		var probe struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(rec, &probe); err == nil && probe.ID != "" {
			used[probe.ID] = true
		}
	}
	return records, used, nil
}

// create 校验配置、写入新记录并返回保存后的房间。
func (s *roomStore) create(cfg roomConfig) (room, int, error) {
	if code, msg, ok := validateConfig(cfg); !ok {
		return room{}, code, errors.New(msg)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	records, used, err := s.load()
	if err != nil {
		return room{}, http.StatusInternalServerError, err
	}

	now := time.Now()
	newRoom := room{
		ID:          uniqueRoomID(used),
		Name:        strings.TrimSpace(cfg.Name),
		Game:        cfg.Game,
		Capacity:    cfg.Capacity,
		TurnSeconds: cfg.TurnSeconds,
		Status:      "waiting",
		Visibility:  "public",
		CreatedAt:   now.UTC().Format(time.RFC3339),
	}

	encoded, err := json.Marshal(newRoom)
	if err != nil {
		return room{}, http.StatusInternalServerError, fmt.Errorf("序列化房间记录失败: %w", err)
	}
	records = append(records, encoded)
	if err := s.writeAtomic(records); err != nil {
		return room{}, http.StatusInternalServerError, err
	}
	return newRoom, http.StatusCreated, nil
}

// writeAtomic 先写临时文件再重命名，避免保存失败时破坏原有数据。
func (s *roomStore) writeAtomic(records []json.RawMessage) error {
	payload, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化房间数据失败: %w", err)
	}
	payload = append(payload, '\n')

	dir := filepath.Dir(s.path)
	tmp, err := os.CreateTemp(dir, ".rooms-*.tmp")
	if err != nil {
		return fmt.Errorf("创建临时数据文件失败: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }

	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("写入房间数据失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("同步房间数据失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("关闭临时数据文件失败: %w", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		cleanup()
		return fmt.Errorf("保存房间数据失败: %w", err)
	}
	return nil
}

func uniqueRoomID(used map[string]bool) string {
	var b [16]byte
	for {
		if _, err := rand.Read(b[:]); err != nil {
			panic(fmt.Errorf("生成房间编号失败: %w", err))
		}
		id := hex.EncodeToString(b[:])
		if !used[id] {
			return id
		}
	}
}

// validateConfig 执行全部字段校验，返回 http 状态码与具体原因。
// 所有字段都必须明确提交且合法，不使用任何默认值。
func validateConfig(cfg roomConfig) (int, string, bool) {
	name := strings.TrimSpace(cfg.Name)
	if name == "" {
		return http.StatusBadRequest, "房间名称不能为空", false
	}
	if len([]rune(name)) > 40 {
		return http.StatusBadRequest, "房间名称去掉首尾空白后不能超过 40 个字符", false
	}

	switch cfg.Game {
	case "gomoku":
		if cfg.Capacity != 2 {
			return http.StatusBadRequest, "五子棋的人数上限固定为 2 人", false
		}
	case "ludo":
		if cfg.Capacity < 2 || cfg.Capacity > 4 {
			return http.StatusBadRequest, "飞行棋的人数上限必须为 2 至 4 人", false
		}
	default:
		return http.StatusBadRequest, "未知游戏规则，目前仅支持 gomoku（五子棋）和 ludo（飞行棋）", false
	}

	if cfg.TurnSeconds != 0 && (cfg.TurnSeconds < 10 || cfg.TurnSeconds > 600) {
		return http.StatusBadRequest, "每步时间限制只能为 0（不限时）或 10 至 600 秒之间的整数", false
	}
	return 0, "", true
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Allow", allow)
	w.WriteHeader(http.StatusMethodNotAllowed)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "method not allowed"})
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
	store := newRoomStore(dataFile)

	// 首次启动时初始化空数组；已存在则原样保留。
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

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			respond(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		if r.Method != http.MethodGet {
			methodNotAllowed(w, "GET")
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(indexPage)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, "GET")
			return
		}
		respond(w, http.StatusOK, map[string]string{"status": "ok", "product": product})
	})
	mux.HandleFunc("/api/rooms", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			store.mu.Lock()
			records, _, err := store.load()
			store.mu.Unlock()
			if err != nil {
				respond(w, http.StatusInternalServerError, map[string]string{"error": "无法读取房间数据：" + err.Error()})
				return
			}
			respond(w, http.StatusOK, map[string]any{resourceName: records})
		case http.MethodPost:
			handleCreateRoom(w, r, store)
		default:
			methodNotAllowed(w, "GET, POST")
		}
	})

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
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

func handleCreateRoom(w http.ResponseWriter, r *http.Request, store *roomStore) {
	// 限制请求体大小，避免异常大载荷。
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		respond(w, http.StatusBadRequest, map[string]string{"error": "读取请求体失败：" + err.Error()})
		return
	}

	cfg, ok := parseRoomFields(w, body)
	if !ok {
		return
	}

	newRoom, status, err := store.create(cfg)
	if err != nil {
		respond(w, status, map[string]string{"error": err.Error()})
		return
	}
	respond(w, http.StatusCreated, newRoom)
}

func parseRoomFields(w http.ResponseWriter, body []byte) (roomConfig, bool) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		respond(w, http.StatusBadRequest, map[string]string{"error": "请求体必须是单个 JSON 对象"})
		return roomConfig{}, false
	}

	var cfg roomConfig
	missing := func(key string) (roomConfig, bool) {
		respond(w, http.StatusBadRequest, map[string]string{"error": "缺少必填字段：" + key})
		return roomConfig{}, false
	}

	rawName, ok := fields["name"]
	if !ok {
		return missing("name")
	}
	if err := json.Unmarshal(rawName, &cfg.Name); err != nil {
		respond(w, http.StatusBadRequest, map[string]string{"error": "name 必须是字符串"})
		return roomConfig{}, false
	}

	rawGame, ok := fields["game"]
	if !ok {
		return missing("game")
	}
	if err := json.Unmarshal(rawGame, &cfg.Game); err != nil {
		respond(w, http.StatusBadRequest, map[string]string{"error": "game 必须是字符串"})
		return roomConfig{}, false
	}

	rawCapacity, ok := fields["capacity"]
	if !ok {
		return missing("capacity")
	}
	capacity, err := parseStrictInt(rawCapacity)
	if err != nil {
		respond(w, http.StatusBadRequest, map[string]string{"error": "capacity 必须是整数：" + err.Error()})
		return roomConfig{}, false
	}
	cfg.Capacity = capacity

	rawTurn, ok := fields["turnSeconds"]
	if !ok {
		return missing("turnSeconds")
	}
	turn, err := parseStrictInt(rawTurn)
	if err != nil {
		respond(w, http.StatusBadRequest, map[string]string{"error": "turnSeconds 必须是整数：" + err.Error()})
		return roomConfig{}, false
	}
	cfg.TurnSeconds = turn

	return cfg, true
}

// parseStrictInt 只接受单个 JSON 整数（拒绝小数、科学计数法、字符串、布尔、null、对象、数组及尾随内容）。
func parseStrictInt(raw json.RawMessage) (int, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return 0, errors.New("值不是数字")
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return 0, errors.New("包含多余内容")
	}
	// 带引号的字符串会解成 Go string 而非 json.Number，断言失败即可拒绝。
	n, ok := v.(json.Number)
	if !ok {
		return 0, errors.New("值不是数字")
	}
	i, err := n.Int64()
	if err != nil {
		return 0, errors.New("不是整数（不接受小数）")
	}
	return int(i), nil
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
