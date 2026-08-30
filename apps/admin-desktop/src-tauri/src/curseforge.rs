use reqwest::{blocking::Client, header};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{io::Read, time::Duration};
use url::Url;

use crate::native_error::{NativeError, NativeResult};

const MAX_JAR: u64 = 64 * 1024 * 1024;
const GAME_MINECRAFT: u32 = 432;
const CLASS_MODS: u32 = 6;

fn api_key(value: &str) -> NativeResult<String> {
    let key = value.trim();
    if key.is_empty() {
        return Err(NativeError::new(
            "CURSEFORGE_KEY_MISSING",
            "Save your CurseForge API key first. Keys are issued at console.curseforge.com.",
        ));
    }
    if key.len() < 8
        || key.len() > 128
        || !key
            .bytes()
            .all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\')
    {
        return Err(NativeError::new(
            "CURSEFORGE_KEY_INVALID",
            "The CurseForge API key looks malformed. Copy it exactly from console.curseforge.com.",
        ));
    }
    Ok(key.to_owned())
}

fn loader_type(value: Option<&str>) -> NativeResult<Option<u8>> {
    match value {
        None => Ok(None),
        Some("fabric") => Ok(Some(4)),
        Some("neoforge") => Ok(Some(6)),
        Some(_) => Err(NativeError::new(
            "CURSEFORGE_LOADER_UNSUPPORTED",
            "Only Fabric and NeoForge servers are supported by this catalog.",
        )),
    }
}

fn client() -> NativeResult<Client> {
    Client::builder()
        .user_agent(concat!("UDMC-Control/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|detail| {
            NativeError::detail(
                "CURSEFORGE_REQUEST_FAILED",
                "Could not initialize the secure CurseForge connection.",
                detail,
            )
        })
}

fn download_target(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && matches!(
            url.host_str(),
            Some("edge.forgecdn.net" | "mediafilez.forgecdn.net")
        )
}

fn read(url: Url, key: Option<&str>, limit: u64) -> NativeResult<Vec<u8>> {
    let client = client()?;
    let mut next = url;
    for _ in 0..6 {
        let mut request = client.get(next.clone()).header(header::ACCEPT, "*/*");
        // The key authenticates only against the official API host, never a download CDN.
        if let Some(key) = key.filter(|_| next.host_str() == Some("api.curseforge.com")) {
            request = request.header("x-api-key", key);
        }
        let response = request.send().map_err(|detail| {
            NativeError::detail(
                "CURSEFORGE_REQUEST_FAILED",
                "Could not reach CurseForge.",
                detail,
            )
        })?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or_else(|| {
                    NativeError::new(
                        "CURSEFORGE_REDIRECT_INVALID",
                        "CurseForge returned an invalid download redirect.",
                    )
                })?;
            let target = next.join(location).map_err(|detail| {
                NativeError::detail(
                    "CURSEFORGE_REDIRECT_INVALID",
                    "CurseForge returned an invalid download redirect.",
                    detail,
                )
            })?;
            if !download_target(&target) {
                return Err(NativeError::new(
                    "CURSEFORGE_REDIRECT_INVALID",
                    "CurseForge redirected the download outside its official file hosts.",
                ));
            }
            next = target;
            continue;
        }
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(NativeError::new(
                "CURSEFORGE_UNAUTHORIZED",
                "CurseForge rejected this request. Use the organization key from the console's API keys page (not a legacy author token), and note that freshly created keys can take a few minutes to activate - retry a bit later.",
            ));
        }
        if response.status().as_u16() == 429 {
            return Err(NativeError::new(
                "CURSEFORGE_RATE_LIMITED",
                "CurseForge limited this key for now. Try again later.",
            ));
        }
        if !response.status().is_success() {
            let status = response.status().as_u16().to_string();
            return Err(NativeError::with_args(
                "CURSEFORGE_HTTP_FAILED",
                format!("CurseForge returned HTTP {status}."),
                vec![status],
            ));
        }
        if response.content_length().is_some_and(|n| n > limit) {
            return Err(NativeError::new(
                "CURSEFORGE_RESPONSE_TOO_LARGE",
                "The CurseForge response exceeds the size limit.",
            ));
        }
        let mut bytes = Vec::new();
        response
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|detail| {
                NativeError::detail(
                    "CURSEFORGE_REQUEST_FAILED",
                    "Could not read the complete CurseForge response.",
                    detail,
                )
            })?;
        if bytes.len() as u64 > limit {
            return Err(NativeError::new(
                "CURSEFORGE_RESPONSE_TOO_LARGE",
                "The CurseForge response exceeds the size limit.",
            ));
        }
        return Ok(bytes);
    }
    Err(NativeError::new(
        "CURSEFORGE_REDIRECT_INVALID",
        "CurseForge returned too many download redirects.",
    ))
}

fn api_json(key: &str, path_and_query: &str) -> NativeResult<Value> {
    let url = Url::parse(&format!("https://api.curseforge.com/v1/{path_and_query}")).map_err(
        |detail| {
            NativeError::detail(
                "CURSEFORGE_REQUEST_FAILED",
                "Could not build the CurseForge API address.",
                detail,
            )
        },
    )?;
    serde_json::from_slice(&read(url, Some(key), 8 * 1024 * 1024)?).map_err(|detail| {
        NativeError::detail(
            "CURSEFORGE_RESPONSE_INVALID",
            "CurseForge returned malformed catalog data.",
            detail,
        )
    })
}

fn text(value: &Value, limit: usize) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}

fn thumbnail(value: &Value) -> Value {
    let raw = value.as_str().unwrap_or_default();
    match Url::parse(raw) {
        Ok(url)
            if url.scheme() == "https"
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && url.host_str() == Some("media.forgecdn.net") =>
        {
            json!(url.as_str())
        }
        _ => Value::Null,
    }
}

fn mod_row(entry: &Value) -> Option<Value> {
    let id = entry["id"].as_u64().filter(|id| *id > 0)?;
    Some(json!({
        "id": id,
        "name": text(&entry["name"], 120),
        "summary": text(&entry["summary"], 300),
        "downloads": entry["downloadCount"].as_f64().unwrap_or(0.0) as u64,
        "logoUrl": thumbnail(&entry["logo"]["thumbnailUrl"]),
        "websiteUrl": text(&entry["links"]["websiteUrl"], 300),
        // null means the author never decided; only an explicit false blocks API downloads.
        "distributionAllowed": entry["allowModDistribution"] != Value::Bool(false),
    }))
}

fn file_row(entry: &Value) -> Option<Value> {
    let id = entry["id"].as_u64().filter(|id| *id > 0)?;
    let name = text(&entry["fileName"], 200);
    let size = entry["fileLength"].as_u64().unwrap_or(0);
    let sha1 = entry["hashes"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|hash| hash["algo"] == 1)
        .map(|hash| text(&hash["value"], 40).to_ascii_lowercase())
        .filter(|value| value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit()));
    let download = entry["downloadUrl"]
        .as_str()
        .and_then(|value| Url::parse(value).ok())
        .filter(download_target);
    let versions: Vec<String> = entry["gameVersions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .take(12)
        .map(|v| v.chars().filter(|c| !c.is_control()).take(40).collect())
        .collect();
    let valid_name = !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && name.to_ascii_lowercase().ends_with(".jar");
    Some(json!({
        "id": id,
        "displayName": text(&entry["displayName"], 160),
        "fileName": name,
        "size": size,
        "releaseType": entry["releaseType"].as_u64().unwrap_or(0),
        "gameVersions": versions,
        "requiredDependencies": entry["dependencies"].as_array().into_iter().flatten()
            .filter(|d| d["relationType"] == 3).count(),
        "downloadable": download.is_some() && valid_name && size > 0 && size <= MAX_JAR,
        "sha1": sha1,
    }))
}

#[tauri::command]
pub async fn curseforge_search(
    key: String,
    query: String,
    game_version: Option<String>,
    loader: Option<String>,
    page: u16,
) -> NativeResult<Value> {
    let key = api_key(&key)?;
    if query.len() > 120 || query.chars().any(char::is_control) {
        return Err(NativeError::new(
            "CURSEFORGE_QUERY_INVALID",
            "The search text is too long.",
        ));
    }
    if !(1..=100).contains(&page) {
        return Err(NativeError::new(
            "CURSEFORGE_PAGE_INVALID",
            "The CurseForge page is invalid.",
        ));
    }
    if game_version
        .as_deref()
        .is_some_and(|v| v.len() > 20 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.'))
    {
        return Err(NativeError::new(
            "CURSEFORGE_QUERY_INVALID",
            "The Minecraft version filter is invalid.",
        ));
    }
    let loader = loader_type(loader.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut path = format!(
            "mods/search?gameId={GAME_MINECRAFT}&classId={CLASS_MODS}&sortField=2&sortOrder=desc&pageSize=20&index={}",
            u32::from(page - 1) * 20
        );
        if !query.trim().is_empty() {
            path.push_str("&searchFilter=");
            path.push_str(&url_escape(query.trim()));
        }
        if let Some(version) = game_version.as_deref().filter(|v| !v.is_empty()) {
            path.push_str("&gameVersion=");
            path.push_str(&url_escape(version));
        }
        if let Some(loader) = loader {
            path.push_str(&format!("&modLoaderType={loader}"));
        }
        let value = api_json(&key, &path)?;
        let rows: Vec<Value> = value["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(mod_row)
            .collect();
        let total = value["pagination"]["totalCount"].as_u64().unwrap_or(0);
        Ok(json!({
            "mods": rows,
            "total": total,
            "hasMore": u64::from(page) * 20 < total.min(10_000),
        }))
    })
    .await
    .map_err(|detail| {
        NativeError::detail(
            "CURSEFORGE_REQUEST_FAILED",
            "The CurseForge request task did not finish.",
            detail,
        )
    })?
}

#[tauri::command]
pub async fn curseforge_files(
    key: String,
    mod_id: u64,
    game_version: Option<String>,
    loader: Option<String>,
) -> NativeResult<Value> {
    let key = api_key(&key)?;
    if mod_id == 0 {
        return Err(NativeError::new(
            "CURSEFORGE_FILE_INVALID",
            "The CurseForge mod is invalid.",
        ));
    }
    if game_version
        .as_deref()
        .is_some_and(|v| v.len() > 20 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.'))
    {
        return Err(NativeError::new(
            "CURSEFORGE_QUERY_INVALID",
            "The Minecraft version filter is invalid.",
        ));
    }
    let loader = loader_type(loader.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut path = format!("mods/{mod_id}/files?pageSize=50");
        if let Some(version) = game_version.as_deref().filter(|v| !v.is_empty()) {
            path.push_str("&gameVersion=");
            path.push_str(&url_escape(version));
        }
        if let Some(loader) = loader {
            path.push_str(&format!("&modLoaderType={loader}"));
        }
        let value = api_json(&key, &path)?;
        let description = api_json(&key, &format!("mods/{mod_id}/description"))
            .map(|body| text(&body["data"], 100_000))
            .unwrap_or_default();
        let rows: Vec<Value> = value["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(file_row)
            .collect();
        Ok(json!({ "files": rows, "description": description }))
    })
    .await
    .map_err(|detail| {
        NativeError::detail(
            "CURSEFORGE_REQUEST_FAILED",
            "The CurseForge request task did not finish.",
            detail,
        )
    })?
}

fn download(key: &str, mod_id: u64, file_id: u64) -> NativeResult<Vec<u8>> {
    let file = api_json(key, &format!("mods/{mod_id}/files/{file_id}"))?;
    let entry = &file["data"];
    if entry["id"].as_u64() != Some(file_id) {
        return Err(NativeError::new(
            "CURSEFORGE_FILE_INVALID",
            "CurseForge returned a different file.",
        ));
    }
    let row = file_row(entry).ok_or_else(|| {
        NativeError::new("CURSEFORGE_FILE_INVALID", "The CurseForge file is invalid.")
    })?;
    let size = row["size"].as_u64().unwrap_or(0);
    if size == 0 || size > MAX_JAR {
        return Err(NativeError::new(
            "CURSEFORGE_FILE_INVALID",
            "Choose a published mod JAR up to 64 MiB.",
        ));
    }
    let target = entry["downloadUrl"]
        .as_str()
        .and_then(|value| Url::parse(value).ok())
        .filter(download_target)
        .ok_or_else(|| {
            NativeError::new(
                "CURSEFORGE_DISTRIBUTION_BLOCKED",
                "The author disabled API distribution for this file. Install it manually from the CurseForge page.",
            )
        })?;
    let bytes = read(target, None, size)?;
    verify(&bytes, size, row["sha1"].as_str())?;
    Ok(bytes)
}

fn verify(bytes: &[u8], size: u64, sha1: Option<&str>) -> NativeResult<()> {
    if bytes.len() as u64 != size
        || sha1.is_some_and(|value| value != format!("{:x}", Sha1::digest(bytes)))
    {
        return Err(NativeError::new(
            "CURSEFORGE_FILE_INTEGRITY_FAILED",
            "The CurseForge file failed its size or SHA-1 check.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn curseforge_download(
    key: String,
    mod_id: u64,
    file_id: u64,
) -> NativeResult<tauri::ipc::Response> {
    let key = api_key(&key)?;
    if mod_id == 0 || file_id == 0 {
        return Err(NativeError::new(
            "CURSEFORGE_FILE_INVALID",
            "The CurseForge file is invalid.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        download(&key, mod_id, file_id).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|detail| {
        NativeError::detail(
            "CURSEFORGE_REQUEST_FAILED",
            "The CurseForge download task did not finish.",
            detail,
        )
    })?
}

fn url_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() * 3);
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                escaped.push(byte as char)
            }
            _ => escaped.push_str(&format!("%{byte:02X}")),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_a_plausible_key_and_supported_loader() {
        assert_eq!(api_key("  ").unwrap_err().code, "CURSEFORGE_KEY_MISSING");
        assert_eq!(api_key("short").unwrap_err().code, "CURSEFORGE_KEY_INVALID");
        assert_eq!(
            api_key("bad key with spaces").unwrap_err().code,
            "CURSEFORGE_KEY_INVALID"
        );
        assert_eq!(
            api_key(" 3878aaaa-0000-1111-2222-333344445555 ").unwrap(),
            "3878aaaa-0000-1111-2222-333344445555"
        );
        assert_eq!(loader_type(Some("fabric")).unwrap(), Some(4));
        assert_eq!(loader_type(Some("neoforge")).unwrap(), Some(6));
        assert_eq!(loader_type(None).unwrap(), None);
        assert_eq!(
            loader_type(Some("forge")).unwrap_err().code,
            "CURSEFORGE_LOADER_UNSUPPORTED"
        );
    }

    #[test]
    fn restricts_download_and_thumbnail_targets() {
        for value in [
            "http://edge.forgecdn.net/files/1/2/mod.jar",
            "https://edge.forgecdn.net:8443/files/1/2/mod.jar",
            "https://key@edge.forgecdn.net/files/1/2/mod.jar",
            "https://evil.example/files/1/2/mod.jar",
            "https://edge.forgecdn.net.evil/files/1/2/mod.jar",
        ] {
            assert!(!download_target(&Url::parse(value).unwrap()), "{value}");
        }
        assert!(download_target(
            &Url::parse("https://mediafilez.forgecdn.net/files/1/2/mod.jar").unwrap()
        ));
        assert_eq!(
            thumbnail(&json!("https://media.forgecdn.net/avatars/1/logo.png")),
            json!("https://media.forgecdn.net/avatars/1/logo.png")
        );
        assert_eq!(
            thumbnail(&json!("https://evil.example/logo.png")),
            Value::Null
        );
        assert_eq!(thumbnail(&json!(42)), Value::Null);
    }

    #[test]
    fn validates_files_and_integrity() {
        let entry = json!({
            "id": 7, "displayName": "Mod 1.0", "fileName": "mod.jar", "fileLength": 3,
            "releaseType": 1, "downloadUrl": "https://edge.forgecdn.net/files/1/2/mod.jar",
            "gameVersions": ["1.21.1", "Fabric"],
            "dependencies": [{"modId": 1, "relationType": 3}, {"modId": 2, "relationType": 2}],
            "hashes": [{"algo": 1, "value": format!("{:x}", Sha1::digest(b"jar"))}]
        });
        let row = file_row(&entry).unwrap();
        assert_eq!(row["downloadable"], json!(true));
        assert_eq!(row["requiredDependencies"], json!(1));
        assert!(verify(b"jar", 3, row["sha1"].as_str()).is_ok());
        assert!(verify(b"bad", 3, row["sha1"].as_str()).is_err());
        assert!(verify(b"jar!", 3, None).is_err());
        let blocked = json!({ "id": 7, "fileName": "mod.jar", "fileLength": 3, "downloadUrl": Value::Null, "hashes": [] });
        assert_eq!(file_row(&blocked).unwrap()["downloadable"], json!(false));
        let traversal = json!({ "id": 7, "fileName": "..\\mod.jar", "fileLength": 3,
            "downloadUrl": "https://edge.forgecdn.net/files/1/2/mod.jar", "hashes": [] });
        assert_eq!(file_row(&traversal).unwrap()["downloadable"], json!(false));
        assert_eq!(
            mod_row(&json!({"id": 5, "name": "Mod", "allowModDistribution": false})).unwrap()
                ["distributionAllowed"],
            json!(false)
        );
        assert_eq!(
            mod_row(&json!({"id": 5, "name": "Mod", "allowModDistribution": Value::Null})).unwrap()
                ["distributionAllowed"],
            json!(true)
        );
    }

    #[test]
    #[ignore = "Explicit CurseForge API smoke test; requires UDMC_CURSEFORGE_KEY and never installs downloaded mods"]
    fn live_catalog_search() {
        let key = std::env::var("UDMC_CURSEFORGE_KEY").expect("Set UDMC_CURSEFORGE_KEY");
        let value = api_json(
            &api_key(&key).unwrap(),
            "mods/search?gameId=432&classId=6&pageSize=5&sortField=2&sortOrder=desc&gameVersion=1.21.1&modLoaderType=4",
        )
        .unwrap();
        let rows: Vec<Value> = value["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(mod_row)
            .collect();
        assert!(!rows.is_empty());
        println!(
            "CurseForge search returned {} Fabric 1.21.1 mods",
            rows.len()
        );
    }
}
