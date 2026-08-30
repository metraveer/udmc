package dev.udmc.sync;

import com.electronwill.nightconfig.core.UnmodifiableConfig;
import com.electronwill.nightconfig.toml.TomlParser;
import com.google.gson.JsonParser;
import dev.udmc.sync.ModMetadata.Dependency;
import dev.udmc.sync.ModMetadata.Mod;
import org.apache.maven.artifact.versioning.DefaultArtifactVersion;
import org.apache.maven.artifact.versioning.VersionRange;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.jar.Manifest;
import java.util.zip.ZipFile;

final class NeoForgeMetadata {
    private static final String METADATA = "META-INF/neoforge.mods.toml";
    private static final int LIMIT = 256 * 1024;
    private static final long NESTED_LIMIT = 128L * 1024 * 1024;
    private static final Set<String> RESERVED = Set.of("minecraft", "java", "neoforge", "forge", "fabricloader", "udmc_sync");

    static List<Mod> read(Path jar, String display) throws IOException {
        List<Mod> result = new ArrayList<>();
        readJar(jar, display, false, 0, new long[]{0}, new int[]{0}, result);
        if (result.isEmpty()) throw new IOException("No NeoForge mods: " + display);
        return result;
    }

    private static byte[] readEntry(ZipFile zip, String name) throws IOException {
        var entry = zip.getEntry(name);
        if (entry == null || entry.isDirectory()) throw new IOException("Missing " + name);
        try (var input = zip.getInputStream(entry)) {
            byte[] bytes = input.readNBytes(LIMIT + 1);
            if (bytes.length > LIMIT) throw new IOException("Metadata is too large: " + name);
            return bytes;
        }
    }

    private static String text(UnmodifiableConfig config, String key, String fallback) throws IOException {
        Object value = config.get(key);
        if (value == null && fallback != null) return fallback;
        if (!(value instanceof String string) || string.isBlank() || string.length() > 1024) throw new IOException("Invalid metadata field: " + key);
        return string;
    }

    private static List<UnmodifiableConfig> tables(UnmodifiableConfig config, List<String> path) throws IOException {
        Object value = config.get(path);
        if (value == null) return List.of();
        if (!(value instanceof List<?> list) || list.size() > 512) throw new IOException("Invalid metadata tables: " + path);
        List<UnmodifiableConfig> result = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof UnmodifiableConfig table)) throw new IOException("Invalid metadata table: " + path);
            result.add(table);
        }
        return result;
    }

    private static UnmodifiableConfig metadata(ZipFile zip) throws IOException {
        try { return new TomlParser().parse(new String(readEntry(zip, METADATA), StandardCharsets.UTF_8)); }
        catch (RuntimeException e) { throw new IOException("Invalid NeoForge TOML", e); }
    }

    static boolean isAgent(ZipFile zip) throws IOException {
        if (zip.getEntry(METADATA) == null) return false;
        for (var mod : tables(metadata(zip), List.of("mods"))) if ("udmc_sync".equals(text(mod, "modId", ""))) return true;
        return false;
    }

    static String validateAgent(ZipFile zip, UdmcConfig config) throws IOException {
        var value = metadata(zip);
        var mods = tables(value, List.of("mods"));
        if (mods.size() != 1 || !UdmcSync.MOD_ID.equals(text(mods.getFirst(), "modId", ""))
            || zip.getEntry("META-INF/jarjar/metadata.json") != null || !"javafml".equals(text(value, "modLoader", ""))) throw new IOException("Unexpected NeoForge agent metadata");
        if (!matches(config.languageLoaderVersion, List.of(text(value, "loaderVersion", null)))) throw new IOException("Agent requires another FML version");
        var builtins = java.util.Map.of("minecraft", config.minecraftVersion, "neoforge", config.loaderVersion, "java", Integer.toString(Runtime.version().feature()));
        for (var dependency : tables(value, List.of("dependencies", UdmcSync.MOD_ID))) {
            String id = text(dependency, "modId", null);
            if (!builtins.containsKey(id) || !matches(builtins.get(id), List.of(text(dependency, "versionRange", null)))) throw new IOException("Agent dependency is not satisfied: " + id);
        }
        return text(mods.getFirst(), "version", null);
    }

    private static void readJar(Path jar, String display, boolean nested, int depth, long[] expanded, int[] count, List<Mod> result) throws IOException {
        if (depth > 8 || ++count[0] > 512 || result.size() >= 512) throw new IOException("Too many embedded mods: " + display);
        try (ZipFile zip = new ZipFile(jar.toFile())) {
            if (zip.getEntry("udmc-bootstrap.json") != null) throw new IOException("UDMC agent must not be part of a modpack: " + display);
            var entries = zip.entries();
            Set<String> names = new HashSet<>();
            while (entries.hasMoreElements()) {
                String name = entries.nextElement().getName();
                if (!names.add(name)) throw new IOException("Duplicate ZIP entry: " + name);
                if (names.size() > 100000) throw new IOException("Too many ZIP entries: " + display);
            }
            if (zip.getEntry(METADATA) != null) {
                var config = metadata(zip);
                String language = text(config, "modLoader", null);
                if (!Set.of("javafml", "lowcodefml").contains(language)) throw new IOException("UDMC cannot yet validate language loader: " + language);
                String loaderRange = text(config, "loaderVersion", null);
                validateRange(loaderRange);
                var mods = tables(config, List.of("mods"));
                if (mods.isEmpty()) throw new IOException("Empty NeoForge mod list: " + display);
                Set<String> ids = new HashSet<>();
                for (var mod : mods) {
                    String id = text(mod, "modId", null);
                    if (!id.matches("[a-z][a-z0-9_]{1,63}") || RESERVED.contains(id) || !ids.add(id)) throw new IOException("Invalid, duplicate or reserved mod ID: " + id);
                    String version = text(mod, "version", "1");
                    if (version.equals("${file.jarVersion}")) {
                        version = new Manifest(new ByteArrayInputStream(readEntry(zip, "META-INF/MANIFEST.MF"))).getMainAttributes().getValue("Implementation-Version");
                    }
                    if (version == null || version.isBlank() || version.length() > 256 || version.contains("${")) throw new IOException("Cannot resolve mod version: " + id);
                    List<Dependency> dependencies = new ArrayList<>();
                    dependencies.add(new Dependency("@fml", List.of(loaderRange), "*", "required"));
                    for (var dep : tables(config, List.of("dependencies", id))) {
                        String dependencyId = text(dep, "modId", null);
                        if (!dependencyId.matches("[a-z][a-z0-9_]{1,63}")) throw new IOException("Invalid dependency ID: " + dependencyId);
                        String type = text(dep, "type", "required").toLowerCase(Locale.ROOT);
                        if (!Set.of("required", "optional", "incompatible", "discouraged").contains(type)) throw new IOException("Unknown dependency type: " + type);
                        String side = text(dep, "side", "BOTH").toLowerCase(Locale.ROOT);
                        if (!Set.of("both", "client", "server").contains(side)) throw new IOException("Unknown dependency side: " + side);
                        String ordering = text(dep, "ordering", "NONE").toUpperCase(Locale.ROOT);
                        if (!Set.of("NONE", "BEFORE", "AFTER").contains(ordering)) throw new IOException("Unknown dependency ordering: " + ordering);
                        if (!ordering.equals("NONE")) dependencies.add(new Dependency(dependencyId, List.of("[0,)"), side.equals("both") ? "*" : side, ordering.toLowerCase(Locale.ROOT)));
                        String range = text(dep, "versionRange", "[0,)");
                        validateRange(range);
                        dependencies.add(new Dependency(dependencyId, List.of(range), side.equals("both") ? "*" : side, type));
                    }
                    result.add(new Mod(display, id, version, "*", nested, List.of(), List.copyOf(dependencies)));
                    if (result.size() > 512) throw new IOException("Too many mods: " + display);
                }
            } else if (!nested) {
                throw new IOException("No NeoForge metadata (" + METADATA + "): " + display);
            }
            if (zip.getEntry("META-INF/jarjar/metadata.json") != null) {
                var metadata = JsonParser.parseString(new String(readEntry(zip, "META-INF/jarjar/metadata.json"), StandardCharsets.UTF_8)).getAsJsonObject();
                var jars = metadata.getAsJsonArray("jars");
                if (jars == null || jars.size() > 512) throw new IOException("Invalid Jar-in-Jar metadata: " + display);
                for (var element : jars) {
                    var child = element.getAsJsonObject();
                    String name = child.get("path").getAsString();
                    if (!name.startsWith("META-INF/jarjar/") || name.contains("\\") || List.of(name.split("/")).contains("..")) throw new IOException("Unsafe embedded JAR path: " + name);
                    var version = child.getAsJsonObject("version");
                    String range = version.get("range").getAsString();
                    String artifact = version.get("artifactVersion").getAsString();
                    if (!matches(artifact, List.of(range))) throw new IOException("Embedded library outside declared range: " + name);
                    var identifier = child.getAsJsonObject("identifier");
                    String libraryId = "@jar:" + identifier.get("group").getAsString() + ":" + identifier.get("artifact").getAsString();
                    // Track library constraints even when the nested JAR is not itself a mod.
                    result.add(new Mod(display, libraryId, artifact, "*", true, List.of(),
                        List.of(new Dependency(libraryId, List.of(range), "*", "embedded"))));
                    var entry = zip.getEntry(name);
                    if (entry == null || entry.isDirectory()) throw new IOException("Missing embedded JAR: " + name);
                    Path temporary = Files.createTempFile("udmc-neoforge-metadata-", ".jar");
                    try {
                        try (var input = zip.getInputStream(entry); var output = Files.newOutputStream(temporary)) {
                            byte[] buffer = new byte[65536]; int size;
                            while ((size = input.read(buffer)) != -1) {
                                expanded[0] += size;
                                if (expanded[0] > NESTED_LIMIT) throw new IOException("Embedded JARs exceed inspection limit");
                                output.write(buffer, 0, size);
                            }
                        }
                        readJar(temporary, display, true, depth + 1, expanded, count, result);
                    } finally { Files.deleteIfExists(temporary); }
                }
            }
        } catch (IOException e) { throw e; }
        catch (RuntimeException e) { throw new IOException("Invalid NeoForge metadata: " + display + ": " + e.getMessage(), e); }
    }

    private static VersionRange validateRange(String value) throws IOException {
        if (value.length() > 1024 || value.isBlank()) throw new IOException("Invalid Maven version range");
        try { return VersionRange.createFromVersionSpec(value); }
        catch (Exception e) { throw new IOException("Invalid Maven version range: " + value, e); }
    }

    static boolean matches(String version, List<String> predicates) throws IOException {
        for (String predicate : predicates) {
            var range = validateRange(predicate);
            // A bare Maven version is a recommendation, not an exact restriction.
            if (!range.hasRestrictions() || range.containsVersion(new DefaultArtifactVersion(version))) return true;
        }
        return false;
    }
}
