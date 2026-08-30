use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{
    pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey},
    SigningKey,
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read, Write},
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

use crate::native_error::{NativeError, NativeResult};

static IDENTITY_LOCK: Mutex<()> = Mutex::new(());

pub struct Template {
    id: &'static str,
    minecraft: &'static str,
    loader: &'static str,
    loader_version: &'static str,
    java: u16,
    bytes: &'static [u8],
}
include!(concat!(env!("OUT_DIR"), "/agent_templates.rs"));

#[derive(Serialize, Deserialize)]
struct Identity {
    token: String,
    private_key: String,
    public_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    profile_id: Option<String>,
    pack_id: String,
    pack_name: String,
    server_url: String,
    api_host: String,
    api_port: u16,
    template_id: String,
    loader_version: String,
    allow_insecure_http: bool,
}

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

fn validate_pack_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Project ID must contain 1 to 64 Latin letters, digits, '-' or '_'.".into());
    }
    Ok(())
}

fn new_identity() -> Result<Identity, String> {
    let key = SigningKey::generate(&mut OsRng);
    let mut token = [0u8; 32];
    OsRng.fill_bytes(&mut token);
    Ok(Identity {
        token: token.iter().map(|v| format!("{v:02x}")).collect(),
        private_key: STANDARD.encode(key.to_pkcs8_der().map_err(error)?.as_bytes()),
        public_key: STANDARD.encode(
            key.verifying_key()
                .to_public_key_der()
                .map_err(error)?
                .as_bytes(),
        ),
    })
}

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

fn identity_name(pack_id: &str, profile: Option<&str>) -> Result<String, String> {
    validate_pack_id(pack_id)?;
    match profile {
        Some(id) => {
            validate_profile_id(id)?;
            Ok(format!("profile:{id}:{pack_id}"))
        }
        None => Ok(pack_id.to_owned()),
    }
}

fn identity_entry(pack_id: &str, profile: Option<&str>) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        &crate::credential_service("dev.udmc.control.identity"),
        &identity_name(pack_id, profile)?,
    )
    .map_err(error)
}

fn load_identity(pack_id: &str, profile: Option<&str>) -> Result<Identity, String> {
    let _guard = IDENTITY_LOCK.lock().map_err(error)?;
    let entry = identity_entry(pack_id, profile)?;
    match entry.get_password() {
        Ok(value) => serde_json::from_str(&value).map_err(error),
        Err(keyring::Error::NoEntry) => {
            let identity = new_identity()?;
            entry
                .set_password(&serde_json::to_string(&identity).map_err(error)?)
                .map_err(error)?;
            Ok(identity)
        }
        Err(e) => Err(format!("Windows credential storage is unavailable: {e}")),
    }
}

fn fingerprint(identity: &Identity) -> String {
    let hash = Sha256::digest(STANDARD.decode(&identity.public_key).unwrap_or_default());
    hash.iter().map(|b| format!("{b:02x}")).collect()
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

#[tauri::command]
pub async fn generator_identity(
    pack_id: String,
    profile_id: Option<String>,
) -> NativeResult<Value> {
    let identity = load_identity(&pack_id, profile_id.as_deref()).map_err(|detail| {
        NativeError::detail(
            "GENERATOR_IDENTITY_FAILED",
            "Could not load or create the project keys.",
            detail,
        )
    })?;
    Ok(json!({"token": identity.token, "fingerprint": fingerprint(&identity)}))
}

fn validate_request(request: &GenerateRequest) -> Result<&'static Template, String> {
    validate_pack_id(&request.pack_id)?;
    if let Some(id) = &request.profile_id {
        validate_profile_id(id)?;
    }
    if request.pack_name.trim().is_empty() || request.pack_name.len() > 256 {
        return Err("Enter a project name up to 256 characters.".into());
    }
    let url = url::Url::parse(&request.server_url).map_err(error)?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || url.scheme() == "http" && request.allow_insecure_http)
    {
        return Err("Use an HTTPS address without credentials, a query, or a fragment. HTTP must be enabled explicitly for a trusted network.".into());
    }
    if request.api_port == 0 || !["127.0.0.1", "0.0.0.0"].contains(&request.api_host.as_str()) {
        return Err("The API bind address or port is invalid.".into());
    }
    if [25565, 25575].contains(&request.api_port) {
        return Err("Choose a separate API port, not the standard Minecraft or RCON port.".into());
    }
    let template = TEMPLATES
        .iter()
        .find(|t| t.id == request.template_id)
        .ok_or("This Control release has no built-in agent for the selected version.")?;
    // The catalog exposes only compiled/tested loader versions, never arbitrary text.
    if request.loader_version != template.loader_version {
        return Err("The loader version does not match this release catalog.".into());
    }
    Ok(template)
}

fn make_bootstrap(request: &GenerateRequest, identity: &Identity, server: bool) -> Value {
    let mut value = json!({
        "role": if server { "server" } else { "client" },
        "packId": request.pack_id, "packName": request.pack_name.trim(),
        "serverUrl": request.server_url.trim_end_matches('/'),
        "templateId": request.template_id,
        "manifestPublicKey": identity.public_key,
        "requireSignedManifest": true, "allowInsecureHttp": request.allow_insecure_http
    });
    if let Some(template) = TEMPLATES.iter().find(|t| t.id == request.template_id) {
        value["minecraftVersion"] = json!(template.minecraft);
        value["loaderType"] = json!(template.loader);
        value["loaderVersion"] = json!(request.loader_version);
    }
    if server {
        value["apiHost"] = json!(request.api_host);
        value["apiPort"] = json!(request.api_port);
        value["adminToken"] = json!(identity.token);
        value["manifestPrivateKey"] = json!(identity.private_key);
    }
    value["bootstrapId"] = json!(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).unwrap())
    ));
    value
}

fn customize_jar(template: &[u8], bootstrap: &Value) -> Result<Vec<u8>, String> {
    let mut input = ZipArchive::new(Cursor::new(template)).map_err(error)?;
    let metadata_path = match bootstrap["loaderType"].as_str() {
        Some("fabric") => "fabric.mod.json",
        Some("neoforge") => "META-INF/neoforge.mods.toml",
        _ => return Err("Unknown agent loader".into()),
    };
    input.by_name(metadata_path).map_err(error)?;
    let mut output = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let server = bootstrap["role"] == "server";
    for index in 0..input.len() {
        let mut file = input.by_index(index).map_err(error)?;
        let name = file.name().to_string();
        if file.is_dir() || name == "udmc-bootstrap.json" {
            continue;
        }
        if name == "fabric.mod.json" {
            let mut metadata: Value = serde_json::from_reader(&mut file).map_err(error)?;
            metadata["environment"] = json!(if server { "server" } else { "client" });
            metadata["name"] = json!(if server { "UDMC Server" } else { "UDMC Client" });
            metadata["mixins"] = json!([if server {
                "udmc_sync.mixins.json"
            } else {
                "udmc_sync.client.mixins.json"
            }]);
            metadata["entrypoints"]
                .as_object_mut()
                .ok_or("Invalid template metadata")?
                .remove(if server { "client" } else { "server" });
            output.start_file(name, options).map_err(error)?;
            output
                .write_all(&serde_json::to_vec(&metadata).map_err(error)?)
                .map_err(error)?;
        } else if name == "META-INF/neoforge.mods.toml" {
            let mut body = String::new();
            file.read_to_string(&mut body).map_err(error)?;
            let mut metadata: toml::Value = toml::from_str(&body).map_err(error)?;
            let mods = metadata
                .get_mut("mods")
                .and_then(toml::Value::as_array_mut)
                .ok_or("Invalid NeoForge template")?;
            if mods.len() != 1
                || mods[0].get("modId").and_then(toml::Value::as_str) != Some("udmc_sync")
            {
                return Err("Invalid NeoForge agent ID".into());
            }
            mods[0]["displayName"] =
                toml::Value::String(if server { "UDMC Server" } else { "UDMC Client" }.into());
            output.start_file(name, options).map_err(error)?;
            output
                .write_all(toml::to_string(&metadata).map_err(error)?.as_bytes())
                .map_err(error)?;
        } else {
            output.start_file(name, options).map_err(error)?;
            std::io::copy(&mut file, &mut output).map_err(error)?;
        }
    }
    output
        .start_file("udmc-bootstrap.json", options)
        .map_err(error)?;
    output
        .write_all(&serde_json::to_vec_pretty(bootstrap).map_err(error)?)
        .map_err(error)?;
    Ok(output.finish().map_err(error)?.into_inner())
}

fn prepare_remote_package(mut bootstrap: Value, update: bool) -> Result<Value, String> {
    let fields = [
        "role",
        "packId",
        "packName",
        "serverUrl",
        "manifestPublicKey",
        "requireSignedManifest",
        "allowInsecureHttp",
        "minecraftVersion",
        "loaderType",
        "loaderVersion",
    ];
    let object = bootstrap
        .as_object()
        .ok_or("Invalid client configuration")?;
    if object.len() != fields.len()
        || object.keys().any(|key| !fields.contains(&key.as_str()))
        || bootstrap["role"] != "client"
        || bootstrap["requireSignedManifest"] != true
    {
        return Err("The server returned unexpected client configuration fields".into());
    }
    validate_pack_id(bootstrap["packId"].as_str().ok_or("Missing project ID")?)?;
    let public_key = STANDARD
        .decode(
            bootstrap["manifestPublicKey"]
                .as_str()
                .ok_or("Missing public key")?,
        )
        .map_err(error)?;
    use ed25519_dalek::pkcs8::DecodePublicKey;
    ed25519_dalek::VerifyingKey::from_public_key_der(&public_key).map_err(error)?;
    let url = url::Url::parse(
        bootstrap["serverUrl"]
            .as_str()
            .ok_or("Missing server address")?,
    )
    .map_err(error)?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || url.scheme() == "http" && bootstrap["allowInsecureHttp"] == true)
    {
        return Err("Unsafe client download address".into());
    }
    let name = bootstrap["packName"]
        .as_str()
        .ok_or("Missing project name")?;
    if name.is_empty() || name.len() > 512 {
        return Err("Invalid project name".into());
    }
    let template = TEMPLATES
        .iter()
        .find(|t| {
            bootstrap["minecraftVersion"] == t.minecraft && bootstrap["loaderType"] == t.loader
        })
        .ok_or("This Control release has no compatible agent for the connected server")?;
    bootstrap["templateId"] = json!(template.id);
    bootstrap["bootstrapId"] = json!(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&bootstrap).map_err(error)?)
    ));
    let client = customize_jar(template.bytes, &bootstrap)?;
    let client_hash = format!("{:x}", Sha256::digest(&client));
    let bytes = if update {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("client.jar", options).map_err(error)?;
        zip.write_all(&client).map_err(error)?;
        zip.start_file("server.jar", options).map_err(error)?;
        zip.write_all(template.bytes).map_err(error)?;
        zip.finish().map_err(error)?.into_inner()
    } else {
        client
    };
    Ok(
        json!({"bytes": STANDARD.encode(&bytes), "size": bytes.len(), "version": env!("CARGO_PKG_VERSION"), "clientHash": client_hash}),
    )
}

#[tauri::command]
pub async fn prepare_agent_package(bootstrap: Value, update: bool) -> NativeResult<Value> {
    let result =
        tauri::async_runtime::spawn_blocking(move || prepare_remote_package(bootstrap, update))
            .await
            .map_err(|detail| {
                NativeError::detail(
                    "AGENT_PACKAGE_PREPARE_FAILED",
                    "Could not prepare the agent package.",
                    detail,
                )
            })?;
    result.map_err(|detail| {
        NativeError::detail(
            "AGENT_PACKAGE_PREPARE_FAILED",
            "Could not prepare the agent package.",
            detail,
        )
    })
}

fn export_pair(parent: &Path, request: &GenerateRequest) -> Result<Value, String> {
    let template = validate_request(request)?;
    let identity = load_identity(&request.pack_id, request.profile_id.as_deref())?;
    let server = customize_jar(template.bytes, &make_bootstrap(request, &identity, true))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(error)?
        .as_millis();
    let directory = parent.join(format!(
        "udmc-{}-{}-{}-{timestamp}",
        request.pack_id, template.loader, template.minecraft
    ));
    fs::create_dir(&directory).map_err(error)?;
    // A new export directory avoids overwriting any previous release or server secrets.
    let result = (|| {
        fs::write(directory.join("udmc-sync-server.jar"), &server).map_err(error)?;
        fs::write(directory.join("INSTALL.txt"), format!(
            "UDMC Control {}\nMinecraft {} / {} {} / Java {}+\n\nSERVER: put udmc-sync-server.jar in the server mods directory. Keep this JAR private: it contains the admin token and signing key.\nThen start the server and connect Control. The matching client JAR is uploaded automatically. Share ONLY the player download link shown in server settings. Never share this server JAR.\nReplace the previous UDMC JAR; do not keep two agents in mods.\nAPI: {}\nPublic key SHA-256: {}\n\nKeep the server JAR as a private recovery backup. Control can restore its project keys from this JAR. No Java, Gradle, Rust or Node.js is needed on the admin PC.\n",
            env!("CARGO_PKG_VERSION"), template.minecraft, template.loader, template.loader_version, template.java, request.server_url, fingerprint(&identity)
        )).map_err(error)?;
        Ok(
            json!({"directory": directory.to_string_lossy(), "serverFile": "udmc-sync-server.jar", "fingerprint": fingerprint(&identity)}),
        )
    })();
    if result.is_err() {
        for name in [
            "udmc-sync-server.jar",
            "udmc-sync-client.jar",
            "INSTALL.txt",
        ] {
            let _ = fs::remove_file(directory.join(name));
        }
        let _ = fs::remove_dir(&directory);
    }
    result
}

#[tauri::command]
pub async fn generate_agents(
    app: tauri::AppHandle,
    request: GenerateRequest,
    dialog_title: Option<String>,
) -> NativeResult<Option<Value>> {
    validate_request(&request).map_err(agent_export_error)?;
    let Some(parent) = app
        .dialog()
        .file()
        .set_title(native_label(
            dialog_title,
            "Choose a folder for the UDMC server JAR",
        ))
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let parent = parent.into_path().map_err(agent_export_error)?;
    let result = tauri::async_runtime::spawn_blocking(move || export_pair(&parent, &request))
        .await
        .map_err(agent_export_error)?;
    result.map(Some).map_err(agent_export_error)
}

fn agent_export_error(detail: impl std::fmt::Display) -> NativeError {
    NativeError::detail(
        "AGENT_EXPORT_FAILED",
        "Could not create the server agent.",
        detail,
    )
}

#[tauri::command]
pub async fn recover_identity(
    app: tauri::AppHandle,
    profile_id: Option<String>,
    dialog_title: Option<String>,
    dialog_filter: Option<String>,
) -> NativeResult<Option<Value>> {
    recover_identity_inner(app, profile_id, dialog_title, dialog_filter).map_err(|detail| {
        NativeError::detail(
            "IDENTITY_RECOVERY_FAILED",
            "Could not recover project access from the server JAR.",
            detail,
        )
    })
}

fn recover_identity_inner(
    app: tauri::AppHandle,
    profile_id: Option<String>,
    dialog_title: Option<String>,
    dialog_filter: Option<String>,
) -> Result<Option<Value>, String> {
    if let Some(id) = &profile_id {
        validate_profile_id(id)?;
    }
    let Some(path) = app
        .dialog()
        .file()
        .set_title(native_label(dialog_title, "Choose the UDMC server JAR"))
        .add_filter(native_label(dialog_filter, "UDMC server JAR"), &["jar"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let file = fs::File::open(path.into_path().map_err(error)?).map_err(error)?;
    let mut archive = ZipArchive::new(file).map_err(error)?;
    let mut body = String::new();
    archive
        .by_name("udmc-bootstrap.json")
        .map_err(error)?
        .take(65537)
        .read_to_string(&mut body)
        .map_err(error)?;
    if body.len() > 65536 {
        return Err("Bootstrap is too large".into());
    }
    let config: Value = serde_json::from_str(&body).map_err(error)?;
    if config["role"] != "server" {
        return Err("Choose the server JAR, not the client JAR.".into());
    }
    let pack_id = config["packId"].as_str().ok_or("Missing project ID")?;
    let identity = Identity {
        token: config["adminToken"].as_str().ok_or("Missing token")?.into(),
        private_key: config["manifestPrivateKey"]
            .as_str()
            .ok_or("Missing key")?
            .into(),
        public_key: config["manifestPublicKey"]
            .as_str()
            .ok_or("Missing key")?
            .into(),
    };
    let key = SigningKey::from_pkcs8_der(&STANDARD.decode(&identity.private_key).map_err(error)?)
        .map_err(error)?;
    if identity.token.len() != 64 || !identity.token.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("The server JAR contains an invalid administrator token.".into());
    }
    if STANDARD.encode(
        key.verifying_key()
            .to_public_key_der()
            .map_err(error)?
            .as_bytes(),
    ) != identity.public_key
    {
        return Err("The signing keys in the JAR do not match.".into());
    }
    let _guard = IDENTITY_LOCK.lock().map_err(error)?;
    let entry = identity_entry(pack_id, profile_id.as_deref())?;
    match entry.get_password() {
        Ok(existing) => {
            let old: Identity = serde_json::from_str(&existing).map_err(error)?;
            if old.public_key != identity.public_key || old.token != identity.token {
                return Err("Windows already stores different keys for this project. Automatic replacement is not allowed.".into());
            }
        }
        Err(keyring::Error::NoEntry) => entry
            .set_password(&serde_json::to_string(&identity).map_err(error)?)
            .map_err(error)?,
        Err(e) => return Err(error(e)),
    }
    Ok(Some(
        json!({"packId": pack_id, "packName": config["packName"], "serverUrl": config["serverUrl"], "token": identity.token,
            "fingerprint": fingerprint(&identity), "apiHost": config["apiHost"], "apiPort": config["apiPort"],
            "allowInsecureHttp": config["allowInsecureHttp"], "templateId": config["templateId"]}),
    ))
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
    fn request() -> GenerateRequest {
        GenerateRequest {
            profile_id: None,
            pack_id: "test".into(),
            pack_name: "Test".into(),
            server_url: "https://example.com/sync".into(),
            api_host: "127.0.0.1".into(),
            api_port: 3077,
            template_id: "fabric-26.2".into(),
            loader_version: "0.19.3".into(),
            allow_insecure_http: false,
        }
    }

    #[test]
    fn native_labels_are_bounded_and_have_safe_fallbacks() {
        assert_eq!(
            native_label(Some("  Сервер UDMC  ".into()), "Fallback"),
            "Сервер UDMC"
        );
        assert_eq!(
            native_label(Some("bad\nlabel".into()), "Fallback"),
            "Fallback"
        );
        assert_eq!(native_label(Some("x".repeat(129)), "Fallback"), "Fallback");
    }
    #[test]
    fn client_bootstrap_has_no_secrets() {
        let identity = new_identity().unwrap();
        let value = make_bootstrap(&request(), &identity, false);
        let text = value.to_string();
        assert!(!text.contains(&identity.token));
        assert!(!text.contains(&identity.private_key));
        assert!(value.get("adminToken").is_none());
        assert_eq!(value["manifestPublicKey"], identity.public_key);
    }
    #[test]
    fn profile_keys_are_separated_without_changing_legacy_entries() {
        let first = "11111111-1111-4111-8111-111111111111";
        let second = "22222222-2222-4222-8222-222222222222";
        assert_eq!(identity_name("udmc-main", None).unwrap(), "udmc-main");
        assert_ne!(
            identity_name("udmc-main", Some(first)).unwrap(),
            identity_name("udmc-main", Some(second)).unwrap()
        );
        assert!(validate_credential_name(&format!("profile:{first}:admin-connection")).is_ok());
        assert!(validate_credential_name("profile:../other:admin-connection").is_err());
        assert!(validate_credential_name(&format!("profile:{first}:unknown")).is_err());
        let request = GenerateRequest {
            profile_id: Some(first.into()),
            ..request()
        };
        assert!(!make_bootstrap(&request, &new_identity().unwrap(), true)
            .to_string()
            .contains(first));
    }
    #[test]
    fn key_round_trip_and_identity_reuse() {
        let identity = new_identity().unwrap();
        let key =
            SigningKey::from_pkcs8_der(&STANDARD.decode(&identity.private_key).unwrap()).unwrap();
        assert_eq!(
            STANDARD.encode(key.verifying_key().to_public_key_der().unwrap().as_bytes()),
            identity.public_key
        );
        assert_eq!(
            make_bootstrap(&request(), &identity, true),
            make_bootstrap(&request(), &identity, true)
        );
    }
    #[test]
    fn packaged_clients_cannot_contain_admin_secrets() {
        let identity = new_identity().unwrap();
        for template in TEMPLATES {
            let request = GenerateRequest {
                template_id: template.id.into(),
                loader_version: template.loader_version.into(),
                ..request()
            };
            assert_eq!(validate_request(&request).unwrap().loader, template.loader);
            let client_bootstrap = make_bootstrap(&request, &identity, false);
            assert_eq!(client_bootstrap["loaderType"], template.loader);
            assert_eq!(client_bootstrap["minecraftVersion"], template.minecraft);
            let jar = customize_jar(template.bytes, &client_bootstrap).unwrap();
            let mut zip = ZipArchive::new(Cursor::new(jar)).unwrap();
            for i in 0..zip.len() {
                let mut contents = Vec::new();
                zip.by_index(i).unwrap().read_to_end(&mut contents).unwrap();
                let contents = String::from_utf8_lossy(&contents);
                assert!(!contents.contains(&identity.token));
                assert!(!contents.contains(&identity.private_key));
            }
            if template.loader == "fabric" {
                let metadata: Value =
                    serde_json::from_reader(zip.by_name("fabric.mod.json").unwrap()).unwrap();
                assert_eq!(metadata["environment"], "client");
                assert_eq!(metadata["mixins"], json!(["udmc_sync.client.mixins.json"]));
                assert_eq!(
                    metadata["depends"]["minecraft"],
                    format!("={}", template.minecraft)
                );
                assert_eq!(metadata["version"], env!("CARGO_PKG_VERSION"));
            } else {
                let mut body = String::new();
                zip.by_name("META-INF/neoforge.mods.toml")
                    .unwrap()
                    .read_to_string(&mut body)
                    .unwrap();
                let metadata: toml::Value = toml::from_str(&body).unwrap();
                assert_eq!(
                    metadata["mods"][0]["displayName"].as_str(),
                    Some("UDMC Client")
                );
                assert_eq!(
                    metadata["mods"][0]["version"].as_str(),
                    Some(env!("CARGO_PKG_VERSION"))
                );
                assert_eq!(
                    metadata["dependencies"]["udmc_sync"][1]["versionRange"].as_str(),
                    Some(format!("[{}]", template.minecraft).as_str())
                );
                assert!(zip.by_name("fabric.mod.json").is_err());
                assert!(zip
                    .by_name("dev/udmc/sync/NeoForgeEntrypoint.class")
                    .is_ok());
            }
            let mut class_header = [0u8; 8];
            zip.by_name("dev/udmc/sync/ModSynchronizer.class")
                .unwrap()
                .read_exact(&mut class_header)
                .unwrap();
            assert_eq!(
                u16::from_be_bytes([class_header[6], class_header[7]]),
                template.java + 44
            );
            let server =
                customize_jar(template.bytes, &make_bootstrap(&request, &identity, true)).unwrap();
            let mut server = ZipArchive::new(Cursor::new(server)).unwrap();
            let bootstrap: Value =
                serde_json::from_reader(server.by_name("udmc-bootstrap.json").unwrap()).unwrap();
            assert_eq!(bootstrap["adminToken"], identity.token);
            assert_eq!(bootstrap["manifestPrivateKey"], identity.private_key);
            if template.loader == "fabric" {
                let metadata: Value =
                    serde_json::from_reader(server.by_name("fabric.mod.json").unwrap()).unwrap();
                assert_eq!(metadata["environment"], "server");
                assert!(metadata["entrypoints"].get("client").is_none());
            } else {
                let mut body = String::new();
                server
                    .by_name("META-INF/neoforge.mods.toml")
                    .unwrap()
                    .read_to_string(&mut body)
                    .unwrap();
                let metadata: toml::Value = toml::from_str(&body).unwrap();
                assert_eq!(
                    metadata["mods"][0]["displayName"].as_str(),
                    Some("UDMC Server")
                );
            }
        }
    }
    #[test]
    fn unsafe_configuration_is_rejected() {
        let mut request = request();
        request.server_url = "http://example.com".into();
        assert!(validate_request(&request).is_err());
        request.server_url = "https://user:password@example.com".into();
        assert!(validate_request(&request).is_err());
        assert!(validate_pack_id("../server").is_err());
    }

    #[test]
    fn remote_agent_packages_preserve_server_secrets_and_reject_extra_fields() {
        let identity = new_identity().unwrap();
        for template in TEMPLATES {
            let request = GenerateRequest {
                template_id: template.id.into(),
                loader_version: template.loader_version.into(),
                ..request()
            };
            let mut bootstrap = make_bootstrap(&request, &identity, false);
            bootstrap.as_object_mut().unwrap().remove("templateId");
            bootstrap.as_object_mut().unwrap().remove("bootstrapId");
            let result = prepare_remote_package(bootstrap.clone(), false).unwrap();
            let raw = STANDARD.decode(result["bytes"].as_str().unwrap()).unwrap();
            assert_eq!(result["clientHash"], format!("{:x}", Sha256::digest(&raw)));
            let mut client = ZipArchive::new(Cursor::new(raw)).unwrap();
            let config: Value =
                serde_json::from_reader(client.by_name("udmc-bootstrap.json").unwrap()).unwrap();
            assert_eq!(config["manifestPublicKey"], identity.public_key);
            assert!(config.get("adminToken").is_none());
            assert!(config.get("manifestPrivateKey").is_none());
            let update = prepare_remote_package(bootstrap.clone(), true).unwrap();
            let mut bundle = ZipArchive::new(Cursor::new(
                STANDARD.decode(update["bytes"].as_str().unwrap()).unwrap(),
            ))
            .unwrap();
            assert_eq!(bundle.len(), 2);
            let mut server = Vec::new();
            bundle
                .by_name("server.jar")
                .unwrap()
                .read_to_end(&mut server)
                .unwrap();
            assert_eq!(server, template.bytes);
            assert!(ZipArchive::new(Cursor::new(server))
                .unwrap()
                .by_name("udmc-bootstrap.json")
                .is_err());
            bootstrap["adminToken"] = json!(identity.token);
            assert!(prepare_remote_package(bootstrap, false).is_err());
        }
    }

    #[test]
    fn mismatched_loader_templates_are_rejected() {
        let identity = new_identity().unwrap();
        let fabric = TEMPLATES.iter().find(|t| t.loader == "fabric").unwrap();
        let neo = TEMPLATES.iter().find(|t| t.loader == "neoforge").unwrap();
        let request = GenerateRequest {
            template_id: neo.id.into(),
            loader_version: neo.loader_version.into(),
            ..request()
        };
        assert!(customize_jar(fabric.bytes, &make_bootstrap(&request, &identity, false)).is_err());
        let invalid = GenerateRequest {
            loader_version: "21.1.1".into(),
            ..request
        };
        assert!(validate_request(&invalid).is_err());
    }

    #[test]
    #[ignore = "Creates isolated packaged agents for a manual Minecraft runtime test; never accesses Windows credentials"]
    fn export_neoforge_runtime_fixture() {
        let template_id =
            std::env::var("UDMC_RUNTIME_TEMPLATE").unwrap_or_else(|_| "neoforge-1.21.1".into());
        let template = TEMPLATES.iter().find(|t| t.id == template_id).unwrap();
        let api = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let game = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let api_port = api.local_addr().unwrap().port();
        let game_port = game.local_addr().unwrap().port();
        let identity = new_identity().unwrap();
        let request = GenerateRequest {
            pack_id: "udmc-runtime-test".into(),
            pack_name: "UDMC runtime test".into(),
            server_url: format!("http://127.0.0.1:{api_port}"),
            api_port,
            template_id: template.id.into(),
            loader_version: template.loader_version.into(),
            allow_insecure_http: true,
            ..request()
        };
        validate_request(&request).unwrap();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.qa")
            .join(format!("{}-runtime-{stamp}", template.id));
        for (role, server) in [("server", true), ("client", false)] {
            let directory = root.join(role).join("mods");
            fs::create_dir_all(&directory).unwrap();
            fs::write(
                directory.join(format!("udmc-sync-{role}.jar")),
                customize_jar(template.bytes, &make_bootstrap(&request, &identity, server))
                    .unwrap(),
            )
            .unwrap();
        }
        let mut public = make_bootstrap(&request, &identity, false);
        public.as_object_mut().unwrap().remove("bootstrapId");
        public.as_object_mut().unwrap().remove("templateId");
        for (file, update) in [("delivery.jar", false), ("update.zip", true)] {
            let package = prepare_remote_package(public.clone(), update).unwrap();
            fs::write(
                root.join(file),
                STANDARD.decode(package["bytes"].as_str().unwrap()).unwrap(),
            )
            .unwrap();
        }
        fs::copy(
            root.join("delivery.jar"),
            root.join("client/mods/udmc-sync-client.jar"),
        )
        .unwrap();
        if let Ok(next) = std::env::var("UDMC_RUNTIME_UPDATE_JAR") {
            let next = fs::read(next).unwrap();
            let mut baseline =
                ZipArchive::new(Cursor::new(fs::read(root.join("delivery.jar")).unwrap())).unwrap();
            let bootstrap: Value =
                serde_json::from_reader(baseline.by_name("udmc-bootstrap.json").unwrap()).unwrap();
            let client = customize_jar(&next, &bootstrap).unwrap();
            fs::write(root.join("client-next.jar"), &client).unwrap();
            let mut bundle = ZipWriter::new(Cursor::new(Vec::new()));
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            bundle.start_file("client.jar", options).unwrap();
            bundle.write_all(&client).unwrap();
            bundle.start_file("server.jar", options).unwrap();
            bundle.write_all(&next).unwrap();
            fs::write(
                root.join("update.zip"),
                bundle.finish().unwrap().into_inner(),
            )
            .unwrap();
        }
        fs::write(
            root.join("client/options.txt"),
            "lang:en_us\nguiScale:2\nfullscreen:false\nonboardAccessibility:false\n",
        )
        .unwrap();
        fs::write(root.join("server/server.properties"), format!("server-ip=127.0.0.1\nserver-port={game_port}\nonline-mode=false\nenforce-secure-profile=false\nlevel-name=test-world\nview-distance=2\nsimulation-distance=2\nmax-players=4\n")).unwrap();
        fs::write(root.join("fixture.json"), serde_json::to_vec_pretty(&json!({"url":request.server_url,"token":identity.token,"publicKey":identity.public_key,"gamePort":game_port,"template":template.id,"minecraft":template.minecraft,"isolatedRuntimeFixture":true})).unwrap()).unwrap();
        println!(
            "Isolated runtime fixture: {}",
            root.canonicalize().unwrap().display()
        );
    }
}
