//! The phone door — the security layer that lets a phone reach WinMux over the
//! tailnet. Ported faithfully from apps/electron/server.cjs. The Node contract:
//!
//!   * A rotating 128-bit access key (`token`) carried as `?k=` or the `ct_k`
//!     cookie. Compared in constant time.
//!   * Device cookies (`ct_dev`) that outlive the key: once a device proves it
//!     held the key, it gets a long-lived 32-hex id stored in the trust file, so
//!     the key stays disposable and a remembered phone skips the QR next time.
//!   * `authed` = phone-on AND (trustTailnet OR key matches OR known device).
//!   * An atomic (tmp + rename) trust file: { trustTailnet, devices:[…] }.
//!   * A brute-force throttle: 10 wrong `?k=` guesses from one address in 60s
//!     trip a 60s lockout. Only a *deliberate* wrong key counts.
//!
//! This module is the primitives layer (stage 1). The `/api/phone*` routes and
//! the second listener bound to the tailnet address are wired in later stages.
#![allow(dead_code)] // routes + tailnet listener land in stages 2–4

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const AUTH_MAX: u32 = 10; // wrong-key guesses within the window...
const AUTH_WINDOW_MS: u64 = 60_000; // ...trip a 60s lockout

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Device {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub first: String,
    #[serde(default)]
    pub last: String,
    #[serde(default)]
    pub ip: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Trust {
    #[serde(rename = "trustTailnet", default)]
    pub trust_tailnet: bool,
    #[serde(default)]
    pub devices: Vec<Device>,
}

struct Fail {
    n: u32,
    reset_at: u64,
    lock_until: u64,
}

/// One place that the toggle, the status readout, and the auth check all read,
/// so they can never disagree about whether the door is open. Mirrors the Node
/// `phone` object + `trust` guest list.
pub struct PhoneDoor {
    pub trust: Mutex<Trust>,
    trust_path: PathBuf,
    pub on: AtomicBool,
    pub ip: Mutex<Option<String>>, // the Tailscale address currently bound
    pub token: Mutex<String>,      // the rotating 128-bit key, hex
    fails: Mutex<HashMap<String, Fail>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
fn now_iso() -> String {
    // A coarse ISO-ish stamp is enough for a "first/last seen" label; we avoid a
    // date dependency and just record epoch millis as a string the UI can format.
    now_ms().to_string()
}
/// 16 random bytes as 32 lowercase hex — the shape of both the access key and a
/// device id (Node: crypto.randomBytes(16).toString('hex')).
fn hex16() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    let mut s = String::with_capacity(32);
    for x in b {
        s.push_str(&format!("{:02x}", x));
    }
    s
}
fn is_hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
/// Constant-time equality (Node uses crypto.timingSafeEqual). Different lengths
/// are an immediate non-match, matching the Node guard.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}
/// One cookie value out of a Cookie header (`name=value; other=…`).
fn cookie_val(cookie_header: &str, name: &str) -> String {
    for part in cookie_header.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix(&format!("{}=", name)) {
            return v.to_string();
        }
    }
    String::new()
}
/// The access key a request presents: `?k=` first, then the `ct_k` cookie.
pub fn token_from(query_k: Option<&str>, cookie_header: &str) -> String {
    if let Some(k) = query_k {
        if !k.is_empty() {
            return k.to_string();
        }
    }
    cookie_val(cookie_header, "ct_k")
}
/// The device id a request presents (the `ct_dev` cookie).
pub fn device_id_from(cookie_header: &str) -> String {
    cookie_val(cookie_header, "ct_dev")
}
/// Human label from a User-Agent, e.g. "Android · Chrome" (mirrors describeDevice).
pub fn describe_device(ua: &str) -> String {
    let os = if ua.contains("Android") {
        "Android"
    } else if ua.contains("iPhone") || ua.contains("iPad") || ua.contains("iOS") {
        "iPhone/iPad"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Mac OS X") {
        "Mac"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        "Unknown device"
    };
    let br = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("Chrome/") {
        "Chrome"
    } else if ua.contains("Firefox/") {
        "Firefox"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        "browser"
    };
    format!("{} · {}", os, br)
}

impl PhoneDoor {
    /// Load the trust file (start closed on any read/parse error), dropping any
    /// device whose id isn't a clean 32-hex — the same filter Node applies.
    pub fn load(trust_path: PathBuf) -> Self {
        let trust = std::fs::read_to_string(&trust_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Trust>(&s).ok())
            .map(|mut t| {
                t.devices.retain(|d| is_hex32(&d.id));
                t
            })
            .unwrap_or_default();
        Self {
            trust: Mutex::new(trust),
            trust_path,
            on: AtomicBool::new(false),
            ip: Mutex::new(None),
            token: Mutex::new(String::new()),
            fails: Mutex::new(HashMap::new()),
        }
    }

    /// Atomic write: temp file + rename, so a crash mid-write never leaves a
    /// corrupt guest list that bricks the door on next boot.
    pub fn save(&self) {
        let t = match self.trust.lock() {
            Ok(t) => t,
            Err(_) => return,
        };
        if let Ok(js) = serde_json::to_string_pretty(&*t) {
            let tmp = self.trust_path.with_extension(format!("{}.tmp", std::process::id()));
            if std::fs::write(&tmp, js).is_ok() {
                let _ = std::fs::rename(&tmp, &self.trust_path);
            }
        }
    }

    pub fn is_on(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }

    /// True only for a request that presents the current key (constant-time).
    pub fn key_matches(&self, token_presented: &str) -> bool {
        let tok = self.token.lock().map(|t| t.clone()).unwrap_or_default();
        // An empty stored token (door shut) never matches a presented value.
        !tok.is_empty() && ct_eq(token_presented, &tok)
    }

    /// True if the presented device id is one we remember (constant-time scan).
    pub fn known_device(&self, dev_id: &str) -> bool {
        if dev_id.is_empty() {
            return false;
        }
        let t = match self.trust.lock() {
            Ok(t) => t,
            Err(_) => return false,
        };
        t.devices.iter().any(|d| ct_eq(dev_id, &d.id))
    }

    /// The three ways in, in descending deliberateness: the whole tailnet is
    /// trusted, the request carries the key, or this device already proved it.
    /// Always false while the door is shut.
    pub fn authed(&self, token_presented: &str, dev_id: &str) -> bool {
        if !self.is_on() {
            return false;
        }
        let trust_tailnet = self.trust.lock().map(|t| t.trust_tailnet).unwrap_or(false);
        trust_tailnet || self.key_matches(token_presented) || self.known_device(dev_id)
    }

    /// A deliberate wrong key from one address; too many in the window locks it.
    pub fn note_bad_key(&self, ip: &str) {
        let now = now_ms();
        let mut map = match self.fails.lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        let rec = map.entry(ip.to_string()).or_insert(Fail { n: 0, reset_at: now + AUTH_WINDOW_MS, lock_until: 0 });
        if rec.reset_at < now {
            *rec = Fail { n: 0, reset_at: now + AUTH_WINDOW_MS, lock_until: 0 };
        }
        rec.n += 1;
        if rec.n >= AUTH_MAX {
            rec.lock_until = now + AUTH_WINDOW_MS;
            rec.n = 0;
            rec.reset_at = now + AUTH_WINDOW_MS;
        }
    }
    pub fn throttle_locked(&self, ip: &str) -> bool {
        let now = now_ms();
        self.fails.lock().map(|m| m.get(ip).map(|r| r.lock_until > now).unwrap_or(false)).unwrap_or(false)
    }

    /// Mint (or refresh) a remembered device on a real key match; returns its id.
    pub fn remember_device(&self, ua: &str, ip: &str, existing_dev: &str) -> String {
        let now = now_iso();
        let mut t = match self.trust.lock() {
            Ok(t) => t,
            Err(_) => return String::new(),
        };
        if !existing_dev.is_empty() {
            if let Some(d) = t.devices.iter_mut().find(|d| ct_eq(existing_dev, &d.id)) {
                d.last = now;
                if !ip.is_empty() {
                    d.ip = ip.to_string();
                }
                let id = d.id.clone();
                drop(t);
                self.save();
                return id;
            }
        }
        let id = hex16();
        t.devices.push(Device {
            id: id.clone(),
            name: describe_device(ua),
            first: now.clone(),
            last: now,
            ip: ip.to_string(),
        });
        drop(t);
        self.save();
        id
    }

    /// Forget one device; returns true if it existed. Callers rotate the key and
    /// drop the device's live sockets (wired in a later stage).
    pub fn forget_device(&self, id: &str) -> bool {
        let mut t = match self.trust.lock() {
            Ok(t) => t,
            Err(_) => return false,
        };
        let before = t.devices.len();
        t.devices.retain(|d| d.id != id);
        let gone = before != t.devices.len();
        drop(t);
        if gone {
            self.save();
        }
        gone
    }
    pub fn forget_all(&self) {
        if let Ok(mut t) = self.trust.lock() {
            t.devices.clear();
        }
        self.save();
    }

    /// New key after a device is forgotten, so a revoked phone can't walk back in
    /// on the link it already holds. No-op while the door is shut.
    pub fn rotate_key(&self) {
        if !self.is_on() {
            return;
        }
        if let Ok(mut tok) = self.token.lock() {
            *tok = hex16();
        }
    }

    pub fn set_trust_tailnet(&self, on: bool) {
        if let Ok(mut t) = self.trust.lock() {
            t.trust_tailnet = on;
        }
        self.save();
    }
    pub fn trust_tailnet(&self) -> bool {
        self.trust.lock().map(|t| t.trust_tailnet).unwrap_or(false)
    }

    /// What Settings may see. Over the phone door (`via_phone`) the id — a
    /// credential — is withheld, so one guest never learns another's key.
    pub fn device_list(&self, via_phone: bool) -> serde_json::Value {
        let t = match self.trust.lock() {
            Ok(t) => t,
            Err(_) => return serde_json::json!([]),
        };
        let arr: Vec<serde_json::Value> = t
            .devices
            .iter()
            .map(|d| {
                if via_phone {
                    serde_json::json!({ "name": d.name, "first": d.first, "last": d.last })
                } else {
                    serde_json::json!({ "id": d.id, "name": d.name, "first": d.first, "last": d.last, "ip": d.ip })
                }
            })
            .collect();
        serde_json::Value::Array(arr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ct_eq_matches_and_rejects() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "abcd")); // different length never matches
    }

    #[test]
    fn cookie_and_token_extraction() {
        assert_eq!(token_from(Some("qk"), "ct_k=ck"), "qk"); // query wins
        assert_eq!(token_from(Some(""), "ct_k=ck"), "ck"); // empty query -> cookie
        assert_eq!(token_from(None, "a=1; ct_k=ck; b=2"), "ck");
        assert_eq!(device_id_from("ct_dev=deadbeef; ct_k=x"), "deadbeef");
        assert_eq!(device_id_from("nope=1"), "");
    }

    #[test]
    fn authed_requires_on_then_key_or_device() {
        let d = PhoneDoor::load(std::env::temp_dir().join("winmux-pd-test-trust.json"));
        // door shut -> nothing authenticates
        assert!(!d.authed("anything", ""));
        // open it with a known key
        d.on.store(true, Ordering::SeqCst);
        *d.token.lock().unwrap() = "secret".to_string();
        assert!(d.key_matches("secret"));
        assert!(!d.key_matches("wrong"));
        assert!(d.authed("secret", ""));
        assert!(!d.authed("wrong", "unknown-dev"));
    }

    #[test]
    fn throttle_locks_after_max() {
        let d = PhoneDoor::load(std::env::temp_dir().join("winmux-pd-test-trust2.json"));
        assert!(!d.throttle_locked("1.2.3.4"));
        for _ in 0..AUTH_MAX {
            d.note_bad_key("1.2.3.4");
        }
        assert!(d.throttle_locked("1.2.3.4"));
        assert!(!d.throttle_locked("5.6.7.8")); // a different address is unaffected
    }
}
