#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
mod curseforge;
mod generator;
mod github;
mod modrinth;
mod native_error;
mod rcon;
mod startup;
#[cfg(debug_assertions)]
mod test_profile;
mod translator;

fn credential_service(base: &str) -> String {
    #[cfg(debug_assertions)]
    if let Some(profile) = test_profile::name() {
        return format!("{base}.test.{profile}");
    }
    base.to_owned()
}

fn main() {
    let context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    let context = {
        let mut context = context;
        test_profile::configure(&mut context);
        context
    };
    let startup_lock =
        startup::lock(&context.config().identifier).expect("Cannot acquire the UDMC startup lock");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |_| {
            drop(startup_lock);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            curseforge::curseforge_search,
            curseforge::curseforge_files,
            curseforge::curseforge_download,
            github::github_releases,
            github::github_download,
            modrinth::modrinth_get,
            modrinth::open_catalog_link,
            modrinth::modrinth_download,
            rcon::rcon_execute,
            translator::translate_texts,
            generator::generator_catalog,
            generator::save_agent,
            generator::prepare_agent_package,
            generator::credential_read,
            generator::credential_write,
            generator::device_name,
            generator::dependency_status,
            generator::open_dependency
        ])
        .run(context)
        .expect("failed to run UDMC Control");
    #[cfg(debug_assertions)]
    test_profile::cleanup();
}
