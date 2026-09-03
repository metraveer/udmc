package dev.udmc.sync;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Locale-neutral messages. Minecraft and Control each use their own standard translation engine. */
final class Messages {
    private static final Map<String, String> ENGLISH = loadEnglish();

    record Message(String key, List<String> args) {
        Message { args = List.copyOf(args); }
        String fallback() { return ENGLISH.get(key); }
        String english() { return String.format(Locale.ROOT, fallback(), args.toArray()); }
        /** A problem that refuses a publication until it is fixed. */
        Map<String, Object> issue(String side) {
            return Map.of("side", side, "code", key, "args", args, "message", english(), "level", "error");
        }
        /** Something the owner should know that is not certain enough to refuse a publication over. */
        Map<String, Object> warning(String side) {
            return Map.of("side", side, "code", key, "args", args, "message", english(), "level", "warning");
        }
    }

    static final class Failure extends IOException {
        final Message display;
        Failure(Message display) { super(display.english()); this.display = display; }
    }

    static Message of(String key, Object... args) {
        if (!ENGLISH.containsKey(key)) throw new IllegalArgumentException("Missing UDMC message: " + key);
        return new Message(key, Arrays.stream(args).map(String::valueOf).toList());
    }

    static Failure error(String key, Object... args) { return new Failure(of(key, args)); }

    static Message failure(Exception error) {
        if (error instanceof Failure failure) return failure.display;
        if (error instanceof java.net.ConnectException || error instanceof java.net.UnknownHostException) return of("udmc_sync.error.connect");
        if (error instanceof java.net.http.HttpTimeoutException) return of("udmc_sync.error.timeout");
        if (error instanceof javax.net.ssl.SSLException) return of("udmc_sync.error.tls");
        return of("udmc_sync.error.unknown", error.getClass().getSimpleName());
    }

    private static Map<String, String> loadEnglish() {
        try (var input = Messages.class.getResourceAsStream("/assets/udmc_sync/lang/en_us.json")) {
            if (input == null) throw new IOException("Missing UDMC language resource");
            return Map.copyOf(new Gson().fromJson(new InputStreamReader(input, StandardCharsets.UTF_8), new TypeToken<Map<String, String>>() {}.getType()));
        } catch (IOException error) { throw new ExceptionInInitializerError(error); }
    }
}
