package dev.udmc.sync;

import com.google.gson.Gson;
import com.google.gson.JsonParser;
import com.google.gson.reflect.TypeToken;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;
import net.minecraft.network.chat.contents.TranslatableContents;

public final class LocalizationTest {
    public static void main(String[] args) throws Exception {
        var en = language("en_us");
        var ru = language("ru_ru");
        check(en.keySet().equals(ru.keySet()) && en.size() > 60, "Language resources are incomplete");
        var parameter = Pattern.compile("%(\\d+)\\$s");
        for (String key : en.keySet()) {
            var indices = parameter.matcher(en.get(key)).results().map(match -> match.group(1)).sorted().toList();
            check(indices.equals(parameter.matcher(ru.get(key)).results().map(match -> match.group(1)).sorted().toList()), "Different translation parameters: " + key);
            check(!en.get(key).isBlank() && !ru.get(key).isBlank(), "Empty translation: " + key);
            var values = new String[]{"mods/{0}%s<test>.jar", "MOD", "LIBRARY", "[2.0,3.0)"};
            check(!String.format(Locale.ROOT, en.get(key), (Object[]) values).isBlank(), "Invalid English format");
            check(!String.format(Locale.ROOT, ru.get(key), (Object[]) values).isBlank(), "Invalid Russian format");
        }
        var message = Messages.of("udmc_sync.diagnostic.required", "mods/{0}%s<test>.jar", "MOD", "LIBRARY", "[2.0,3.0)");
        check(message.english().contains("mods/{0}%s<test>.jar"), "Parameters were interpreted as a translation format");
        var component = UdmcClientUi.component(message);
        check(component.getContents() instanceof TranslatableContents contents && contents.getKey().equals(message.key()), "Game screen must use Minecraft translations, not a preformatted literal");
        var login = AgentLoginNotice.component(new AgentLoginProtocol.Decision(false, true, "udmc_sync.login.missing",
            en.get("udmc_sync.login.missing"), List.of(), "https://127.0.0.1/udmc", "0.17.1", "0.17.0", "udmc-main", "0.16.2", "another-pack"));
        // The notice has to carry the three numbers an administrator compares, or the only
        // way to tell a stale client from a foreign one is to open files on someone's PC.
        String rendered = login.getString();
        for (var fragment : List.of("0.17.1", "0.17.0", "udmc-main", "0.16.2", "another-pack")) {
            check(rendered.contains(fragment), "Login notice must state " + fragment + ": " + rendered);
        }
        check(login.getContents() instanceof TranslatableContents contents && contents.getKey().equals("udmc_sync.login.notice"), "Login notice must use a Minecraft translation with a clean-client fallback");
        // A client that belongs to this project repairs itself at the next launch: telling
        // that player to download a file sends them to do by hand what already happens.
        for (var healing : List.of("udmc_sync.login.outdated")) {
            var advice = AgentLoginNotice.component(new AgentLoginProtocol.Decision(false, true, healing,
                en.get(healing), List.of("0.17.1", "0.17.0"), "https://127.0.0.1/udmc", "0.17.1", "0.17.1", "udmc-main", "0.17.0", "udmc-main"));
            check(((TranslatableContents) advice.getContents()).getKey().equals("udmc_sync.login.restart"),
                healing + " must ask for a restart, not for a download");
            check(!advice.getString().contains("https://127.0.0.1/udmc"), healing + " must not send the player to download anything");
            for (var word : List.of("Скачайте", "Download", "download")) {
                check(!en.get(healing).contains(word) && !ru.get(healing).contains(word),
                    healing + " states what happened; the advice line says what to do, and they must not contradict");
            }
        }
        // Installed, current, and simply not set up for anything yet: this player already holds
        // the right file. Wrapping the download steps around this reason sent them to fetch the
        // jar they had, and the question they actually needed waited on a screen they had no
        // reason to open - so re-joining turned them away again, for ever.
        var unclaimed = AgentLoginNotice.component(new AgentLoginProtocol.Decision(false, true, "udmc_sync.login.unclaimed",
            en.get("udmc_sync.login.unclaimed"), List.of("udmc-main"), "https://127.0.0.1/udmc", "0.17.1", "0.17.1", "udmc-main", "0.17.1", ""));
        check(((TranslatableContents) unclaimed.getContents()).getKey().equals("udmc_sync.login.unclaimed"),
            "An unclaimed client needs its own advice, not the download steps");
        check(!unclaimed.getString().contains("https://127.0.0.1/udmc"),
            "An unclaimed client already has the file and must not be sent to download it");
        for (var word : List.of("Скачайте", "Download", "download")) {
            check(!en.get("udmc_sync.login.unclaimed").contains(word) && !ru.get("udmc_sync.login.unclaimed").contains(word),
                "Nothing has to be downloaded to accept a project");
        }
        // The instruction has to name the pack being offered and stop there. It once named the
        // button to press - and the button led somewhere else, because the question replaces
        // the screen it was supposed to appear on. A reason that describes the interface is a
        // reason that goes stale the next time the interface moves.
        for (var language : List.of(en, ru)) {
            check(language.get("udmc_sync.login.unclaimed").contains("%1$s"),
                "The reason must name the pack the player is being offered");
        }

        for (var manual : List.of("udmc_sync.login.missing", "udmc_sync.login.foreign")) {
            var advice = AgentLoginNotice.component(new AgentLoginProtocol.Decision(false, true, manual,
                en.get(manual), List.of("udmc-main"), "https://127.0.0.1/udmc", "0.17.1", "0.17.1", "udmc-main", "", ""));
            check(advice.getString().contains("https://127.0.0.1/udmc"), manual + " has no working channel and must give the address");
        }
        // A player without the mod reads only the fallback, on a screen where the link is not
        // clickable: it has to spell out the steps and put the address on a line of its own.
        var fallback = ((TranslatableContents) login.getContents()).getFallback();
        check(fallback != null && fallback.contains("\n%2$s\n"), "The clean-client notice must give the address its own line");
        for (var word : List.of("mods", "browser", "браузере")) {
            check(fallback.contains(word), "The clean-client notice must say what to do: " + word);
        }
        check(message.issue("client").get("args").equals(List.of("mods/{0}%s<test>.jar", "MOD", "LIBRARY", "[2.0,3.0)")), "HTTP parameters changed");
        check(Messages.failure(Messages.error("udmc_sync.error.hash", "mods/test.jar")).key().equals("udmc_sync.error.hash"), "Typed failure lost its translation key");
        var config = new UdmcConfig();
        for (var bundled : PlatformDefaults.bundledMods().entrySet()) {
            var mod = new ModMetadata.Mod("mods/uses-resources.jar", "test_resources", "1.0.0", "*", false, List.of(),
                List.of(new ModMetadata.Dependency(bundled.getKey(), List.of(bundled.getValue()), "*", "required")));
            check(ModMetadata.problems(List.of(mod), "client", config).isEmpty(), "Bundled module was incorrectly reported as missing");
            var explicit = new ModMetadata.Mod("mods/explicit.jar", bundled.getKey(), "999.0.0", "*", false, List.of(), List.of());
            check(!ModMetadata.problems(List.of(mod, explicit), "client", config).isEmpty(), "Bundled fallback hid an incompatible explicit module");
        }
        check(args.length == 1, "Pass the packaged agent JAR to verify bundled resources");
        checkPackagedResources(args[0]);
        System.out.println("Localization checks passed: " + en.size() + " RU/EN messages, parameters, Minecraft components, HTTP diagnostics and packaged resources.");
    }

    private static void checkPackagedResources(String file) throws Exception {
        try (var jar = new ZipFile(file)) {
            for (String locale : List.of("en_us", "ru_ru")) {
                var entry = jar.getEntry("assets/udmc_sync/lang/" + locale + ".json");
                check(entry != null, "Packaged agent is missing " + locale);
                try (var input = new InputStreamReader(jar.getInputStream(entry), StandardCharsets.UTF_8)) {
                    check(language(locale).equals(new Gson().fromJson(input, new TypeToken<Map<String, String>>() {}.getType())), "Packaged translations differ from tested resources");
                }
            }
            if (PlatformDefaults.bundledMods().isEmpty()) return;
            var entry = jar.getEntry("fabric.mod.json");
            check(entry != null, "Bundled Fabric modules require loader metadata");
            var modules = new HashMap<String, String>();
            try (var input = new InputStreamReader(jar.getInputStream(entry), StandardCharsets.UTF_8)) {
                var metadata = JsonParser.parseReader(input).getAsJsonObject();
                check(metadata.has("jars"), "Fabric modules are not registered in the packaged agent");
                for (var reference : metadata.getAsJsonArray("jars")) {
                    String nestedPath = reference.getAsJsonObject().get("file").getAsString();
                    var nestedEntry = jar.getEntry(nestedPath);
                    check(nestedEntry != null, "Bundled module missing: " + nestedPath);
                    boolean licensed = false;
                    String id = null;
                    String version = null;
                    try (var nested = new ZipInputStream(jar.getInputStream(nestedEntry))) {
                        for (var resource = nested.getNextEntry(); resource != null; resource = nested.getNextEntry()) {
                            if (resource.getName().equals("fabric.mod.json")) {
                                var module = JsonParser.parseString(new String(nested.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
                                id = module.get("id").getAsString();
                                version = module.get("version").getAsString();
                            } else if (resource.getName().startsWith("LICENSE")) {
                                licensed |= nested.readAllBytes().length > 100;
                            }
                        }
                    }
                    check(id != null && version != null && licensed, "Bundled module metadata or license missing: " + nestedPath);
                    check(modules.put(id, version) == null, "Duplicate bundled module: " + id);
                }
            }
            check(modules.equals(PlatformDefaults.bundledMods()), "Bundled versions differ from dependency diagnostics");
        }
    }

    private static Map<String, String> language(String language) throws Exception {
        try (var input = LocalizationTest.class.getResourceAsStream("/assets/udmc_sync/lang/" + language + ".json")) {
            if (input == null) throw new AssertionError("Language file missing from the agent");
            return new Gson().fromJson(new InputStreamReader(input, StandardCharsets.UTF_8), new TypeToken<Map<String, String>>() {}.getType());
        }
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
