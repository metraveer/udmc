package dev.udmc.sync;

import com.google.gson.JsonObject;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

final class TestMods {
    static String atLeast(String version) { return LoaderPlatform.TYPE.equals("neoforge") ? "[" + version + ",)" : ">=" + version; }
    static String range(String lower, String upper) { return LoaderPlatform.TYPE.equals("neoforge") ? "[" + lower + "," + upper + ")" : ">=" + lower + " <" + upper; }
    static byte[] jar(String id, String version) throws Exception { return jar(id, version, new JsonObject(), new JsonObject()); }
    static byte[] jar(String id, String version, JsonObject depends, JsonObject breaks) throws Exception {
        JsonObject metadata = new JsonObject();
        metadata.addProperty("schemaVersion", 1); metadata.addProperty("id", id); metadata.addProperty("version", version);
        metadata.add("depends", depends); metadata.add("breaks", breaks);
        String text = metadata.toString();
        String name = "fabric.mod.json";
        if (LoaderPlatform.TYPE.equals("neoforge")) {
            name = "META-INF/neoforge.mods.toml";
            StringBuilder toml = new StringBuilder("modLoader=\"javafml\"\nloaderVersion=\"[4,)\"\nlicense=\"test\"\n[[mods]]\nmodId=\"" + id + "\"\nversion=\"" + version + "\"\n");
            for (var map : java.util.List.of(depends, breaks)) for (var entry : map.entrySet()) {
                toml.append("[[dependencies.").append(id).append("]]\nmodId=\"").append(entry.getKey())
                    .append("\"\ntype=\"").append(map == depends ? "required" : "incompatible")
                    .append("\"\nversionRange=").append(entry.getValue()).append('\n');
            }
            text = toml.toString();
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            ZipEntry entry = new ZipEntry(name); entry.setTime(0);
            zip.putNextEntry(entry); zip.write(text.getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
        }
        return bytes.toByteArray();
    }
}
