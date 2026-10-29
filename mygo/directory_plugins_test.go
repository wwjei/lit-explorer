package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

type directoryRoundTrip func(*http.Request) (*http.Response, error)

func (fn directoryRoundTrip) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }
func TestDirectoryPluginFeishuContract(t *testing.T) {
	isolateState(t)
	bytes, err := os.ReadFile("../test/fixtures/feishu-directory.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures map[string]json.RawMessage
	if err := json.Unmarshal(bytes, &fixtures); err != nil {
		t.Fatal(err)
	}
	s := newDirectoryPlugins()
	s.activate("project-a")
	calls := 0
	mode := "normal"
	s.client.Transport = directoryRoundTrip(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.Host != "open.feishu.cn" || req.Header.Get("Authorization") != "Bearer fixture-secret" {
			t.Fatalf("unexpected request: %s", req.URL)
		}
		if mode == "auth" {
			return &http.Response{StatusCode: 401, Body: io.NopCloser(strings.NewReader("{}"))}, nil
		}
		response := fixtures["firstPage"]
		if strings.HasSuffix(req.URL.Path, "batch_query") {
			if req.Method != "POST" {
				t.Fatal("metadata method is not POST")
			}
			var body map[string]any
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["with_url"] != true {
				t.Fatal("metadata did not request URL")
			}
			response = fixtures["details"]
			if mode == "unsafe" {
				response = json.RawMessage(strings.ReplaceAll(string(response), "tenant.feishu.cn", "feishu.cn.evil.example"))
			}
		} else if req.URL.Query().Get("page_token") != "" {
			response = fixtures["lastPage"]
		} else if req.URL.Query().Get("folder_token") == "folderA" {
			response = fixtures["nestedPage"]
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(response)))}, nil
	})
	result, err := s.connect(map[string]any{"providerId": "feishu-drive", "rootId": "root", "name": "资料", "token": "fixture-secret"})
	if err != nil {
		t.Fatal(err)
	}
	mountID := result.(map[string]any)["id"].(string)
	data, _ := json.Marshal(loadState())
	if strings.Contains(string(data), "fixture-secret") {
		t.Fatal("token persisted")
	}
	session, node, err := s.getNode(mountID, "root")
	if err != nil || node.Kind != "directory" {
		t.Fatalf("root: %v %v", node, err)
	}
	page, err := s.page(session, "root", "", false)
	if err != nil || len(page.Entries) != 2 || calls != 1 {
		t.Fatalf("cached page: %v %v calls=%d", page, err, calls)
	}
	next, err := s.page(session, "root", page.NextCursor, false)
	if err != nil || len(next.Entries) != 1 {
		t.Fatalf("page two: %v %v", next, err)
	}
	if _, err := s.page(session, "root", "forged", false); err == nil || err.Error() != "OUTSIDE_MOUNT" {
		t.Fatalf("forged cursor accepted: %v", err)
	}
	if _, _, err := s.getNode(mountID, "outside"); err == nil {
		t.Fatal("outside node accepted")
	}
	if _, err := s.page(session, "folderA", "", false); err != nil {
		t.Fatal(err)
	}
	detail, err := s.details(mountID, "docA")
	if err != nil || detail.URL != "https://tenant.feishu.cn/docx/docA" {
		t.Fatalf("detail: %v %v", detail, err)
	}
	mode = "unsafe"
	if _, err := s.details(mountID, "docA"); err == nil || err.Error() != "UNSAFE_URL" {
		t.Fatalf("unsafe link: %v", err)
	}
	mode = "auth"
	if _, err := s.page(session, "root", "", true); err == nil || err.Error() != "AUTH_REQUIRED" {
		t.Fatalf("expired token: %v", err)
	}
	if s.mounts()[0]["connected"] != false {
		t.Fatal("expired session retained")
	}
	mode = "normal"
	if _, err := s.connect(map[string]any{"id": mountID, "token": "fixture-secret"}); err != nil {
		t.Fatal(err)
	}
	s.activate("project-b")
	if len(s.mounts()) != 0 {
		t.Fatal("mount crossed projects")
	}
	if _, _, err := s.getNode(mountID, "root"); err == nil {
		t.Fatal("session crossed projects")
	}
	s.activate("project-a")
	if s.mounts()[0]["connected"] != false {
		t.Fatal("credentials restored after activation")
	}
	s.remove(mountID)
	if len(s.mounts()) != 0 {
		t.Fatal("mount not removed")
	}
	patchFromPage(map[string]any{"directoryMounts": map[string]any{"project-a": []any{map[string]any{"id": "forged"}}}})
	if len(s.mounts()) != 0 {
		t.Fatal("page forged mount configuration")
	}
}

func TestDirectoryPluginDocumentAndWiki(t *testing.T) {
	isolateState(t)
	data, err := os.ReadFile("../test/fixtures/feishu-directory.json")
	if err != nil {
		t.Fatal(err)
	}
	fixtures := map[string]json.RawMessage{}
	json.Unmarshal(data, &fixtures)
	s := newDirectoryPlugins()
	s.activate("specific")
	s.client.Transport = directoryRoundTrip(func(req *http.Request) (*http.Response, error) {
		var response []byte
		if strings.HasSuffix(req.URL.Path, "get_node") {
			response = fixtures["wikiRoot"]
		} else if strings.Contains(req.URL.Path, "/wiki/") {
			if req.URL.Path != "/open-apis/wiki/v2/spaces/space123/nodes" || req.URL.Query().Get("parent_node_token") != "wikiRoot" {
				t.Fatalf("wiki scope: %s", req.URL)
			}
			response = fixtures["wikiPage"]
		} else {
			var body struct {
				Docs []struct {
					Token string `json:"doc_token"`
					Type  string `json:"doc_type"`
				} `json:"request_docs"`
			}
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil || len(body.Docs) != 1 {
				t.Fatalf("metadata body: %v", err)
			}
			doc := body.Docs[0]
			response, _ = json.Marshal(map[string]any{"code": 0, "data": map[string]any{"metas": []any{map[string]any{"doc_token": doc.Token, "doc_type": doc.Type, "title": "在线文档", "url": "https://tenant.feishu.cn/docx/" + doc.Token}}}})
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(response)))}, nil
	})
	document, err := s.connect(map[string]any{"providerId": "feishu-document", "rootId": "https://tenant.feishu.cn/docx/docA", "name": "具体文档", "token": "fixture-secret"})
	if err != nil {
		t.Fatal(err)
	}
	doc := document.(map[string]any)
	if doc["rootKind"] != "document" || doc["rootId"] != "docA" {
		t.Fatalf("single document: %v", doc)
	}
	if _, err := s.open(doc["id"].(string), "docA"); err != nil {
		t.Fatal(err)
	}
	wiki, err := s.connect(map[string]any{"providerId": "feishu-wiki", "rootId": "https://tenant.feishu.cn/wiki/wikiRoot", "name": "Wiki目录", "token": "fixture-secret"})
	if err != nil {
		t.Fatal(err)
	}
	mount := wiki.(map[string]any)
	id := mount["id"].(string)
	session, _, err := s.getNode(id, "wikiRoot")
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.page(session, "wikiRoot", "", false)
	if err != nil || len(page.Entries) != 1 || page.Entries[0].DocumentID != "wikiDocChild" {
		t.Fatalf("wiki listing: %v %v", page, err)
	}
	for _, nodeID := range []string{"wikiRoot", "wikiChild"} {
		if _, err := s.open(id, nodeID); err != nil {
			t.Fatal(err)
		}
	}
	detail, err := s.details(id, "wikiRoot")
	if err != nil || detail.Name != "知识库入口" {
		t.Fatalf("wiki details: %v %v", detail, err)
	}
	wikiDocument, err := s.connect(map[string]any{"providerId": "feishu-wiki-document", "rootId": "https://tenant.feishu.cn/wiki/wikiRoot", "name": "具体Wiki文档", "token": "fixture-secret"})
	if err != nil {
		t.Fatal(err)
	}
	single := wikiDocument.(map[string]any)
	if single["rootKind"] != "document" {
		t.Fatalf("wiki single: %v", single)
	}
	if _, err := s.open(single["id"].(string), "wikiRoot"); err != nil {
		t.Fatal(err)
	}
}

func TestDirectoryPluginCancelsPendingConnection(t *testing.T) {
	isolateState(t)
	s := newDirectoryPlugins()
	s.activate("old-project")
	started := make(chan struct{})
	done := make(chan error, 1)
	s.client.Transport = directoryRoundTrip(func(req *http.Request) (*http.Response, error) {
		close(started)
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	go func() {
		_, err := s.connect(map[string]any{"providerId": "feishu-drive", "rootId": "root", "token": "fixture-secret", "attemptId": "pending"})
		done <- err
	}()
	<-started
	s.activate("new-project")
	err := <-done
	if err == nil || err.Error() != "SUPERSEDED" {
		t.Fatalf("old connection survived: %v", err)
	}
	if len(s.mounts()) != 0 {
		t.Fatal("pending connection persisted across projects")
	}
}
