package main

import (
	"encoding/json"
	"net/http"
)

// appVersion is overridden at build time:
// -ldflags "-X main.appVersion=${APP_VERSION}"
var appVersion = "dev"

// handleVersion serves GET and HEAD /version with the build's version string.
// It sits next to /healthz, outside /api/, so the Caddy forward_auth does not apply.
func handleVersion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "method not allowed"})
		return
	}

	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"version": appVersion})
}
