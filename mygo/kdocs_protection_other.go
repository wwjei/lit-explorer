//go:build !windows

package main

import "fmt"

func protectKdocsCredential([]byte) ([]byte, error)   { return nil, fmt.Errorf("CREDENTIAL_STORAGE") }
func unprotectKdocsCredential([]byte) ([]byte, error) { return nil, fmt.Errorf("CREDENTIAL_STORAGE") }
