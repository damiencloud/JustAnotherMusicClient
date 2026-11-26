use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const DEFAULT_REMOTE_PORT: u16 = 9863;
pub const REMOTE_CONTROL_ACTION_EVENT: &str = "remote-control:action";

static REMOTE_SERVER_INSTANCE: OnceLock<Arc<RemoteServer>> = OnceLock::new();

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub artwork_url: Option<String>,
    #[serde(default)]
    pub duration_sec: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemotePlaybackState {
    pub status: String,
    pub current_track: Option<RemoteTrack>,
    pub current_time: f64,
    pub duration: f64,
    pub volume: f64,
    pub muted: bool,
    pub playback_order_mode: String,
    #[serde(default)]
    pub queue: Vec<RemoteTrack>,
    #[serde(default)]
    pub queue_index: usize,
}

impl Default for RemotePlaybackState {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            current_track: None,
            current_time: 0.0,
            duration: 0.0,
            volume: 1.0,
            muted: false,
            playback_order_mode: "in-order".to_string(),
            queue: Vec::new(),
            queue_index: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteActionPayload {
    pub action: String,
    #[serde(default)]
    pub time: Option<f64>,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub index: Option<usize>,
    #[serde(default)]
    pub video_id: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub track: Option<RemoteTrack>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerStatus {
    pub enabled: bool,
    pub port: u16,
    pub addresses: Vec<String>,
    pub default_url: String,
}

pub struct RemoteServer {
    app: AppHandle,
    state: Arc<Mutex<RemotePlaybackState>>,
    clients: Arc<Mutex<Vec<TcpStream>>>,
    port: Arc<Mutex<u16>>,
    enabled: Arc<Mutex<bool>>,
    search_results: Arc<Mutex<Option<serde_json::Value>>>,
}

impl RemoteServer {
    pub fn new(app: AppHandle, port: u16) -> Arc<Self> {
        let server = Arc::new(Self {
            app,
            state: Arc::new(Mutex::new(RemotePlaybackState::default())),
            clients: Arc::new(Mutex::new(Vec::new())),
            port: Arc::new(Mutex::new(port)),
            enabled: Arc::new(Mutex::new(true)),
            search_results: Arc::new(Mutex::new(None)),
        });

        let server_clone = Arc::clone(&server);
        thread::spawn(move || {
            server_clone.run_listener();
        });

        // Heartbeat thread for SSE streams
        let heartbeat_clients = Arc::clone(&server.clients);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(15));
            let mut list = match heartbeat_clients.lock() {
                Ok(guard) => guard,
                Err(_) => continue,
            };
            list.retain_mut(|stream| {
                stream.set_write_timeout(Some(Duration::from_millis(500))).ok();
                stream.write_all(b": ping\n\n").is_ok()
            });
        });

        server
    }

    fn run_listener(&self) {
        let port = *self.port.lock().unwrap_or_else(|e| e.into_inner());
        let bind_addr = ("0.0.0.0", port);
        let listener = match TcpListener::bind(bind_addr) {
            Ok(l) => l,
            Err(err) => {
                eprintln!("[remote_server] Failed to bind to 0.0.0.0:{}: {}", port, err);
                return;
            }
        };

        eprintln!("[remote_server] Listening on http://0.0.0.0:{}", port);

        for stream in listener.incoming() {
            let is_enabled = *self.enabled.lock().unwrap_or_else(|e| e.into_inner());
            match stream {
                Ok(stream) => {
                    if !is_enabled {
                        let mut s = stream;
                        let _ = s.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
                        continue;
                    }
                    let state = Arc::clone(&self.state);
                    let clients = Arc::clone(&self.clients);
                    let app = self.app.clone();
                    let search_results = Arc::clone(&self.search_results);
                    thread::spawn(move || {
                        handle_connection(stream, state, clients, app, search_results);
                    });
                }
                Err(err) => {
                    eprintln!("[remote_server] Incoming connection error: {}", err);
                }
            }
        }
    }

    pub fn update_state(&self, new_state: RemotePlaybackState) {
        if let Ok(mut current) = self.state.lock() {
            *current = new_state.clone();
        }

        // Broadcast to all SSE clients
        if let Ok(json) = serde_json::to_string(&new_state) {
            let message = format!("event: state\ndata: {}\n\n", json);
            if let Ok(mut clients) = self.clients.lock() {
                clients.retain_mut(|stream| {
                    stream.set_write_timeout(Some(Duration::from_millis(500))).ok();
                    stream.write_all(message.as_bytes()).is_ok()
                });
            }
        }
    }

    pub fn set_search_results(&self, results: serde_json::Value) {
        if let Ok(mut lock) = self.search_results.lock() {
            *lock = Some(results);
        }
    }

    pub fn get_status(&self) -> RemoteServerStatus {
        let enabled = *self.enabled.lock().unwrap_or_else(|e| e.into_inner());
        let port = *self.port.lock().unwrap_or_else(|e| e.into_inner());
        let mut addresses = Vec::new();

        if let Some(local_ip) = get_local_ip() {
            addresses.push(format!("http://{}:{}", local_ip, port));
        }
        addresses.push(format!("http://127.0.0.1:{}", port));

        let default_url = addresses.first().cloned().unwrap_or_else(|| format!("http://localhost:{}", port));

        RemoteServerStatus {
            enabled,
            port,
            addresses,
            default_url,
        }
    }

    pub fn set_enabled(&self, val: bool) {
        if let Ok(mut e) = self.enabled.lock() {
            *e = val;
        }
    }
}

pub fn get_or_init_remote_server(app: &AppHandle) -> Arc<RemoteServer> {
    REMOTE_SERVER_INSTANCE
        .get_or_init(|| RemoteServer::new(app.clone(), DEFAULT_REMOTE_PORT))
        .clone()
}

fn get_local_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    let ip = addr.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        None
    } else {
        Some(ip.to_string())
    }
}

const EMBEDDED_HTML: &str = include_str!("../../src/internal/remote/mobile_remote.html");
const EMBEDDED_MANIFEST: &str = include_str!("../../src/internal/remote/manifest.json");
const EMBEDDED_ICON: &[u8] = include_bytes!("../icons/128x128.png");

fn handle_connection(
    mut stream: TcpStream,
    state: Arc<Mutex<RemotePlaybackState>>,
    clients: Arc<Mutex<Vec<TcpStream>>>,
    app: AppHandle,
    search_results: Arc<Mutex<Option<serde_json::Value>>>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buffer = [0u8; 8192];
    let read_len = match stream.read(&mut buffer) {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    let request_str = String::from_utf8_lossy(&buffer[..read_len]);
    let mut lines = request_str.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let raw_path = parts.next().unwrap_or_default();
    let path = raw_path.split('?').next().unwrap_or_default();

    // CORS preflight
    if method == "OPTIONS" {
        let response = "HTTP/1.1 204 No Content\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
Access-Control-Max-Age: 86400\r\n\
Content-Length: 0\r\n\r\n";
        let _ = stream.write_all(response.as_bytes());
        return;
    }

    if method == "GET" {
        if path == "/" || path == "/index.html" || path == "/remote.html" {
            let html_bytes = EMBEDDED_HTML.as_bytes();
            let headers = format!(
                "HTTP/1.1 200 OK\r\n\
Content-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\
Cache-Control: no-cache\r\n\r\n",
                html_bytes.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(html_bytes);
            return;
        }

        if path == "/manifest.json" {
            let manifest_bytes = EMBEDDED_MANIFEST.as_bytes();
            let headers = format!(
                "HTTP/1.1 200 OK\r\n\
Content-Type: application/manifest+json; charset=utf-8\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\
Cache-Control: public, max-age=3600\r\n\r\n",
                manifest_bytes.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(manifest_bytes);
            return;
        }

        if path == "/icon.png" {
            let headers = format!(
                "HTTP/1.1 200 OK\r\n\
Content-Type: image/png\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\
Cache-Control: public, max-age=86400\r\n\r\n",
                EMBEDDED_ICON.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(EMBEDDED_ICON);
            return;
        }

        if path == "/api/state" {
            let current = state.lock().map(|s| s.clone()).unwrap_or_default();
            let json = serde_json::to_string(&current).unwrap_or_else(|_| "{}".to_string());
            let json_bytes = json.as_bytes();
            let headers = format!(
                "HTTP/1.1 200 OK\r\n\
Content-Type: application/json; charset=utf-8\r\n\
Access-Control-Allow-Origin: *\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\
Cache-Control: no-cache, no-store\r\n\r\n",
                json_bytes.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(json_bytes);
            return;
        }

        if path == "/api/events" {
            // Keep-alive SSE stream
            let headers = "HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
Cache-Control: no-cache, no-transform\r\n\
Connection: keep-alive\r\n\
Access-Control-Allow-Origin: *\r\n\
X-Accel-Buffering: no\r\n\r\n";
            if stream.write_all(headers.as_bytes()).is_err() {
                return;
            }

            // Send initial state
            let current = state.lock().map(|s| s.clone()).unwrap_or_default();
            if let Ok(json) = serde_json::to_string(&current) {
                let init_msg = format!("event: state\ndata: {}\n\n", json);
                if stream.write_all(init_msg.as_bytes()).is_err() {
                    return;
                }
            }

            // Disable timeouts for persistent SSE connection
            let _ = stream.set_read_timeout(None);
            let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

            if let Ok(mut list) = clients.lock() {
                list.push(stream);
            }
            return;
        }

        if path == "/api/search" {
            let query = raw_path
                .split('?')
                .nth(1)
                .and_then(|qs| {
                    qs.split('&').find_map(|pair| {
                        let mut p = pair.split('=');
                        if p.next() == Some("q") {
                            p.next()
                        } else {
                            None
                        }
                    })
                })
                .map(|q| urlencoding_decode(q))
                .unwrap_or_default();

            // Emit search query event to desktop frontend
            let _ = app.emit("remote-control:search", serde_json::json!({ "query": query }));

            // Wait briefly up to 1200ms for desktop to populate search results
            let mut results_json = serde_json::json!({ "results": [] });
            for _ in 0..12 {
                thread::sleep(Duration::from_millis(100));
                if let Ok(mut guard) = search_results.lock() {
                    if let Some(res) = guard.take() {
                        results_json = res;
                        break;
                    }
                }
            }

            let body = results_json.to_string();
            let body_bytes = body.as_bytes();
            let headers = format!(
                "HTTP/1.1 200 OK\r\n\
Content-Type: application/json; charset=utf-8\r\n\
Access-Control-Allow-Origin: *\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\r\n",
                body_bytes.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(body_bytes);
            return;
        }
    }

    if method == "POST" && path == "/api/action" {
        // Find body after \r\n\r\n
        let body_str = if let Some(idx) = request_str.find("\r\n\r\n") {
            &request_str[idx + 4..]
        } else {
            ""
        };

        if let Ok(payload) = serde_json::from_str::<RemoteActionPayload>(body_str) {
            let _ = app.emit(REMOTE_CONTROL_ACTION_EVENT, payload);
            let resp = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}";
            let _ = stream.write_all(resp);
            return;
        } else {
            let resp = b"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 26\r\nConnection: close\r\n\r\n{\"error\":\"Invalid payload\"}";
            let _ = stream.write_all(resp);
            return;
        }
    }

    // Default 404
    let not_found = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let _ = stream.write_all(not_found);
}

fn urlencoding_decode(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

// Tauri commands
#[tauri::command]
pub fn remote_server_get_status(app: AppHandle) -> Result<RemoteServerStatus, String> {
    let server = get_or_init_remote_server(&app);
    Ok(server.get_status())
}

#[tauri::command]
pub fn remote_server_set_enabled(app: AppHandle, enabled: bool) -> Result<RemoteServerStatus, String> {
    let server = get_or_init_remote_server(&app);
    server.set_enabled(enabled);
    Ok(server.get_status())
}

#[tauri::command]
pub fn remote_server_update_state(app: AppHandle, state: RemotePlaybackState) -> Result<(), String> {
    let server = get_or_init_remote_server(&app);
    server.update_state(state);
    Ok(())
}

#[tauri::command]
pub fn remote_server_set_search_results(app: AppHandle, results: serde_json::Value) -> Result<(), String> {
    let server = get_or_init_remote_server(&app);
    server.set_search_results(results);
    Ok(())
}
