package dev.udmc.sync;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;

/** Call while holding the ManifestStore lock, including immediately before upload commit. */
final class AdminWorkspace {
    static final long LEASE_MILLIS = 90_000;
    private final LongSupplier clock;
    private final String epoch = UUID.randomUUID().toString();
    private final Map<String, Presence> online = new LinkedHashMap<>();
    private long sequence;
    private Lease lease;

    AdminWorkspace() { this(System::currentTimeMillis); }
    AdminWorkspace(LongSupplier clock) { this.clock = clock; }

    static final class Conflict extends ApiException {
        Conflict(int status, String code, String message, Object... args) {
            super(status, code, message, args);
        }
    }

    String revision() { return epoch + ":" + sequence; }

    void seen(AdminAccess.Principal actor, String session, String name) {
        expire();
        if (!validSession(session)) return;
        String key = actor.id() + ":" + session;
        if (!online.containsKey(key) && online.size() >= 128) return;
        online.put(key, new Presence(actor.id(), session, name, clock.getAsLong()));
    }

    void claim(AdminAccess.Principal actor, String session, String expected, String name, String operation) {
        expire();
        if (!validSession(session) || expected == null) {
            throw new Conflict(428, "WORKSPACE_REQUIRED", "Update Control and refresh the server before editing.");
        }
        if (!revision().equals(expected)) {
            throw new Conflict(409, "WORKSPACE_STALE", "Another administrator changed the server. Refresh and review the changes before retrying.");
        }
        if (lease != null && !owns(actor, session)) {
            throw new Conflict(423, "WORKSPACE_LOCKED", "Another administrator is editing: " + lease.name, lease.name);
        }
        lease = new Lease(actor.id(), session, name, operation, clock.getAsLong() + LEASE_MILLIS);
        seen(actor, session, name);
    }

    void commit(AdminAccess.Principal actor, String session, String expected, String name, String operation) {
        claim(actor, session, expected, name, operation);
        // Invalidate old views even if an operation fails or only partly affects external state.
        sequence++;
    }

    void heartbeat(AdminAccess.Principal actor, String session) {
        expire();
        if (owns(actor, session)) lease = new Lease(lease.id, lease.session, lease.name, lease.operation, clock.getAsLong() + LEASE_MILLIS);
    }

    void release(AdminAccess.Principal actor, String session) {
        if (owns(actor, session)) lease = null;
    }

    void revoke(String id) {
        if (lease != null && lease.id.equals(id)) lease = null;
        online.values().removeIf(p -> p.id.equals(id));
    }

    Map<String, Object> snapshot(AdminAccess.Principal actor, String session) {
        expire();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("revision", revision());
        result.put("lease", lease == null ? null : Map.of("deviceId", lease.id, "name", lease.name,
            "operation", lease.operation, "expiresAt", lease.expiresAt, "mine", owns(actor, session)));
        // Presence is per device: Control is single-instance per machine, so a leftover
        // session of the same device (a WebView reload) must not show as another admin.
        result.put("online", online.values().stream().map(p -> Map.of("deviceId", p.id, "name", p.name,
            "lastSeen", p.lastSeen, "mine", p.id.equals(actor.id()))).toList());
        return result;
    }

    private boolean owns(AdminAccess.Principal actor, String session) {
        return lease != null && lease.id.equals(actor.id()) && lease.session.equals(session);
    }
    private void expire() {
        long now = clock.getAsLong();
        if (lease != null && lease.expiresAt <= now) lease = null;
        online.values().removeIf(p -> p.lastSeen + LEASE_MILLIS <= now);
    }
    private static boolean validSession(String value) {
        return value != null && value.matches("[a-zA-Z0-9_-]{16,80}");
    }
    private record Lease(String id, String session, String name, String operation, long expiresAt) {}
    private record Presence(String id, String session, String name, long lastSeen) {}
}
