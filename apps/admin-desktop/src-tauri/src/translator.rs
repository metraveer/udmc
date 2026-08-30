use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::time::Duration;

use crate::native_error::{NativeError, NativeResult};

const ENDPOINT: &str = "https://translate.api.cloud.yandex.net/translate/v2/translate";
const MAX_TEXTS: usize = 32;
const MAX_TEXT_CHARS: usize = 4000;
const MAX_TOTAL_CHARS: usize = 9000;

fn api_key(value: &str) -> NativeResult<String> {
    let key = value.trim();
    if key.is_empty() {
        return Err(NativeError::new(
            "TRANSLATOR_KEY_MISSING",
            "Save a Yandex Translate API key on the settings page first.",
        ));
    }
    if key.len() < 8
        || key.len() > 128
        || !key
            .bytes()
            .all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\')
    {
        return Err(NativeError::new(
            "TRANSLATOR_KEY_INVALID",
            "The translator API key looks malformed. Copy it exactly from the Yandex Cloud console.",
        ));
    }
    Ok(key.to_owned())
}

fn folder_id(value: &str) -> NativeResult<String> {
    let folder = value.trim();
    if folder.is_empty()
        || folder.len() > 64
        || !folder
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(NativeError::new(
            "TRANSLATOR_FOLDER_INVALID",
            "Enter the Yandex Cloud folder id exactly as shown in the console.",
        ));
    }
    Ok(folder.to_owned())
}

fn validate_texts(texts: &[String]) -> NativeResult<()> {
    if texts.is_empty() || texts.len() > MAX_TEXTS {
        return Err(NativeError::new(
            "TRANSLATOR_TEXTS_INVALID",
            "The translation request holds no texts or too many of them.",
        ));
    }
    let mut total = 0usize;
    for text in texts {
        let length = text.chars().count();
        if length > MAX_TEXT_CHARS {
            return Err(NativeError::new(
                "TRANSLATOR_TEXTS_INVALID",
                "One of the description fragments is too long to translate.",
            ));
        }
        total += length;
    }
    if total > MAX_TOTAL_CHARS {
        return Err(NativeError::new(
            "TRANSLATOR_TEXTS_INVALID",
            "The description is too long for a single translation request.",
        ));
    }
    Ok(())
}

fn target_language(value: &str) -> NativeResult<&str> {
    match value {
        "ru" | "en" => Ok(value),
        _ => Err(NativeError::new(
            "TRANSLATOR_TARGET_INVALID",
            "Only Russian and English are supported as translation targets.",
        )),
    }
}

fn request(key: &str, body: Value) -> NativeResult<Value> {
    let client = Client::builder()
        .user_agent(concat!("UDMC-Control/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|detail| {
            NativeError::detail(
                "TRANSLATOR_REQUEST_FAILED",
                "Could not initialize the secure translator connection.",
                detail,
            )
        })?;
    let response = client
        .post(ENDPOINT)
        .header("Authorization", format!("Api-Key {key}"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .map_err(|detail| {
            NativeError::detail(
                "TRANSLATOR_REQUEST_FAILED",
                "Could not reach the Yandex Translate API.",
                detail,
            )
        })?;
    let status = response.status().as_u16();
    if matches!(status, 401 | 403) {
        return Err(NativeError::new(
            "TRANSLATOR_UNAUTHORIZED",
            "Yandex rejected the translator key. Check the API key, the folder id and the ai.translate.user role.",
        ));
    }
    if status == 429 {
        return Err(NativeError::new(
            "TRANSLATOR_RATE_LIMITED",
            "The translator quota is exhausted for now. Try again later.",
        ));
    }
    let body = response.text().map_err(|detail| {
        NativeError::detail(
            "TRANSLATOR_REQUEST_FAILED",
            "Could not read the translator response.",
            detail,
        )
    })?;
    if !(200..300).contains(&status) {
        return Err(NativeError::with_args(
            "TRANSLATOR_HTTP_FAILED",
            format!("The Yandex Translate API returned HTTP {status}."),
            vec![status.to_string()],
        ));
    }
    if body.len() > 4 * 1024 * 1024 {
        return Err(NativeError::new(
            "TRANSLATOR_RESPONSE_INVALID",
            "The translator response exceeds the size limit.",
        ));
    }
    serde_json::from_str(&body).map_err(|detail| {
        NativeError::detail(
            "TRANSLATOR_RESPONSE_INVALID",
            "The translator returned malformed data.",
            detail,
        )
    })
}

fn extract(value: Value, expected: usize) -> NativeResult<Vec<String>> {
    let translations: Vec<String> = value["translations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["text"].as_str().map(str::to_owned))
        .collect();
    if translations.len() != expected {
        return Err(NativeError::new(
            "TRANSLATOR_RESPONSE_INVALID",
            "The translator returned a different number of fragments.",
        ));
    }
    Ok(translations)
}

#[tauri::command]
pub async fn translate_texts(
    key: String,
    folder: String,
    texts: Vec<String>,
    target: String,
) -> NativeResult<Vec<String>> {
    let key = api_key(&key)?;
    let folder = folder_id(&folder)?;
    validate_texts(&texts)?;
    let target = target_language(&target)?.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let expected = texts.len();
        let body = json!({
            "folderId": folder,
            "texts": texts,
            "targetLanguageCode": target,
            "format": "PLAIN_TEXT",
        });
        extract(request(&key, body)?, expected)
    })
    .await
    .map_err(|detail| {
        NativeError::detail(
            "TRANSLATOR_REQUEST_FAILED",
            "The translation task did not finish.",
            detail,
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_key_folder_texts_and_target() {
        assert_eq!(api_key(" ").unwrap_err().code, "TRANSLATOR_KEY_MISSING");
        assert_eq!(api_key("short").unwrap_err().code, "TRANSLATOR_KEY_INVALID");
        assert_eq!(
            api_key(" AQVNkey-Example123 ").unwrap(),
            "AQVNkey-Example123"
        );
        assert_eq!(
            folder_id("bad folder!").unwrap_err().code,
            "TRANSLATOR_FOLDER_INVALID"
        );
        assert_eq!(
            folder_id(" b1gexample0folder ").unwrap(),
            "b1gexample0folder"
        );
        assert!(validate_texts(&["hello".into()]).is_ok());
        assert_eq!(
            validate_texts(&[]).unwrap_err().code,
            "TRANSLATOR_TEXTS_INVALID"
        );
        assert_eq!(
            validate_texts(&["x".repeat(5000)]).unwrap_err().code,
            "TRANSLATOR_TEXTS_INVALID"
        );
        assert_eq!(
            validate_texts(&["x".repeat(3500), "y".repeat(3500), "z".repeat(3500)])
                .unwrap_err()
                .code,
            "TRANSLATOR_TEXTS_INVALID"
        );
        assert!(target_language("ru").is_ok());
        assert_eq!(
            target_language("de").unwrap_err().code,
            "TRANSLATOR_TARGET_INVALID"
        );
    }

    #[test]
    fn extracts_exactly_matching_translations() {
        let value = json!({"translations": [{"text": "Привет"}, {"text": "Мир"}]});
        assert_eq!(extract(value, 2).unwrap(), vec!["Привет", "Мир"]);
        let short = json!({"translations": [{"text": "Один"}]});
        assert_eq!(
            extract(short, 2).unwrap_err().code,
            "TRANSLATOR_RESPONSE_INVALID"
        );
    }

    #[test]
    #[ignore = "Explicit Yandex Translate API smoke test; requires UDMC_TRANSLATOR_KEY and UDMC_TRANSLATOR_FOLDER"]
    fn live_translation() {
        let key = std::env::var("UDMC_TRANSLATOR_KEY").expect("Set UDMC_TRANSLATOR_KEY");
        let folder = std::env::var("UDMC_TRANSLATOR_FOLDER").expect("Set UDMC_TRANSLATOR_FOLDER");
        let body = json!({
            "folderId": folder_id(&folder).unwrap(),
            "texts": ["Sodium is a modern rendering engine for Minecraft."],
            "targetLanguageCode": "ru",
            "format": "PLAIN_TEXT",
        });
        let out = extract(request(&api_key(&key).unwrap(), body).unwrap(), 1).unwrap();
        println!("Translated: {}", out[0]);
        assert!(!out[0].is_empty());
    }
}
