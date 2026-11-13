package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/egoist/mygo"
)

// Go FileServer 会把显式 index.html 重定向到目录；WKURLSchemeHandler 不跟随该响应。
// 产品入口必须直接返回 HTML，防止只有注入桥而页面空白。
func TestFrontendEntryServesHTMLWithoutRedirect(t *testing.T) {
	files, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	mygo.FileServer(files).ServeHTTP(response, httptest.NewRequest("GET", "mygo://localhost/src/renderer/", nil))
	if response.Code != http.StatusOK || response.Header().Get("Location") != "" || !strings.Contains(response.Body.String(), `id="root-name"`) {
		t.Fatalf("frontend entry: status=%d location=%q", response.Code, response.Header().Get("Location"))
	}
}
