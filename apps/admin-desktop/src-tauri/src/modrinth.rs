use reqwest::blocking::Client;
use serde_json::Value;
use sha2::{Digest, Sha512};
use std::{collections::BTreeMap, io::Read, time::Duration};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::native_error::{NativeError, NativeResult};

#[tauri::command]
pub fn open_catalog_link(app: tauri::AppHandle, url: String) -> NativeResult<()> {
    let parsed = Url::parse(&url).map_err(|detail| {
        NativeError::detail(
            "CATALOG_LINK_INVALID",
            "The catalog link is invalid.",
            detail,
        )
    })?;
    if url.len() > 2048
        || parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(NativeError::new(
            "CATALOG_LINK_INVALID",
            "Only HTTPS catalog links without embedded credentials are allowed.",
        ));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|detail| {
            NativeError::detail(
                "CATALOG_LINK_OPEN_FAILED",
                "Could not open the catalog link.",
                detail,
            )
        })
}

fn client() -> NativeResult<Client> {
    Client::builder()
        .user_agent(concat!("UDMC-Control/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .build()
        .map_err(|detail| {
            NativeError::detail(
                "MODRINTH_REQUEST_FAILED",
                "Could not initialize the secure Modrinth connection.",
                detail,
            )
        })
}

fn api_url(path: &str, query: BTreeMap<String, String>) -> NativeResult<Url> {
    let parts: Vec<_> = path.split('/').collect();
    let id = |s: &str| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    let allowed = match parts.as_slice() {
        ["search"] => true,
        ["project", value] | ["version", value] => id(value),
        ["project", value, "version"] => id(value),
        _ => false,
    };
    if !allowed || query.len() > 8 || query.values().any(|v| v.len() > 2048) {
        return Err(NativeError::new(
            "MODRINTH_REQUEST_INVALID",
            "The Modrinth catalog request is invalid.",
        ));
    }
    let mut url = Url::parse(&format!("https://api.modrinth.com/v2/{path}")).unwrap();
    for (key, value) in query {
        url.query_pairs_mut().append_pair(&key, &value);
    }
    Ok(url)
}

fn read(url: Url, limit: u64) -> NativeResult<Vec<u8>> {
    let response = client()?.get(url).send().map_err(|detail| {
        NativeError::detail(
            "MODRINTH_REQUEST_FAILED",
            "Could not reach Modrinth.",
            detail,
        )
    })?;
    if response.status().as_u16() == 429 {
        return Err(NativeError::new(
            "MODRINTH_RATE_LIMITED",
            "Modrinth received too many requests. Wait a minute and try again.",
        ));
    }
    if !response.status().is_success() {
        let status = response.status().as_u16().to_string();
        return Err(NativeError::with_args(
            "MODRINTH_HTTP_FAILED",
            format!("Modrinth returned HTTP {status}."),
            vec![status],
        ));
    }
    if response.content_length().is_some_and(|n| n > limit) {
        return Err(NativeError::new(
            "MODRINTH_RESPONSE_TOO_LARGE",
            "The Modrinth response exceeds the size limit.",
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|detail| {
            NativeError::detail(
                "MODRINTH_REQUEST_FAILED",
                "Could not read the complete Modrinth response.",
                detail,
            )
        })?;
    if bytes.len() as u64 > limit {
        return Err(NativeError::new(
            "MODRINTH_RESPONSE_TOO_LARGE",
            "The Modrinth response exceeds the size limit.",
        ));
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn modrinth_get(path: String, query: BTreeMap<String, String>) -> NativeResult<Value> {
    let url = api_url(&path, query)?;
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::from_slice(&read(url, 8 * 1024 * 1024)?).map_err(|detail| {
            NativeError::detail(
                "MODRINTH_RESPONSE_INVALID",
                "Modrinth returned malformed catalog data.",
                detail,
            )
        })
    })
    .await
    .map_err(|detail| {
        NativeError::detail(
            "MODRINTH_REQUEST_FAILED",
            "The Modrinth request task did not finish.",
            detail,
        )
    })?
}

fn download_url(value: &str) -> NativeResult<Url> {
    let url = Url::parse(value).map_err(|detail| {
        NativeError::detail(
            "MODRINTH_DOWNLOAD_URL_INVALID",
            "The Modrinth download address is invalid.",
            detail,
        )
    })?;
    if url.scheme() != "https"
        || url.host_str() != Some("cdn.modrinth.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with("/data/")
        || !url.path().to_ascii_lowercase().ends_with(".jar")
    {
        return Err(NativeError::new(
            "MODRINTH_DOWNLOAD_URL_INVALID",
            "Only JAR files from the official Modrinth HTTPS CDN are allowed.",
        ));
    }
    Ok(url)
}

fn verify(bytes: &[u8], size: u64, sha512: &str) -> NativeResult<()> {
    if bytes.len() as u64 != size
        || format!("{:x}", Sha512::digest(bytes)) != sha512.to_ascii_lowercase()
    {
        return Err(NativeError::new(
            "MODRINTH_FILE_INTEGRITY_FAILED",
            "The Modrinth file failed its size or SHA-512 check.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn modrinth_download(
    url: String,
    size: u64,
    sha512: String,
) -> NativeResult<tauri::ipc::Response> {
    let url = download_url(&url)?;
    if size == 0
        || size > 64 * 1024 * 1024
        || sha512.len() != 128
        || !sha512.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(NativeError::new(
            "MODRINTH_DOWNLOAD_INVALID",
            "Import requires a JAR up to 64 MiB with a valid SHA-512 hash.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = read(url, size)?;
        verify(&bytes, size, &sha512)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|detail| {
        NativeError::detail(
            "MODRINTH_REQUEST_FAILED",
            "The Modrinth download task did not finish.",
            detail,
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricts_network_targets() {
        for value in [
            "http://cdn.modrinth.com/data/a.jar",
            "https://localhost/data/a.jar",
            "https://cdn.modrinth.com.evil/data/a.jar",
            "https://secret@cdn.modrinth.com/data/a.jar",
            "https://cdn.modrinth.com/data/a.zip",
        ] {
            assert!(download_url(value).is_err());
        }
        assert!(download_url("https://cdn.modrinth.com/data/abc/versions/xyz/a.jar").is_ok());
        assert_eq!(
            api_url("../admin", BTreeMap::new()).unwrap_err().code,
            "MODRINTH_REQUEST_INVALID"
        );
        assert!(api_url("project/fabric-api/version", BTreeMap::new()).is_ok());
    }
    #[test]
    fn checks_hash_and_size() {
        let hash = format!("{:x}", Sha512::digest(b"jar"));
        assert!(verify(b"jar", 3, &hash).is_ok());
        assert!(verify(b"bad", 3, &hash).is_err());
        assert!(verify(b"jar", 4, &hash).is_err());
    }

    #[test]
    #[ignore = "Explicit network smoke test against the public Modrinth API"]
    fn live_catalog_download() {
        let query = BTreeMap::from([
            ("loaders".into(), "[\"fabric\"]".into()),
            ("game_versions".into(), "[\"26.2\"]".into()),
            ("include_changelog".into(), "false".into()),
        ]);
        let body = read(
            api_url("project/fabric-api/version", query).unwrap(),
            8 * 1024 * 1024,
        )
        .unwrap();
        let versions: Value = serde_json::from_slice(&body).unwrap();
        let version = versions
            .as_array()
            .unwrap()
            .first()
            .expect("Fabric API for 26.2");
        let file = &version["files"][0];
        let size = file["size"].as_u64().unwrap();
        let bytes = read(download_url(file["url"].as_str().unwrap()).unwrap(), size).unwrap();
        verify(&bytes, size, file["hashes"]["sha512"].as_str().unwrap()).unwrap();
        let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.qa/modrinth-fabric-api.jar");
        std::fs::create_dir_all(output.parent().unwrap()).unwrap();
        std::fs::write(output, &bytes).unwrap();
        let mut jar = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert!(jar.by_name("fabric.mod.json").is_ok());
        println!(
            "Verified Modrinth Fabric API {}: {} bytes",
            version["version_number"], size
        );
    }
}
