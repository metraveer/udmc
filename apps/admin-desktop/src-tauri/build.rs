fn main() {
    println!("cargo:rerun-if-changed=agent-templates");
    let mut source = String::from("pub static TEMPLATES: &[Template] = &[\n");
    if let Ok(catalog) = std::fs::read_to_string("agent-templates/catalog.json") {
        let catalog: serde_json::Value =
            serde_json::from_str(&catalog).expect("invalid agent catalog");
        assert_eq!(
            catalog["version"].as_str().unwrap(),
            std::env::var("CARGO_PKG_VERSION").unwrap(),
            "Rebuild agents for this app version"
        );
        for item in catalog["templates"].as_array().unwrap() {
            let id = item["id"].as_str().unwrap();
            let mc = item["minecraft"].as_str().unwrap();
            let loader = item["loaderVersion"].as_str().unwrap();
            let loader_type = item["loader"].as_str().unwrap();
            assert!(
                ["fabric", "neoforge"].contains(&loader_type),
                "Unsupported agent loader"
            );
            let java = item["java"].as_u64().unwrap();
            source.push_str(&format!("Template {{ id: {id:?}, minecraft: {mc:?}, loader: {loader_type:?}, loader_version: {loader:?}, java: {java}, bytes: include_bytes!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/agent-templates/{id}.jar\")) }},\n"));
        }
    } else if std::env::var("PROFILE").unwrap() == "release" {
        panic!("Run npm run minecraft:build before building the installer");
    }
    source.push_str("];\n");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    std::fs::write(out.join("agent_templates.rs"), source).unwrap();
    tauri_build::build();
}
