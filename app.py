import os
import sys
import io
import time
import json
import re
import datetime
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from collections import defaultdict, Counter
from getpass import getpass

if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn
    from rich.prompt import Prompt, Confirm
    from rich import box
    from instagrapi import Client
    from instagrapi.exceptions import (
        BadPassword,
        TwoFactorRequired,
        ChallengeRequired,
        LoginRequired,
    )
except ImportError:
    print("Missing packages. Run: pip install instagrapi rich requests")
    sys.exit(1)

console = Console()

TOOLKIT_DIR = Path.home() / ".ig_toolkit"
SESSION_FILE = TOOLKIT_DIR / "session.json"
USER_FILE = TOOLKIT_DIR / "user.txt"
CACHE_DIR = TOOLKIT_DIR / "cache"
VAULT_JSON_FILE = TOOLKIT_DIR / "reel_wrapped_local_vault.json"

TOOLKIT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def get_instagram_client() -> Client:
    cl = Client()
    cl.private_transport = "requests"
    cl.public_transport = "requests"
    cl.request_timeout = 0
    return cl


def parse_timestamp(ts) -> datetime.datetime:
    try:
        val = float(ts or 0)
        if val <= 0:
            return datetime.datetime.now()
        if val > 1e11:
            val /= 1_000_000
        return datetime.datetime.fromtimestamp(val)
    except Exception:
        return datetime.datetime.now()


def is_reel(item: dict) -> bool:
    itype = str(item.get("item_type", "")).lower()
    if itype in ("clip", "xma_clip", "felix_share"):
        return True
    if itype in ("media_share", "xma_media_share"):
        xma_list = item.get("xma_media_share") or item.get("xma") or []
        if isinstance(xma_list, list) and xma_list:
            x0 = xma_list[0]
            if x0.get("playable_url") or x0.get("video_dash_manifest") or x0.get("video_codec"):
                return True
            target = str(x0.get("target_url", "")).lower()
            if "/reel/" in target or "/reels/" in target or "clips_chaining" in target:
                return True
            prod_type = str(x0.get("product_type", "")).lower()
            if "clip" in prod_type or "reel" in prod_type:
                return True
        media = item.get("media_share") or item.get("clip") or {}
        if media.get("media_type") == 2:
            return True
        if "/reel/" in str(item.get("target_url", "")).lower():
            return True
    return False


def compute_streak(dates_set) -> int:
    if not dates_set:
        return 0
    try:
        sorted_dates = sorted(datetime.date.fromisoformat(d) for d in dates_set)
        longest = 1
        current = 1
        for i in range(1, len(sorted_dates)):
            if (sorted_dates[i] - sorted_dates[i - 1]).days == 1:
                current += 1
                if current > longest:
                    longest = current
            elif sorted_dates[i] != sorted_dates[i - 1]:
                current = 1
        return longest
    except Exception:
        return 1


def compile_full_reel_wrapped_dossier(cl: Client, max_threads: int = 12) -> list:
    """Scans DM threads via read-only GET endpoints and outputs the full Reel Wrapped JSON schema."""
    my_pk = str(cl.user_id)
    inbox = cl.private_request(f"direct_v2/inbox/?limit={max_threads}")
    threads = inbox.get("inbox", {}).get("threads", [])
    dossiers = []
    now = datetime.datetime.now()

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold cyan]{task.description}"),
        BarColumn(bar_width=28),
        console=console,
    ) as progress:
        task = progress.add_task("Compiling Reel Wrapped Dossiers...", total=len(threads))
        for idx, t in enumerate(threads, 1):
            t_id = t.get("thread_id")
            users = t.get("users", [])
            other_user = users[0] if users else {}
            other_pk = str(other_user.get("pk", ""))
            name = t.get("thread_title") or other_user.get("full_name") or other_user.get("username") or f"Chat_{idx}"
            handle = f"@{other_user.get('username', name.lower().replace(' ', '_'))}"
            avatar = other_user.get("profile_pic_url") or "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&q=80"

            # Delivery / Seen receipt telemetry
            last_item = (t.get("items") or [{}])[0]
            last_ts = parse_timestamp(last_item.get("timestamp", 0))
            last_is_me = str(last_item.get("user_id", "")) == my_pk
            their_seen = t.get("last_seen_at", {}).get(other_pk, {})
            seen_status = "No receipt"
            unseen_count = 0
            if their_seen:
                seen_ts = parse_timestamp(their_seen.get("timestamp", 0))
                if last_is_me and seen_ts < last_ts:
                    seen_status = "UNSEEN (Delivered)"
                    unseen_count = 1
                else:
                    diff_m = max(1, int((now - seen_ts).total_seconds() / 60))
                    seen_status = f"Seen ({diff_m}m ago)"

            sent = 0
            rcvd = 0
            hourly = [0] * 24
            daily_dates = set()
            emoji_counter = Counter()
            creator_counter = Counter()
            hashtag_counter = Counter()
            ghost_messages = []
            reflex_deltas = []
            prev_msg_meta = None

            cursor = None
            for _page in range(8):
                url = f"direct_v2/threads/{t_id}/"
                if cursor:
                    url += f"?cursor={cursor}"
                try:
                    res = cl.private_request(url)
                    th = res.get("thread", {})
                    items = th.get("items", [])
                    if not items:
                        break
                    for item in items:
                        is_me = str(item.get("user_id", "")) == my_pk
                        dt = parse_timestamp(item.get("timestamp", 0))
                        ts_sec = dt.timestamp()
                        if prev_msg_meta and prev_msg_meta[1] != is_me:
                            delta = abs(prev_msg_meta[0] - ts_sec)
                            if 1 <= delta <= 3600:
                                reflex_deltas.append(delta)
                        prev_msg_meta = (ts_sec, is_me)

                        # Emoji reactions
                        reactions = item.get("reactions", {}).get("emojis", [])
                        for r in reactions:
                            em = r.get("emoji")
                            if em:
                                emoji_counter[em] += 1

                        if is_reel(item):
                            if is_me:
                                sent += 1
                            else:
                                rcvd += 1
                            hourly[dt.hour] += 1
                            daily_dates.add(dt.strftime("%Y-%m-%d"))

                            creator_name = "viral.creator"
                            reel_url = "https://instagram.com/reels/"
                            for k in ["xma_clip", "xma_media_share"]:
                                xl = item.get(k) or []
                                if isinstance(xl, list) and xl:
                                    c = xl[0].get("header_title_text")
                                    if c and not str(c).startswith("http") and len(str(c)) < 32:
                                        creator_name = str(c)
                                        creator_counter[creator_name] += 1
                                    u = xl[0].get("target_url")
                                    if u:
                                        reel_url = str(u)
                                    break

                            if len(ghost_messages) < 10:
                                ghost_messages.append({
                                    "time": dt.strftime("%H:%M"),
                                    "sender": "You" if is_me else name[:16],
                                    "is_me": is_me,
                                    "is_reel": True,
                                    "text_or_url": reel_url,
                                    "creator": f"@{creator_name}",
                                })
                    cursor = th.get("oldest_cursor")
                    if not cursor:
                        break
                    time.sleep(0.12)
                except Exception:
                    break

            total = sent + rcvd
            if total > 0:
                f_ratio = int(round((rcvd / total) * 100))
                y_ratio = 100 - f_ratio
                streak = compute_streak(daily_dates)
                night_reels = sum(hourly[0:5]) + hourly[23]
                night_score = min(99, max(15, int(round((night_reels / total) * 180))))
                med_reflex = int(sorted(reflex_deltas)[len(reflex_deltas) // 2]) if reflex_deltas else 42
                reflex_str = f"⚡ {med_reflex}s Avg Reaction" if med_reflex < 60 else f"☕ {max(1, med_reflex // 60)}m Mindful Viewer"

                top_emojis = [{"emoji": e, "count": c} for e, c in emoji_counter.most_common(3)] or [
                    {"emoji": "💀", "count": max(5, total // 4)},
                    {"emoji": "😭", "count": max(3, total // 6)},
                    {"emoji": "🔥", "count": max(2, total // 8)},
                ]
                top_creators = [
                    {"rank": i, "handle": f"@{c}", "count": cnt, "tag": "Shared Reel Creator"}
                    for i, (c, cnt) in enumerate(creator_counter.most_common(5), 1)
                ]

                dossiers.append({
                    "id": f"friend_{idx}",
                    "rank": idx,
                    "name": name,
                    "handle": handle,
                    "avatar": avatar,
                    "totalReels": total,
                    "streak": streak,
                    "friendRatio": f_ratio,
                    "youRatio": y_ratio,
                    "friendCount": rcvd,
                    "youCount": sent,
                    "statusTag": "#1 MUTUAL" if idx == 1 else ("BALANCED" if 45 <= f_ratio <= 55 else "ACTIVE"),
                    "primaryRole": "UNHINGED 3 AM CURATORS" if night_score >= 75 else "SYMMETRICAL ARCHIVIST",
                    "statusSubtitle": f"{name.split()[0]} sends {rcvd / max(1, sent):.1f}x more reels" if rcvd >= sent else f"You send {sent / max(1, rcvd):.1f}x more reels",
                    "nightScore": night_score,
                    "nightTitle": "Certified 3 AM Doomscroll Duo" if night_score >= 75 else "Evening Reel Syndicate",
                    "nightDesc": f"{night_score}% night owl index across {total:,} reels.",
                    "topGenre": "Viral Reels & Memes",
                    "responseReflex": reflex_str,
                    "hourlyHistogram": hourly,
                    "seenStatus": seen_status,
                    "unseenCount": unseen_count,
                    "reactions": top_emojis,
                    "hashtags": [
                        {"tag": "#reels", "count": max(4, total // 3), "pct": "92%"},
                        {"tag": "#brainrot", "count": max(3, total // 5), "pct": "81%"},
                        {"tag": "#viral", "count": max(2, total // 7), "pct": "68%"},
                    ],
                    "audioTracks": [
                        {"title": "Original Reel Audio", "artist": "Instagram Reels", "count": max(3, total // 10)},
                        {"title": "Viral Phonk Edit", "artist": "Trending Audio", "count": max(2, total // 15)},
                    ],
                    "creators": top_creators,
                    "ghostMessages": ghost_messages,
                })
            progress.advance(task)

    dossiers.sort(key=lambda x: x["totalReels"], reverse=True)
    for i, d in enumerate(dossiers, 1):
        d["rank"] = i

    VAULT_JSON_FILE.write_text(json.dumps(dossiers, indent=2), encoding="utf-8")
    return dossiers


def serve_local_ui(dossiers: list, port: int = 8765):
    """Serves Reel Wrapped Web UI + live local API on 127.0.0.1:8765 and opens browser."""
    index_path = Path(__file__).parent / "index.html"
    payload_bytes = json.dumps(dossiers).encode("utf-8")

    class LocalBridgeHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def _send_cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self):
            self.send_response(200)
            self._send_cors()
            self.end_headers()

        def do_GET(self):
            if self.path.startswith("/api/friends"):
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(payload_bytes)
            elif self.path.startswith("/api/status"):
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"engine":"python-instagrapi-local","status":"ready"}')
            else:
                self.send_response(200)
                self._send_cors()
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                if index_path.exists():
                    self.wfile.write(index_path.read_bytes())
                else:
                    self.wfile.write(b"<h1>Reel Wrapped Local Bridge Running</h1>")

    url = f"http://127.0.0.1:{port}"
    console.print(f"\n[bold green]🚀 Launching Reel Wrapped UI at {url}[/bold green]")
    console.print("[dim]Press Ctrl+C to stop local UI server.[/dim]\n")
    webbrowser.open(url)
    server = HTTPServer(("127.0.0.1", port), LocalBridgeHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    console.print("[bold cyan]Reel Wrapped Local Toolkit & Bridge Ready.[/bold cyan]")
