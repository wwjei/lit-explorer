//go:build darwin

package main

// macOS 把随机加密密钥保存在登录钥匙串；授权文件只保存 AES-GCM 密文。
// 独立 profile 使用独立钥匙串条目，测试和正式应用互不读取。
import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/egoist/mygo"
)

func kdocsMacCipher(create bool) (cipher.AEAD, error) {
	profile, err := appPathUserData()
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(profile))
	account := "kdocs-key-" + hex.EncodeToString(sum[:16])
	secrets := mygo.Secrets.Service("com.litexplorer.app")
	key, err := secrets.Get(account)
	if errors.Is(err, mygo.ErrSecretNotFound) && create {
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		err = secrets.Set(account, key)
	}
	if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("CREDENTIAL_STORAGE")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func protectKdocsCredential(raw []byte) ([]byte, error) {
	aead, err := kdocsMacCipher(true)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, raw, []byte("Lit Explorer kdocs v1")), nil
}
func unprotectKdocsCredential(raw []byte) ([]byte, error) {
	aead, err := kdocsMacCipher(false)
	if err != nil {
		return nil, err
	}
	if len(raw) < aead.NonceSize() {
		return nil, fmt.Errorf("CREDENTIAL_STORAGE")
	}
	return aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], []byte("Lit Explorer kdocs v1"))
}
