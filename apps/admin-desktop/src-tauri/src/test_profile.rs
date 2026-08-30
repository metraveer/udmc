// Compiled only in debug builds. Native UI checks never use the real Windows vault or WebView profile.
pub fn name() -> Option<String> {
    std::env::var("UDMC_TEST_PROFILE").ok().filter(|name| {
        !name.is_empty()
            && name.len() <= 24
            && name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    })
}

pub fn configure(context: &mut tauri::Context<tauri::Wry>) {
    let Some(profile) = name() else { return };
    context.config_mut().identifier = format!("dev.udmc.control.test.{profile}");
    let window = &mut context.config_mut().app.windows[0];
    window.title = format!("UDMC UI Test - {profile}");
    window.data_directory = Some(
        std::env::temp_dir()
            .join("udmc-control-ui-tests")
            .join(&profile),
    );
    window.width = 940.0;
    window.height = 660.0;
    if let Ok(seed) = std::env::var("UDMC_TEST_CONNECTION") {
        let connection: serde_json::Value =
            serde_json::from_str(&seed).expect("Invalid test connection");
        let url = url::Url::parse(connection["url"].as_str().expect("Missing test URL")).unwrap();
        assert_eq!(
            url.host_str(),
            Some("127.0.0.1"),
            "Test credentials are restricted to loopback"
        );
        keyring::Entry::new(
            &format!("dev.udmc.control.test.{profile}"),
            "admin-connection",
        )
        .unwrap()
        .set_password(&seed)
        .unwrap();
    }
}

pub fn cleanup() {
    if let Some(profile) = name() {
        for key in [
            "admin-connection",
            "access-device",
            "pending-access",
            "rcon-password",
            "curseforge-api-key",
            "translator-key",
        ] {
            if let Ok(entry) = keyring::Entry::new(&format!("dev.udmc.control.test.{profile}"), key)
            {
                let _ = entry.delete_credential();
            }
        }
    }
}
