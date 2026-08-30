use reqwest::{blocking::Client, header};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Read, time::Duration};
use url::Url;

use crate::native_error::{NativeError, NativeResult};

const MAX_JAR: u64 = 64 * 1024 * 1024;

fn repository(value: &str) -> NativeResult<String> {
    let trimmed = value.trim().trim_end_matches('/');
    let name = if trimmed.starts_with("https://") {
        let url = Url::parse(trimmed).map_err(|detail| {
            NativeError::detail(
                "GITHUB_REPOSITORY_INVALID",
                "The GitHub repository address is invalid.",
                detail,
            )
        })?;
        if url.host_str() != Some("github.com")
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(NativeError::new(
                "GITHUB_REPOSITORY_INVALID",
                "Use a public github.com owner/repository address.",
            ));
        }
        url.path().trim_start_matches('/').to_owned()
    } else {
        trimmed.to_owned()
    };
    let parts: Vec<_> = name.split('/').collect();
    if parts.len() != 2
        || parts[0].is_empty()
        || parts[0].len() > 39
        || parts[1].is_empty()
        || parts[1].len() > 100
        || !parts[0]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || !parts[1]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        || [".", ".."].contains(&parts[1])
    {
        return Err(NativeError::new(
            "GITHUB_REPOSITORY_INVALID",
            "Enter a GitHub repository as owner/repository.",
        ));
    }
    Ok(name)
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
                "GITHUB_REQUEST_FAILED",
                "Could not initialize the secure GitHub connection.",
                detail,
            )
        })
}

fn read(url: Url, binary: bool, limit: u64) -> NativeResult<Vec<u8>> {
    let client = client()?;
    let mut next = url;
    for _ in 0..6 {
        let response = client
            .get(next.clone())
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header(
                header::ACCEPT,
                if binary {
                    "application/octet-stream"
                } else {
                    "application/vnd.github+json"
                },
            )
            .send()
            .map_err(|detail| {
                NativeError::detail("GITHUB_REQUEST_FAILED", "Could not reach GitHub.", detail)
            })?;
        if binary && response.status().is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or_else(|| {
                    NativeError::new(
                        "GITHUB_REDIRECT_INVALID",
                        "GitHub returned an invalid download redirect.",
                    )
                })?;
            let target = next.join(location).map_err(|detail| {
                NativeError::detail(
                    "GITHUB_REDIRECT_INVALID",
                    "GitHub returned an invalid download redirect.",
                    detail,
                )
            })?;
            if !download_target(&target) {
                return Err(NativeError::new(
                    "GITHUB_REDIRECT_INVALID",
                    "GitHub redirected the download outside its official asset hosts.",
                ));
            }
            next = target;
            continue;
        }
        if response.status().as_u16() == 429 || response.status().as_u16() == 403 {
            return Err(NativeError::new(
                "GITHUB_RATE_LIMITED",
                "GitHub limited or rejected this request. Try again later; private repositories are not supported.",
            ));
        }
        if !response.status().is_success() {
            let status = response.status().as_u16().to_string();
            return Err(NativeError::with_args(
                "GITHUB_HTTP_FAILED",
                format!("GitHub returned HTTP {status}. Check the repository address and published releases."),
                vec![status],
            ));
        }
        if response.content_length().is_some_and(|n| n > limit) {
            return Err(NativeError::new(
                "GITHUB_RESPONSE_TOO_LARGE",
                "The GitHub response exceeds the size limit.",
            ));
        }
        let mut bytes = Vec::new();
        response
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|detail| {
                NativeError::detail(
                    "GITHUB_REQUEST_FAILED",
                    "Could not read the complete GitHub response.",
                    detail,
                )
            })?;
        if bytes.len() as u64 > limit {
            return Err(NativeError::new(
                "GITHUB_RESPONSE_TOO_LARGE",
                "The GitHub response exceeds the size limit.",
            ));
        }
        return Ok(bytes);
    }
    Err(NativeError::new(
        "GITHUB_REDIRECT_INVALID",
        "GitHub returned too many download redirects.",
    ))
}

fn download_target(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && matches!(
            url.host_str(),
            Some(
                "api.github.com"
                    | "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}

fn json_get(path: &str) -> NativeResult<Value> {
    serde_json::from_slice(&read(
        Url::parse(&format!("https://api.github.com/repos/{path}")).map_err(|detail| {
            NativeError::detail(
                "GITHUB_REQUEST_FAILED",
                "Could not build the GitHub API address.",
                detail,
            )
        })?,
        false,
        8 * 1024 * 1024,
    )?)
    .map_err(|detail| {
        NativeError::detail(
            "GITHUB_RESPONSE_INVALID",
            "GitHub returned malformed release data.",
            detail,
        )
    })
}

#[tauri::command]
pub async fn github_releases(repository: String, page: u16) -> NativeResult<Value> {
    let repository = self::repository(&repository)?;
    if !(1..=100).contains(&page) {
        return Err(NativeError::new(
            "GITHUB_PAGE_INVALID",
            "The GitHub release page is invalid.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || releases(&repository, page))
        .await
        .map_err(|detail| {
            NativeError::detail(
                "GITHUB_REQUEST_FAILED",
                "The GitHub request task did not finish.",
                detail,
            )
        })?
}

fn releases(repository: &str, page: u16) -> NativeResult<Value> {
    let project = json_get(repository)?;
    let releases = json_get(&format!("{repository}/releases?per_page=20&page={page}"))?;
    let list = releases.as_array().ok_or_else(|| {
        NativeError::new(
            "GITHUB_RESPONSE_INVALID",
            "GitHub did not return a release list.",
        )
    })?;
    Ok(
        json!({ "repository": repository, "description": project["description"], "license": project["license"],
        "releases": list, "hasMore": list.len() == 20 }),
    )
}

fn asset_info(asset: &Value) -> NativeResult<(u64, Option<String>)> {
    let name = asset["name"].as_str().ok_or_else(|| {
        NativeError::new("GITHUB_ASSET_INVALID", "The GitHub asset has no file name.")
    })?;
    let size = asset["size"].as_u64().ok_or_else(|| {
        NativeError::new("GITHUB_ASSET_INVALID", "The GitHub asset has no file size.")
    })?;
    if name.len() > 200
        || name.contains(['/', '\\', ':'])
        || name.chars().any(char::is_control)
        || !name.to_ascii_lowercase().ends_with(".jar")
        || size == 0
        || size > MAX_JAR
        || asset["state"] != "uploaded"
    {
        return Err(NativeError::new(
            "GITHUB_ASSET_INVALID",
            "Choose a published mod JAR up to 64 MiB.",
        ));
    }
    let digest = match asset["digest"].as_str() {
        None => None,
        Some(value) => {
            let hex = value
                .strip_prefix("sha256:")
                .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(|| {
                    NativeError::new(
                        "GITHUB_ASSET_INVALID",
                        "The GitHub asset digest is unsupported or malformed.",
                    )
                })?;
            Some(hex.to_ascii_lowercase())
        }
    };
    Ok((size, digest))
}

fn download(repository: &str, asset_id: u64) -> NativeResult<Vec<u8>> {
    let endpoint = format!("{repository}/releases/assets/{asset_id}");
    let asset = json_get(&endpoint)?;
    if asset["id"].as_u64() != Some(asset_id) {
        return Err(NativeError::new(
            "GITHUB_ASSET_INVALID",
            "GitHub returned a different release asset.",
        ));
    }
    let (size, digest) = asset_info(&asset)?;
    let bytes = read(
        Url::parse(&format!("https://api.github.com/repos/{endpoint}")).unwrap(),
        true,
        size,
    )?;
    verify(&bytes, size, digest.as_deref())?;
    Ok(bytes)
}

fn verify(bytes: &[u8], size: u64, digest: Option<&str>) -> NativeResult<()> {
    if bytes.len() as u64 != size
        || digest.is_some_and(|value| value != format!("{:x}", Sha256::digest(bytes)))
    {
        return Err(NativeError::new(
            "GITHUB_FILE_INTEGRITY_FAILED",
            "The GitHub asset failed its size or SHA-256 check.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn github_download(
    repository: String,
    asset_id: u64,
) -> NativeResult<tauri::ipc::Response> {
    let repository = self::repository(&repository)?;
    if asset_id == 0 {
        return Err(NativeError::new(
            "GITHUB_ASSET_INVALID",
            "The GitHub release asset is invalid.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        download(&repository, asset_id).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|detail| {
        NativeError::detail(
            "GITHUB_REQUEST_FAILED",
            "The GitHub download task did not finish.",
            detail,
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricts_repository_and_redirect_targets() {
        assert_eq!(
            repository(" https://github.com/CaffeineMC/sodium/ ").unwrap(),
            "CaffeineMC/sodium"
        );
        for value in [
            "https://github.com.evil/a/b",
            "https://key@github.com/a/b",
            "a/../b",
            "a/..",
            "a/b?x=y",
            "http://github.com/a/b",
            "a/b/releases",
        ] {
            assert_eq!(
                repository(value).unwrap_err().code,
                "GITHUB_REPOSITORY_INVALID",
                "{value}"
            );
        }
        for value in [
            "http://github.com/file",
            "https://localhost/a.jar",
            "https://github.com.evil/a.jar",
            "https://key@github.com/file",
            "https://release-assets.githubusercontent.com:9000/file",
        ] {
            assert!(!download_target(&Url::parse(value).unwrap()));
        }
        assert!(download_target(
            &Url::parse("https://release-assets.githubusercontent.com/a?signature=test").unwrap()
        ));
    }
    #[test]
    fn requires_published_bounded_jars_and_valid_digests() {
        let mut asset = json!({"name":"mod.jar","size":3,"state":"uploaded","digest":format!("sha256:{:x}",Sha256::digest(b"jar"))});
        let (size, digest) = asset_info(&asset).unwrap();
        assert!(verify(b"jar", size, digest.as_deref()).is_ok());
        assert!(verify(b"bad", size, digest.as_deref()).is_err());
        asset["digest"] = json!("sha1:unknown");
        assert!(asset_info(&asset).is_err());
        asset["digest"] = Value::Null;
        assert!(asset_info(&asset).is_ok());
        asset["name"] = json!("../mod.jar");
        assert!(asset_info(&asset).is_err());
        asset["name"] = json!("installer.exe");
        assert!(asset_info(&asset).is_err());
    }
    #[test]
    #[ignore = "Explicit public GitHub API/download smoke test; never installs or executes downloaded mods"]
    fn live_public_release() {
        let response = releases("FabricMC/fabric-api", 1).unwrap();
        let asset = response["releases"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|r| r["assets"].as_array().unwrap())
            .find(|a| asset_info(a).is_ok())
            .expect("Published Fabric API JAR");
        let bytes = download("FabricMC/fabric-api", asset["id"].as_u64().unwrap()).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert!(
            zip.by_name("fabric.mod.json").is_ok()
                || zip.by_name("META-INF/neoforge.mods.toml").is_ok()
        );
        println!("Verified public GitHub release asset {}", asset["name"]);
    }
}
