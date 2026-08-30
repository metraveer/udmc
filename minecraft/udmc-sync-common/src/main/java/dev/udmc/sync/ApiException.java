package dev.udmc.sync;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A user-facing API failure with a stable, language-independent identity. */
class ApiException extends IllegalArgumentException {
    final int status;
    final String code;
    final List<String> args;

    ApiException(int status, String code, String fallback, Object... args) {
        super(fallback);
        this.status = status;
        this.code = code;
        this.args = Arrays.stream(args).map(String::valueOf).toList();
    }

    Map<String, Object> payload() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("error", getMessage());
        payload.put("code", code);
        payload.put("args", args);
        return payload;
    }
}
