package dev.udmc.sync;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

public final class FabricAgentPackageTest {
    public static void main(String[] args) throws Exception {
        var template = Path.of(args[0]);
        var config = new UdmcConfig();
        var root = Files.createTempDirectory("udmc-fabric-package-");
        try {
            // The very same file on both sides: that is the whole point of one mod for everybody.
            AgentPackages.validate(template, config, false);
            AgentPackages.validate(template, config, true);
            // A file with settings baked in is one from before that, and those carried secrets.
            var baked = new LinkedHashMap<String, Object>(Map.of("packId", "udmc-main", "bootstrapId", "a".repeat(64)));
            rejects(copy(template, root.resolve("personalised.jar"), Map.of("udmc-bootstrap.json", new Gson().toJson(baked).getBytes(StandardCharsets.UTF_8))), config);
            JsonObject metadata;
            Properties platform = new Properties();
            try (var zip = new ZipFile(template.toFile())) {
                try (var input = zip.getInputStream(zip.getEntry("fabric.mod.json"))) { metadata = JsonParser.parseString(new String(input.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject(); }
                try (var input = zip.getInputStream(zip.getEntry("udmc-platform.properties"))) { platform.load(input); }
            }
            var original = metadata.deepCopy();
            metadata.remove("jars");
            rejects(copy(template, root.resolve("undeclared.jar"), Map.of("fabric.mod.json", json(metadata))), config);
            metadata = original.deepCopy();
            metadata.getAsJsonArray("jars").get(0).getAsJsonObject().addProperty("file", "META-INF/jars/missing.jar");
            rejects(copy(template, root.resolve("missing.jar"), Map.of("fabric.mod.json", json(metadata))), config);
            metadata.getAsJsonArray("jars").get(0).getAsJsonObject().addProperty("file", "../../outside.jar");
            rejects(copy(template, root.resolve("path.jar"), Map.of("fabric.mod.json", json(metadata))), config);
            metadata = original.deepCopy();
            metadata.getAsJsonArray("jars").set(1, metadata.getAsJsonArray("jars").get(0).deepCopy());
            rejects(copy(template, root.resolve("duplicate.jar"), Map.of("fabric.mod.json", json(metadata))), config);
            var modules = JsonParser.parseString(platform.getProperty("bundledMods")).getAsJsonObject();
            modules.addProperty("fabric-api-base", "999.0.0");
            platform.setProperty("bundledMods", modules.toString());
            rejects(copy(template, root.resolve("version.jar"), Map.of("udmc-platform.properties", dev.udmc.sync.update.AgentUpdateHelper.bytes(platform))), config);
            modules.remove("fabric-api-base"); modules.addProperty("unexpected_mod", "1.0.0");
            platform.setProperty("bundledMods", modules.toString());
            rejects(copy(template, root.resolve("extra.jar"), Map.of("udmc-platform.properties", dev.udmc.sync.update.AgentUpdateHelper.bytes(platform))), config);
            System.out.println("Fabric packaged agents passed: real server/client JARs, bundled resources, missing/duplicate/undeclared modules, version mismatch and paths.");
        } finally {
            try (var paths = Files.walk(root)) { for (var file : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(file); }
        }
    }

    private static byte[] json(JsonObject value) { return value.toString().getBytes(StandardCharsets.UTF_8); }
    private static void rejects(Path path, UdmcConfig config) throws Exception {
        // Both shapes of refusal count: malformed metadata reads as an IOException, while a
        // rule with something to tell the administrator carries a code and an explanation.
        try { AgentPackages.validate(path, config, false); }
        catch (IOException | ApiException expected) { return; }
        throw new AssertionError("Invalid agent accepted: " + path.getFileName());
    }
    private static Path copy(Path source, Path target, Map<String, byte[]> changes) throws IOException {
        try (var zip = new ZipFile(source.toFile()); var output = new ZipOutputStream(Files.newOutputStream(target))) {
            var entries = zip.entries();
            while (entries.hasMoreElements()) {
                var entry = entries.nextElement();
                if (entry.isDirectory() || changes.containsKey(entry.getName())) continue;
                output.putNextEntry(new ZipEntry(entry.getName()));
                try (var input = zip.getInputStream(entry)) { input.transferTo(output); }
                output.closeEntry();
            }
            for (var entry : changes.entrySet()) {
                output.putNextEntry(new ZipEntry(entry.getKey())); output.write(entry.getValue()); output.closeEntry();
            }
        }
        return target;
    }
}
