use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Cursor, Write},
    path::Path,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use zip::{write::SimpleFileOptions, ZipWriter};

use crate::native_error::{NativeError, NativeResult};

pub struct Template {
    id: &'static str,
    minecraft: &'static str,
    loader: &'static str,
    loader_version: &'static str,
    java: u16,
    bytes: &'static [u8],
}
include!(concat!(env!("OUT_DIR"), "/agent_templates.rs"));

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn native_label(value: Option<String>, fallback: &str) -> String {
    value
        .map(|label| label.trim().to_owned())
        .filter(|label| {
            !label.is_empty()
                && label.chars().count() <= 128
                && !label.chars().any(char::is_control)
        })
        .unwrap_or_else(|| fallback.to_owned())
}

#[tauri::command]
pub fn generator_catalog() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "templates": TEMPLATES.iter().map(|t| json!({
            "id": t.id, "minecraft": t.minecraft, "loader": t.loader,
            "loaderVersion": t.loader_version, "java": t.java, "size": t.bytes.len()
        })).collect::<Vec<_>>()
    })
}


/// What the panel asks for: a game version from the catalog, and nothing about any project.
/// The file is the same for every server and every player, so there is nothing to personalise.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    template_id: String,
    loader_version: String,
}

fn find_template(request: &AgentRequest) -> Result<&'static Template, String> {
    let template = TEMPLATES
        .iter()
        .find(|t| t.id == request.template_id)
        .ok_or("This Control release has no built-in agent for the selected version.")?;
    // The catalog exposes only compiled and tested loader versions, never arbitrary text.
    if request.loader_version != template.loader_version {
        return Err("The loader version does not match this release catalog.".into());
    }
    Ok(template)
}

/// The mod, ready to hand over. One file for the server and for players: nothing is written
/// into it, so sharing it is harmless and there is no wrong copy to hand to the wrong person.
fn package(template: &'static Template, update: bool) -> Result<Value, String> {
    let bytes = if update {
        // The server expects the pair it has always expected. Both entries are the same file
        // now, which is exactly what makes an update a matter of replacing one mod.
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for name in ["client.jar", "server.jar"] {
            zip.start_file(name, options).map_err(error)?;
            zip.write_all(template.bytes).map_err(error)?;
        }
        zip.finish().map_err(error)?.into_inner()
    } else {
        template.bytes.to_vec()
    };
    Ok(json!({"bytes": STANDARD.encode(&bytes), "size": bytes.len()}))
}

#[tauri::command]
pub async fn prepare_agent_package(request: AgentRequest, update: bool) -> NativeResult<Value> {
    let template = find_template(&request).map_err(agent_error)?;
    package(template, update).map_err(agent_error)
}

fn file_name(template: &Template) -> String {
    format!("udmc-{}-{}.jar", template.loader, template.minecraft)
}

fn export(parent: &Path, template: &'static Template) -> Result<Value, String> {
    let name = file_name(template);
    let file = parent.join(&name);
    fs::write(&file, template.bytes).map_err(error)?;
    fs::write(parent.join("INSTALL.txt"), format!(
        "UDMC Control {}\nMinecraft {} / {} {} / Java {}+\n\nThis is the whole mod. The same file goes into the server's mods folder and into every player's mods folder - there are no secrets inside it and nothing in it belongs to one project.\n\nSERVER: put {name} in the server mods directory and start the server. It writes a pairing code into the console and into config/udmc-pairing.txt; enter that code in UDMC Control to take charge of the server.\n\nPLAYERS: put {name} in the mods folder and join the server. It will offer them the modpack and set itself up.\n\nReplace any previous UDMC file; do not keep two of them in mods.\n",
        env!("CARGO_PKG_VERSION"), template.minecraft, template.loader, template.loader_version, template.java
    )).map_err(error)?;
    Ok(json!({"directory": parent.to_string_lossy(), "file": name, "size": template.bytes.len()}))
}

/// Saves the mod for a chosen game version. The panel carries the files it was built with, so
/// the owner does not have to go looking for a download before they can set a server up.
#[tauri::command]
pub async fn save_agent(
    app: tauri::AppHandle,
    request: AgentRequest,
    dialog_title: Option<String>,
) -> NativeResult<Option<Value>> {
    let template = find_template(&request).map_err(agent_error)?;
    let Some(parent) = app
        .dialog()
        .file()
        .set_title(native_label(dialog_title, "Choose a folder for the UDMC mod"))
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let parent = parent.into_path().map_err(agent_error)?;
    tauri::async_runtime::spawn_blocking(move || export(&parent, template))
        .await
        .map_err(agent_error)?
        .map(Some)
        .map_err(agent_error)
}

fn agent_error(detail: impl std::fmt::Display) -> NativeError {
    NativeError::detail("AGENT_EXPORT_FAILED", "Could not save the UDMC mod.", detail)
}

#[tauri::command]
pub async fn credential_read(name: String) -> NativeResult<Option<String>> {
    credential_read_inner(&name).map_err(|detail| {
        NativeError::detail(
            "CREDENTIAL_READ_FAILED",
            "Could not read the protected value from Windows credential storage.",
            detail,
        )
    })
}

fn credential_read_inner(name: &str) -> Result<Option<String>, String> {
    let entry = credential_entry(name)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(error(e)),
    }
}

#[tauri::command]
pub async fn credential_write(name: String, value: Option<String>) -> NativeResult<()> {
    credential_write_inner(&name, value).map_err(|detail| {
        NativeError::detail(
            "CREDENTIAL_WRITE_FAILED",
            "Could not save the protected value in Windows credential storage.",
            detail,
        )
    })
}

fn credential_write_inner(name: &str, value: Option<String>) -> Result<(), String> {
    let entry = credential_entry(name)?;
    if let Some(value) = value {
        entry.set_password(&value).map_err(error)
    } else {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(error(e)),
        }
    }
}

fn credential_entry(name: &str) -> Result<keyring::Entry, String> {
    validate_credential_name(name)?;
    keyring::Entry::new(&crate::credential_service("dev.udmc.control"), name).map_err(error)
}

/// Server profiles are named by UUID, and a credential name carries one. Anything else would
/// let a caller reach across profiles by writing its own key name.
fn validate_profile_id(id: &str) -> Result<(), String> {
    if id.len() != 36
        || !id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
    {
        return Err("Invalid server profile".into());
    }
    Ok(())
}

fn validate_credential_name(name: &str) -> Result<(), String> {
    let leaf = if let Some(scoped) = name.strip_prefix("profile:") {
        let (profile, leaf) = scoped.split_once(':').ok_or("Invalid credential name")?;
        validate_profile_id(profile)?;
        leaf
    } else {
        name
    };
    if ![
        "admin-connection",
        "rcon-password",
        "access-device",
        "pending-access",
        "curseforge-api-key",
        "translator-key",
    ]
    .contains(&leaf)
    {
        return Err("Invalid credential name".into());
    }
    Ok(())
}

#[tauri::command]
pub fn device_name(fallback: Option<String>) -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|name| !name.is_empty() && name.len() <= 64 && !name.chars().any(char::is_control))
        .unwrap_or_else(|| native_label(fallback, "This computer"))
}

#[tauri::command]
pub fn dependency_status() -> Value {
    json!({"version": env!("CARGO_PKG_VERSION"), "webview": true, "templates": TEMPLATES.len(), "credentialStore": cfg!(windows)})
}

#[tauri::command]
pub fn open_dependency(app: tauri::AppHandle, name: String) -> NativeResult<()> {
    let url = match name.as_str() {
        "java21" => "https://adoptium.net/temurin/releases/?version=21",
        "java25" => "https://adoptium.net/temurin/releases/?version=25",
        "fabric" => "https://fabricmc.net/use/installer/",
        "neoforge" => "https://neoforged.net/",
        "webview" => "https://developer.microsoft.com/microsoft-edge/webview2/",
        _ => {
            return Err(NativeError::new(
                "DEPENDENCY_UNKNOWN",
                "This dependency link is not supported.",
            ))
        }
    };
    app.opener().open_url(url, None::<&str>).map_err(|detail| {
        NativeError::detail(
            "DEPENDENCY_OPEN_FAILED",
            "Could not open the dependency page.",
            detail,
        )
    })
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use zip::ZipArchive;

    fn request() -> AgentRequest {
        let template = TEMPLATES.first().expect("a bundled agent");
        AgentRequest {
            template_id: template.id.into(),
            loader_version: template.loader_version.into(),
        }
    }

    #[test]
    fn native_labels_are_bounded_and_have_safe_fallbacks() {
        assert_eq!(native_label(None, "Fallback"), "Fallback");
        assert_eq!(native_label(Some("  ".into()), "Fallback"), "Fallback");
        assert_eq!(native_label(Some("Выберите папку".into()), "Fallback"), "Выберите папку");
        assert_eq!(native_label(Some("x".repeat(200)), "Fallback"), "Fallback");
        assert_eq!(native_label(Some("line\nbreak".into()), "Fallback"), "Fallback");
    }

    #[test]
    fn only_catalog_versions_are_accepted() {
        find_template(&request()).expect("the catalog entry");
        let mut wrong = request();
        wrong.template_id = "fabric-0.0.0".into();
        assert!(find_template(&wrong).is_err());
        let mut drifted = request();
        drifted.loader_version = "0.0.1".into();
        assert!(find_template(&drifted).is_err());
    }

    /// The whole point of the change: the file the panel hands out is the file it was built
    /// with. If anything were written into it, it would stop being safe to share.
    #[test]
    fn the_mod_is_handed_over_unchanged() {
        let template = find_template(&request()).expect("the catalog entry");
        let package = package(template, false).expect("a package");
        let bytes = STANDARD
            .decode(package["bytes"].as_str().expect("base64"))
            .expect("valid base64");
        assert_eq!(bytes, template.bytes);
        assert_eq!(package["size"].as_u64(), Some(template.bytes.len() as u64));
    }

    #[test]
    fn no_bundled_agent_carries_a_project() {
        // A file with settings baked in would carry an admin token and a signing key, and the
        // server refuses one on sight. None must ever be built into the panel again.
        for template in TEMPLATES {
            let mut archive =
                ZipArchive::new(Cursor::new(template.bytes)).expect("a readable agent JAR");
            assert!(
                archive.by_name("udmc-bootstrap.json").is_err(),
                "{} carries baked-in settings",
                template.id
            );
        }
    }

    #[test]
    fn a_remote_update_carries_the_same_file_for_both_roles() {
        let template = find_template(&request()).expect("the catalog entry");
        let package = package(template, true).expect("a bundle");
        let bytes = STANDARD
            .decode(package["bytes"].as_str().expect("base64"))
            .expect("valid base64");
        let mut archive = ZipArchive::new(Cursor::new(bytes)).expect("a readable bundle");
        assert_eq!(archive.len(), 2);
        let mut client = Vec::new();
        archive
            .by_name("client.jar")
            .expect("client.jar")
            .read_to_end(&mut client)
            .expect("readable");
        let mut server = Vec::new();
        archive
            .by_name("server.jar")
            .expect("server.jar")
            .read_to_end(&mut server)
            .expect("readable");
        assert_eq!(client, server);
        assert_eq!(client, template.bytes);
    }

    #[test]
    fn saved_files_are_named_after_the_game_they_are_for() {
        for template in TEMPLATES {
            let name = file_name(template);
            assert!(name.starts_with("udmc-"), "{name}");
            assert!(name.ends_with(".jar"), "{name}");
            assert!(name.contains(template.minecraft), "{name}");
            assert!(!name.contains(std::path::MAIN_SEPARATOR), "{name}");
        }
    }
}

