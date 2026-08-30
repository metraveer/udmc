package dev.udmc.sync;

import java.io.IOException;
import java.util.Properties;

final class PlatformDefaults {
    private static final Properties VALUES = load();
    private static Properties load() {
        Properties values = new Properties();
        try (var input = PlatformDefaults.class.getResourceAsStream("/udmc-platform.properties")) {
            if (input == null) throw new IOException("Missing compiled platform metadata");
            values.load(input);
            return values;
        } catch (IOException e) { throw new ExceptionInInitializerError(e); }
    }
    static String get(String name) { return VALUES.getProperty(name); }
    static java.util.Map<String, String> bundledMods() {
        return new com.google.gson.Gson().fromJson(VALUES.getProperty("bundledMods", "{}"),
            new com.google.gson.reflect.TypeToken<java.util.Map<String, String>>() {}.getType());
    }
}
