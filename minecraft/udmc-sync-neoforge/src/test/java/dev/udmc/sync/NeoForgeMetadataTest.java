package dev.udmc.sync;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public final class NeoForgeMetadataTest {
    private static final String HEADER = "modLoader=\"javafml\"\nloaderVersion=\"[4,)\"\nlicense=\"test\"\n";
    private static final String TOML = "META-INF/neoforge.mods.toml";
    private static int assertions;

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("udmc-neo-metadata-");
        try {
            UdmcConfig config = new UdmcConfig();
            check(config.loaderType.equals("neoforge") && config.minecraftVersion.equals("1.21.1"), "Compiled defaults identify NeoForge");
            var basic = read(root, "basic", HEADER + mod("example", "1.2.3"));
            check(ModMetadata.problems(basic, "client", config).isEmpty(), "Simple NeoForge mod is valid");
            check(ModMetadata.matches("2.1.0", List.of("[2,3)")), "Maven range includes version");
            check(!ModMetadata.matches("3.0", List.of("[2,3)")), "Exclusive upper bound");
            check(ModMetadata.matches("1.2.3", List.of("[1.2.3]")), "Exact Maven match");
            check(!ModMetadata.matches("1.2.4", List.of("[1.2.3]")), "Exact Maven mismatch");
            fails(() -> ModMetadata.matches("1", List.of("[2,1)")));

            String needs = HEADER + mod("example", "1") + dep("example", "library", "required", "[2,3)", "CLIENT", "NONE");
            var required = read(root, "required", needs);
            check(!ModMetadata.problems(required, "client", config).isEmpty(), "Client dependency missing");
            check(ModMetadata.problems(required, "server", config).isEmpty(), "Client dependency does not block server");
            List<ModMetadata.Mod> combined = new ArrayList<>(required);
            combined.addAll(read(root, "library", HEADER + mod("library", "2.1")));
            check(ModMetadata.problems(combined, "client", config).isEmpty(), "Required dependency resolved");
            var optional = read(root, "optional", needs.replace("type=\"required\"", "type=\"optional\""));
            check(ModMetadata.problems(optional, "client", config).isEmpty(), "Missing optional dependency allowed");
            combined = new ArrayList<>(optional);
            combined.addAll(read(root, "old-library", HEADER + mod("library", "1")));
            check(!ModMetadata.problems(combined, "client", config).isEmpty(), "Installed incompatible optional dependency rejected");
            var incompatible = read(root, "incompatible", HEADER + mod("example", "1") + dep("example", "neoforge", "incompatible", "[21,22)", "BOTH", "NONE"));
            check(!ModMetadata.problems(incompatible, "server", config).isEmpty(), "Builtin incompatibility checked");
            var futureFml = read(root, "future-fml", (HEADER + mod("example", "1")).replace("[4,)", "[99,)"));
            check(!ModMetadata.problems(futureFml, "client", config).isEmpty(), "FML range checked separately from NeoForge version");
            fails(() -> read(root, "unknown-language", (HEADER + mod("example", "1")).replace("javafml", "unknownfml")));
            fails(() -> read(root, "invalid", "[[mods"));
            fails(() -> read(root, "duplicate-id", HEADER + mod("example", "1") + mod("example", "2")));
            fails(() -> read(root, "bad-side", needs.replace("CLIENT", "UNKNOWN")));
            fails(() -> read(root, "unknown-version", HEADER + mod("example", "${unknown}")));
            Path fabric = root.resolve("fabric.jar"); Files.write(fabric, archive(Map.of("fabric.mod.json", "{}".getBytes(StandardCharsets.UTF_8))));
            fails(() -> ModMetadata.read(fabric, "mods/fabric.jar"));
            Path agent = root.resolve("agent.jar"); Files.write(agent, jar(HEADER + mod("udmc_sync", "1"), Map.of()));
            check(AgentFiles.isAgent(agent), "Recognize renamed NeoForge agent without bootstrap");
            fails(() -> ModMetadata.read(agent, "mods/agent.jar"));

            Path manifest = root.resolve("manifest.jar");
            Files.write(manifest, jar(HEADER + mod("example", "${file.jarVersion}"), Map.of("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\nImplementation-Version: 3.2.1\r\n\r\n".getBytes(StandardCharsets.UTF_8))));
            check(ModMetadata.read(manifest, "mods/manifest.jar").getFirst().version().equals("3.2.1"), "Manifest version expanded");

            var cycle = read(root, "order", HEADER + mod("first", "1") + mod("second", "1")
                + dep("first", "second", "required", "[1,)", "BOTH", "AFTER") + dep("second", "first", "required", "[1,)", "BOTH", "AFTER"));
            check(ModMetadata.diagnostics(cycle, "client", config).stream().anyMatch(p -> p.detail().key().equals("udmc_sync.diagnostic.cycle")), "Ordering cycle rejected");
            Path bundle = root.resolve("bundle.jar");
            byte[] bytes = jar(HEADER + mod("first", "1") + mod("second", "1"), Map.of());
            Files.write(bundle, bytes);
            Path game = root.resolve("game"); Files.createDirectories(game.resolve("mods"));
            Files.write(game.resolve("mods/personal.jar"), jar(HEADER + mod("second", "0.5"), Map.of()));
            var wanted = new ManifestModels.ManifestFile(); wanted.path = "mods/bundle.jar"; wanted.side = "both"; wanted.sha256 = Hashes.sha256(bytes); wanted.size = bytes.length;
            try {
                ClientModCheck.check(game, config, new HashMap<>(Map.of(wanted.path, wanted)), new HashMap<>(Map.of(game.resolve(wanted.path), bundle)), Map.of());
                throw new AssertionError("Second root mod conflict was ignored");
            } catch (ClientModCheck.Conflicts e) { check(e.files.stream().anyMatch(f -> f.path().equals("mods/personal.jar")), "All root IDs participate in personal conflicts"); }
            check(Files.exists(game.resolve("mods/personal.jar")) && !Files.exists(game.resolve(wanted.path)), "Preflight leaves files untouched");

            Path nested = root.resolve("nested.jar");
            byte[] library = jar(HEADER + mod("nestedlib", "2"), Map.of());
            Files.write(nested, embedded("nestedroot", "[2,3)", "2", library));
            var nestedMods = ModMetadata.read(nested, "mods/nested.jar");
            check(nestedMods.stream().anyMatch(m -> m.id().equals("nestedlib") && m.nested()), "Embedded mod inspected");
            check(ModMetadata.problems(nestedMods, "client", config).isEmpty(), "Embedded library constraints satisfied");
            combined = new ArrayList<>(nestedMods);
            combined.addAll(read(root, "external-nestedlib", HEADER + mod("nestedlib", "3")));
            check(ModMetadata.diagnostics(combined, "client", config).stream().anyMatch(p -> p.detail().key().equals("udmc_sync.diagnostic.nested_versions")), "Ambiguous nested mod versions require manual inspection");
            Path second = root.resolve("nested-second.jar"); Files.write(second, embedded("otherroot", "[3,4)", "3", archive(Map.of("README.txt", new byte[0]))));
            combined = new ArrayList<>(nestedMods); combined.addAll(ModMetadata.read(second, "mods/second.jar"));
            check(ModMetadata.diagnostics(combined, "client", config).stream().anyMatch(p -> p.detail().key().equals("udmc_sync.diagnostic.embedded")), "Unresolvable Jar-in-Jar constraints rejected");
            Files.write(second, embedded("otherroot", "[3,4)", "2", library));
            fails(() -> ModMetadata.read(second, "mods/second.jar"));
            System.out.println("NeoForge metadata checks passed: " + assertions + " assertions.");
        } finally { TestMods.deleteTree(root); }
    }

    private static List<ModMetadata.Mod> read(Path root, String name, String metadata) throws Exception {
        Path file = root.resolve(name + ".jar"); Files.write(file, jar(metadata, Map.of())); return ModMetadata.read(file, "mods/" + name + ".jar");
    }
    private static String mod(String id, String version) { return "[[mods]]\nmodId=\"" + id + "\"\nversion=\"" + version + "\"\n"; }
    private static String dep(String owner, String id, String type, String range, String side, String order) {
        return "[[dependencies." + owner + "]]\nmodId=\"" + id + "\"\ntype=\"" + type + "\"\nversionRange=\"" + range + "\"\nside=\"" + side + "\"\nordering=\"" + order + "\"\n";
    }
    private static byte[] embedded(String root, String range, String version, byte[] library) throws Exception {
        String metadata = "{\"jars\":[{\"identifier\":{\"group\":\"test\",\"artifact\":\"library\"},\"version\":{\"range\":\"" + range + "\",\"artifactVersion\":\"" + version + "\"},\"path\":\"META-INF/jarjar/library.jar\"}]}";
        return jar(HEADER + mod(root, "1"), Map.of("META-INF/jarjar/metadata.json", metadata.getBytes(StandardCharsets.UTF_8), "META-INF/jarjar/library.jar", library));
    }
    private static byte[] jar(String metadata, Map<String, byte[]> extras) throws Exception {
        Map<String, byte[]> entries = new HashMap<>(extras); entries.put(TOML, metadata.getBytes(StandardCharsets.UTF_8)); return archive(entries);
    }
    private static byte[] archive(Map<String, byte[]> entries) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) { for (var entry : entries.entrySet()) { zip.putNextEntry(new ZipEntry(entry.getKey())); zip.write(entry.getValue()); zip.closeEntry(); } }
        return bytes.toByteArray();
    }
    private static void check(boolean condition, String message) { assertions++; if (!condition) throw new AssertionError(message); }
    private static void fails(Checked action) throws Exception { assertions++; try { action.run(); } catch (IOException expected) { return; } throw new AssertionError("Expected metadata rejection"); }
    private interface Checked { void run() throws Exception; }
}
