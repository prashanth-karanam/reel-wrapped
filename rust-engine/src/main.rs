use rayon::prelude::*;
use reel_wrapped_engine::{analyze_raw_thread_json, FriendDossier};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tiny_http::{Header, Response, Server};

fn collect_message_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_message_files(&path, out);
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("message_") && name.ends_with(".json") {
                    out.push(path);
                }
            }
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let scan_path = args.get(1).map(|s| s.as_str()).unwrap_or(".");
    let port = args.get(2).and_then(|p| p.parse::<u16>().ok()).unwrap_or(8765);

    println!("⚡ Reel Wrapped Rust Engine v2.4.0 — Initializing Parallel Telemetry...");
    let start = Instant::now();

    let mut json_files = Vec::new();
    collect_message_files(Path::new(scan_path), &mut json_files);

    let mut dossiers: Vec<FriendDossier> = json_files
        .par_iter()
        .enumerate()
        .filter_map(|(idx, path)| {
            let content = fs::read_to_string(path).ok()?;
            analyze_raw_thread_json(&content, idx + 1)
        })
        .collect();

    dossiers.sort_by(|a, b| b.total_reels.cmp(&a.total_reels));
    for (i, d) in dossiers.iter_mut().enumerate() {
        d.rank = i + 1;
    }

    let elapsed = start.elapsed();
    println!(
        "✔ Scanned {} message archives across all CPU cores in {:.2?} ({} active Reel threads)",
        json_files.len(),
        elapsed,
        dossiers.len()
    );

    let shared_json = Arc::new(serde_json::to_string(&dossiers).unwrap_or_else(|_| "[]".to_string()));
    let addr = format!("127.0.0.1:{}", port);
    let url = format!("http://{}", addr);

    println!("🚀 Launching Reel Wrapped UI at {} (Mobile & Web Ready)", url);
    let _ = webbrowser::open(&url);

    let server = Server::http(&addr).expect("Failed to bind local Rust HTTP server");
    let index_html = fs::read_to_string("index.html").unwrap_or_else(|_| {
        "<h1>Reel Wrapped Rust Engine Running</h1>".to_string()
    });

    for request in server.incoming_requests() {
        let cors = Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap();
        let req_url = request.url().to_string();

        if req_url.starts_with("/api/status") {
            let status_body = format!(
                r#"{{"engine":"rust-native-rayon","version":"2.4.0","threadsScanned":{},"elapsedMicros":{}}}"#,
                dossiers.len(),
                elapsed.as_micros()
            );
            let content_type = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
            let _ = request.respond(Response::from_string(status_body).with_header(cors).with_header(content_type));
        } else if req_url.starts_with("/api/friends") {
            let content_type = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
            let _ = request.respond(
                Response::from_string((*shared_json).clone())
                    .with_header(cors)
                    .with_header(content_type),
            );
        } else {
            let content_type = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap();
            let _ = request.respond(
                Response::from_string(index_html.clone())
                    .with_header(cors)
                    .with_header(content_type),
            );
        }
    }
}
