//go:build windows

package main

// 使用当前 Windows 用户的 DPAPI；不生成可复制的本地解密密钥。
import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

type kdocsDataBlob struct {
	size uint32
	data *byte
}

var kdocsCrypt32 = syscall.NewLazyDLL("crypt32.dll")
var kdocsProtect = kdocsCrypt32.NewProc("CryptProtectData")
var kdocsUnprotect = kdocsCrypt32.NewProc("CryptUnprotectData")
var kdocsLocalFree = syscall.NewLazyDLL("kernel32.dll").NewProc("LocalFree")

func kdocsProtection(raw []byte, decrypt bool) ([]byte, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("CREDENTIAL_STORAGE")
	}
	input := kdocsDataBlob{uint32(len(raw)), &raw[0]}
	var output kdocsDataBlob
	proc := kdocsProtect
	if decrypt {
		proc = kdocsUnprotect
	}
	success, _, _ := proc.Call(uintptr(unsafe.Pointer(&input)), 0, 0, 0, 0, 1, uintptr(unsafe.Pointer(&output)))
	runtime.KeepAlive(raw)
	if output.data != nil {
		defer kdocsLocalFree.Call(uintptr(unsafe.Pointer(output.data)))
	}
	if success == 0 || output.data == nil || output.size > 65536 {
		return nil, fmt.Errorf("CREDENTIAL_STORAGE")
	}
	return append([]byte(nil), unsafe.Slice(output.data, int(output.size))...), nil
}
func protectKdocsCredential(raw []byte) ([]byte, error)   { return kdocsProtection(raw, false) }
func unprotectKdocsCredential(raw []byte) ([]byte, error) { return kdocsProtection(raw, true) }
