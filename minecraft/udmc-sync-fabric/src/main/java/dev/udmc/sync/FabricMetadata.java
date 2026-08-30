package dev.udmc.sync;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.Version;
import net.fabricmc.loader.api.metadata.version.VersionPredicate;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipFile;
import dev.udmc.sync.ModMetadata.Mod;

/** Reads metadata only; downloaded classes are never loaded by the checker. */
final class FabricMetadata {
    private static final int METADATA_LIMIT = 256 * 1024;
    private static final long NESTED_LIMIT = 128L * 1024 * 1024;

    static List<Mod> read(Path jar, String displayPath) throws IOException {
        List<Mod> result = new ArrayList<>();
        readJar(jar, displayPath, false, 0, new long[]{0}, result);
        return result;
    }

    private static void readJar(Path jar, String display, boolean nested, int depth, long[] expanded, List<Mod> result) throws IOException {
        if (depth > 8 || result.size() >= 512) throw new IOException("Too many nested mods: " + display);
        try (ZipFile zip = new ZipFile(jar.toFile())) {
            var entry = zip.getEntry("fabric.mod.json");
            if (entry == null) throw new IOException("No fabric.mod.json: " + display);
            if (zip.getEntry("udmc-bootstrap.json") != null) throw new IOException("UDMC agent must not be part of a modpack: " + display);
            byte[] bytes;
            try (var input = zip.getInputStream(entry)) { bytes = input.readNBytes(METADATA_LIMIT + 1); }
            if (bytes.length > METADATA_LIMIT) throw new IOException("Mod metadata is too large: " + display);
            JsonObject json = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
            String id = json.get("id").getAsString();
            String version = json.get("version").getAsString();
            if (!id.matches("[a-z][a-z0-9_-]{1,63}") || version.length() > 256 || "udmc_sync".equals(id)) throw new IOException("Invalid or reserved mod ID: " + display);
            Version.parse(version);
            String environment = json.has("environment") ? json.get("environment").getAsString() : "*";
            if (!List.of("*", "client", "server").contains(environment)) throw new IOException("Unknown mod environment: " + display);
            List<String> provides = new ArrayList<>();
            if (json.has("provides")) for (var alias : json.getAsJsonArray("provides")) provides.add(alias.getAsString());
            for (String reserved : List.of("minecraft", "java", "fabricloader", "udmc_sync")) {
                if (id.equals(reserved) || provides.contains(reserved)) throw new IOException("Reserved mod ID: " + display);
            }
            result.add(new Mod(display, id, version, environment, nested, provides, dependencies(json, "depends"), dependencies(json, "breaks")));
            if (json.has("jars")) for (var child : json.getAsJsonArray("jars")) {
                String name = child.getAsJsonObject().get("file").getAsString();
                var childEntry = zip.getEntry(name);
                if (childEntry == null || childEntry.isDirectory()) throw new IOException("Missing embedded mod: " + display + "!" + name);
                Path temporary = Files.createTempFile("udmc-metadata-", ".jar");
                try {
                    try (var input = zip.getInputStream(childEntry); var output = Files.newOutputStream(temporary)) {
                        byte[] buffer = new byte[65536]; int count;
                        while ((count = input.read(buffer)) != -1) {
                            expanded[0] += count;
                            if (expanded[0] > NESTED_LIMIT) throw new IOException("Embedded mods exceed inspection limit: " + display);
                            output.write(buffer, 0, count);
                        }
                    }
                    readJar(temporary, display, true, depth + 1, expanded, result);
                } finally { Files.deleteIfExists(temporary); }
            }
        } catch (IOException e) { throw e; }
        catch (Exception e) { throw new IOException("Invalid Fabric metadata: " + display + ": " + e.getMessage(), e); }
    }

    private static Map<String, List<String>> dependencies(JsonObject json, String key) {
        Map<String, List<String>> result = new HashMap<>();
        if (!json.has(key)) return result;
        for (var entry : json.getAsJsonObject(key).entrySet()) {
            List<String> predicates = new ArrayList<>();
            if (entry.getValue().isJsonArray()) for (var value : entry.getValue().getAsJsonArray()) predicates.add(value.getAsString());
            else predicates.add(entry.getValue().getAsString());
            result.put(entry.getKey(), predicates);
        }
        return result;
    }

    static boolean matches(String version, List<String> predicates) throws IOException {
        try {
            Version parsed = Version.parse(version);
            for (String predicate : predicates) if (VersionPredicate.parse(predicate).test(parsed)) return true;
            return false;
        } catch (Exception e) { throw new IOException("Unsupported version constraint: " + predicates, e); }
    }

    static boolean isAgent(ZipFile zip) throws IOException {
        var metadata = zip.getEntry("fabric.mod.json");
        if (metadata == null) return false;
        try (var input = zip.getInputStream(metadata)) {
            byte[] body = input.readNBytes(METADATA_LIMIT + 1);
            if (body.length > METADATA_LIMIT) throw new IOException("Mod metadata is too large");
            var json = JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
            return json.has("id") && "udmc_sync".equals(json.get("id").getAsString());
        } catch (RuntimeException e) { throw new IOException("Invalid Fabric metadata", e); }
    }

    static String validateAgent(ZipFile zip, UdmcConfig config, boolean client) throws IOException {
        try (var input = zip.getInputStream(zip.getEntry("fabric.mod.json"))) {
            byte[] bytes = input.readNBytes(METADATA_LIMIT + 1);
            if (bytes.length > METADATA_LIMIT) throw new IOException("Agent metadata is too large");
            var json = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
            String side = json.get("environment").getAsString();
            if (!UdmcSync.MOD_ID.equals(json.get("id").getAsString()) || json.has("provides")
                || !(side.equals("*") || side.equals(client ? "client" : "server"))) throw new IOException("Unexpected agent metadata");
            var mod = new Mod("UDMC agent", UdmcSync.MOD_ID, json.get("version").getAsString(), side, false, List.of(), dependencies(json, "depends"), dependencies(json, "breaks"));
            var mods = new ArrayList<Mod>();
            mods.add(mod);
            mods.addAll(agentModules(zip, json, config));
            var problems = ModMetadata.problems(mods, client ? "client" : "server", config);
            if (!problems.isEmpty()) throw new IOException(String.join("; ", problems));
            return mod.version();
        } catch (RuntimeException error) { throw new IOException("Invalid Fabric agent", error); }
    }

    private static List<Mod> agentModules(ZipFile zip, JsonObject metadata, UdmcConfig config) throws IOException {
        var platform = new java.util.Properties();
        try (var input = zip.getInputStream(zip.getEntry("udmc-platform.properties"))) {
            byte[] bytes = input.readNBytes(METADATA_LIMIT + 1);
            if (bytes.length > METADATA_LIMIT) throw new IOException("Agent platform metadata is too large");
            platform.load(new java.io.ByteArrayInputStream(bytes));
        }
        var declared = JsonParser.parseString(platform.getProperty("bundledMods", "{}")).getAsJsonObject();
        var allowed = List.of("fabric-api-base", config.minecraftVersion.startsWith("1.") ? "fabric-resource-loader-v0" : "fabric-resource-loader-v1");
        if (!allowed.containsAll(declared.keySet()) || declared.size() > 2) throw new IOException("Unexpected bundled agent modules");
        var jars = metadata.has("jars") ? metadata.getAsJsonArray("jars") : new com.google.gson.JsonArray();
        if (jars.size() != declared.size()) throw new IOException("Bundled agent modules do not match their declaration");
        List<Mod> result = new ArrayList<>();
        var seen = new java.util.HashSet<String>();
        for (var reference : jars) {
            String name = reference.getAsJsonObject().get("file").getAsString();
            if (!name.matches("META-INF/jars/[a-zA-Z0-9+_.-]+\\.jar")) throw new IOException("Invalid bundled agent module path");
            var entry = zip.getEntry(name);
            if (entry == null || entry.isDirectory()) throw new IOException("Missing bundled agent module");
            Path temporary = Files.createTempFile("udmc-agent-module-", ".jar");
            try {
                try (var input = zip.getInputStream(entry); var output = Files.newOutputStream(temporary)) {
                    byte[] buffer = new byte[65536]; int count; long size = 0;
                    while ((count = input.read(buffer)) != -1) {
                        size += count;
                        if (size > AgentPackages.MAX_BYTES) throw new IOException("Bundled agent module is too large");
                        output.write(buffer, 0, count);
                    }
                }
                var modules = read(temporary, name);
                if (modules.size() != 1) throw new IOException("Unexpected nested agent module");
                var module = modules.getFirst();
                if (!declared.has(module.id()) || !seen.add(module.id()) || !module.provides().isEmpty()
                    || !module.version().equals(declared.get(module.id()).getAsString())) throw new IOException("Bundled agent module identity or version mismatch");
                result.add(module);
            } finally { Files.deleteIfExists(temporary); }
        }
        return result;
    }
}
