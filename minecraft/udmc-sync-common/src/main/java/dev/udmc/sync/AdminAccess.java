package dev.udmc.sync;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;

/** Server-owned device grants. Only hashes of invitation and device secrets are persisted. */
public final class AdminAccess {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final SecureRandom RANDOM = new SecureRandom();
    static final long INVITE_TTL = 15 * 60_000L;
    static final long REQUEST_TTL = 30 * 60_000L;
    private final Path gameDir;
    private final UdmcConfig config;
    private final LongSupplier clock;
    private final Map<String, Window> attempts = new LinkedHashMap<>();
    private final Map<String, Long> deniedReports = new LinkedHashMap<>();
    private State state;
    private long lastSaved;

    public record Principal(String id, String role, boolean bootstrap) {
        public boolean owner() { return "owner".equals(role); }
    }
    public static final class Denied extends ApiException {
        Denied(int status, String code, String message, Object... args) { super(status, code, message, args); }
    }

    public AdminAccess(Path gameDir, UdmcConfig config) throws IOException {
        this(gameDir, config, System::currentTimeMillis);
    }

    AdminAccess(Path gameDir, UdmcConfig config, LongSupplier clock) throws IOException {
        this.gameDir = gameDir;
        this.config = config;
        this.clock = clock;
        Path path = path();
        if (Files.exists(path)) {
            try (var input = Files.newInputStream(path)) {
                byte[] bytes = input.readNBytes(1_048_577);
                if (bytes.length > 1_048_576) throw new IOException("Access registry is too large");
                try { state = GSON.fromJson(new String(bytes, StandardCharsets.UTF_8), State.class); }
                catch (RuntimeException error) { throw new IOException("Invalid access registry", error); }
            }
            if (state == null || state.schema != 1 || !binding().equals(state.binding) || state.devices == null || state.invites == null || state.events == null
                || state.devices.size() > 200 || state.invites.size() > 100 || state.events.size() > 250) {
                throw new IOException("Invalid access registry or changed project keys. Back up udmc-sync/admin-access.json and move it aside before resetting administrator access.");
            }
            for (Device device : state.devices) {
                if (device == null || device.id == null || device.name == null || device.tokenHash == null || !device.tokenHash.matches("[a-f0-9]{64}")
                    || !List.of("owner", "admin").contains(device.role)
                    || !List.of("pending", "approved", "rejected", "revoked").contains(device.status)) throw new IOException("Invalid device record");
            }
            if (state.devices.stream().map(d -> d.id).distinct().count() != state.devices.size()
                || state.devices.stream().map(d -> d.tokenHash).distinct().count() != state.devices.size()) throw new IOException("Duplicate device record");
            for (Invitation invitation : state.invites) {
                if (invitation == null || invitation.id == null || invitation.hash == null || !invitation.hash.matches("[a-f0-9]{64}")) throw new IOException("Invalid invitation record");
            }
        } else { state = new State(); state.binding = binding(); }
    }

    public synchronized Principal authenticate(String token, String ip) throws IOException {
        if (isRoot(token)) return new Principal("recovery", "owner", true);
        Device device = find(token);
        if (device == null || !"approved".equals(status(device))) {
            rateLimit(ip);
            throw new Denied(401, "ACCESS_DEVICE_NOT_APPROVED", "Device access is not approved or was revoked. Check Agent and access.");
        }
        long now = clock.getAsLong();
        boolean changedIp = !ip.equals(device.lastIp);
        if (changedIp || now - device.lastSeen > 90_000) {
            State next = copy();
            Device updated = byId(next, device.id);
            updated.lastIp = ip; updated.lastSeen = now;
            event(next, device.id, device.name, changedIp ? "address" : "connected", ip, "", 200);
            commit(next);
        } else {
            device.lastSeen = now;
            if (now - lastSaved > 60_000) commit(copy());
        }
        return new Principal(device.id, device.role, false);
    }

    public synchronized Map<String, Object> enrollOwner(Principal actor, String token, String name, String ip) throws IOException {
        if (!actor.bootstrap()) throw new Denied(403, "ACCESS_RECOVERY_KEY_REQUIRED", "Owner recovery requires the project key from the server JAR.");
        validateToken(token); name = name(name);
        if (isRoot(token)) throw new ApiException(400, "ACCESS_SEPARATE_DEVICE_KEY_REQUIRED", "A separate device key is required.");
        Device existing = find(token);
        if (existing != null) {
            if (!"owner".equals(existing.role) || !"approved".equals(existing.status)) throw new Denied(409, "ACCESS_DEVICE_KEY_USED", "This device key is already in use.");
            return view(existing);
        }
        State next = copy(); capacity(next);
        Device device = device(token, name, ip, "owner", "approved");
        next.devices.add(device);
        event(next, device.id, device.name, "owner-recovered", ip, "", 201);
        commit(next);
        return view(device);
    }

    public synchronized Map<String, Object> invite(Principal actor, String ip) throws IOException {
        requireOwner(actor);
        long now = clock.getAsLong();
        if (state.invites.stream().filter(i -> !i.used && i.expiresAt > now).count() >= 10) throw new Denied(429, "ACCESS_INVITE_LIMIT", "There are already 10 active invitations. Revoke one or wait for it to expire.");
        State next = copy();
        next.invites.removeIf(i -> i.used || i.expiresAt <= now);
        Invitation invitation = new Invitation();
        String code = secret();
        invitation.id = UUID.randomUUID().toString(); invitation.hash = hash(code);
        invitation.expiresAt = now + INVITE_TTL;
        next.invites.add(invitation);
        event(next, actor.id(), actorName(actor), "invited", ip, "", 201);
        commit(next);
        return Map.of("id", invitation.id, "code", code, "expiresAt", invitation.expiresAt);
    }

    public synchronized Map<String, Object> request(String invitation, String token, String name, String ip) throws IOException {
        rateLimit(ip); validateToken(token); name = name(name);
        if (isRoot(token)) throw new ApiException(400, "ACCESS_SEPARATE_DEVICE_KEY_REQUIRED", "A separate device key is required.");
        String inviteHash = hash(invitation == null ? "" : invitation);
        Device existing = find(token);
        // A retry after a lost response must not consume a second invitation or replace a grant.
        if (existing != null && "pending".equals(status(existing)) && existing.inviteHash.equals(inviteHash)) return view(existing);
        Invitation found = state.invites.stream().filter(i -> constant(i.hash, inviteHash) && !i.used && i.expiresAt > clock.getAsLong()).findFirst().orElse(null);
        if (found == null || existing != null) throw new Denied(403, "ACCESS_INVITE_INVALID", "The invitation is invalid, used, or expired. Ask the owner for a new one.");
        if (state.devices.stream().filter(d -> "pending".equals(status(d))).count() >= 20) throw new Denied(429, "ACCESS_REQUEST_LIMIT", "There are too many pending requests. The owner must review them first.");
        State next = copy(); capacity(next);
        next.invites.stream().filter(i -> i.id.equals(found.id)).findFirst().orElseThrow().used = true;
        Device device = device(token, name, ip, "admin", "pending"); device.inviteHash = inviteHash;
        device.expiresAt = clock.getAsLong() + REQUEST_TTL;
        next.devices.add(device);
        event(next, device.id, device.name, "requested", ip, "", 202);
        commit(next);
        return view(device);
    }

    public synchronized Map<String, Object> statusFor(String token, String ip) {
        Device device = find(token);
        if (device == null) { rateLimit(ip); throw new Denied(401, "ACCESS_DEVICE_NOT_FOUND", "Device not found. Request a new invitation."); }
        return view(device);
    }

    public synchronized void cancel(String token, String ip) throws IOException {
        Device device = find(token);
        if (device == null) { rateLimit(ip); throw new Denied(401, "ACCESS_REQUEST_NOT_FOUND", "Access request not found."); }
        if (!"pending".equals(status(device))) throw new Denied(409, "ACCESS_REQUEST_NOT_PENDING", "The access request is no longer pending.");
        State next = copy(); byId(next, device.id).status = "rejected";
        event(next, device.id, device.name, "cancelled", ip, "", 200);
        commit(next);
    }

    public synchronized Map<String, Object> me(Principal actor) {
        if (actor.bootstrap()) return Map.of("id", "recovery", "name", "Ключ восстановления", "role", "owner", "bootstrap", true, "pending", pendingCount());
        Map<String, Object> result = new LinkedHashMap<>(view(byId(state, actor.id())));
        result.put("bootstrap", false); result.put("pending", actor.owner() ? pendingCount() : 0);
        return result;
    }

    public synchronized Map<String, Object> list(Principal actor) {
        requireOwner(actor);
        return Map.of("me", me(actor), "devices", state.devices.stream().map(this::view).toList(),
            "invitations", state.invites.stream().filter(i -> !i.used && i.expiresAt > clock.getAsLong())
                .map(i -> Map.of("id", i.id, "expiresAt", i.expiresAt)).toList(), "events", List.copyOf(state.events));
    }

    public synchronized void decide(Principal actor, String id, String action, String ip) throws IOException {
        requireOwner(actor);
        Device device = byId(state, id);
        if (device.id.equals(actor.id())) throw new Denied(409, "ACCESS_SELF_REVOKE", "You cannot revoke your current device here.");
        String current = status(device);
        String nextStatus = switch (action == null ? "" : action) {
            case "approve" -> { if (!"pending".equals(current)) throw new Denied(409, "ACCESS_REQUEST_RESOLVED", "The access request was already resolved or expired."); yield "approved"; }
            case "reject" -> { if (!"pending".equals(current)) throw new Denied(409, "ACCESS_REQUEST_RESOLVED", "The access request was already resolved or expired."); yield "rejected"; }
            case "revoke" -> { if (!"approved".equals(current)) throw new Denied(409, "ACCESS_ALREADY_REVOKED", "Access is no longer active."); yield "revoked"; }
            default -> throw new ApiException(400, "ACCESS_ACTION_INVALID", "Unknown access action.");
        };
        State next = copy(); byId(next, id).status = nextStatus;
        event(next, actor.id(), actorName(actor), action, ip, device.name + " [" + device.id + "]", 200);
        commit(next);
    }

    public synchronized void revokeInvite(Principal actor, String id, String ip) throws IOException {
        requireOwner(actor);
        State next = copy();
        Invitation invitation = next.invites.stream().filter(i -> i.id.equals(id)).findFirst().orElseThrow(() -> new Denied(404, "ACCESS_INVITE_NOT_FOUND", "Invitation not found."));
        invitation.used = true;
        event(next, actor.id(), actorName(actor), "invite-revoked", ip, id, 200);
        commit(next);
    }

    public synchronized void audit(Principal actor, String ip, String operation, int status) throws IOException {
        State next = copy(); event(next, actor.id(), actorName(actor), "operation", ip, operation, status); commit(next);
    }

    public synchronized void denied(String ip, String operation, int status) throws IOException {
        long now = clock.getAsLong();
        deniedReports.entrySet().removeIf(e -> e.getValue() <= now);
        if (deniedReports.containsKey(ip) || deniedReports.size() >= 256) return;
        deniedReports.put(ip, now + 60_000);
        State next = copy(); event(next, "", "Неподтверждённый доступ", "denied", ip, operation, status); commit(next);
    }

    private void requireOwner(Principal actor) {
        if (!actor.owner()) throw new Denied(403, "ACCESS_OWNER_REQUIRED", "Only the project owner can manage devices and invitations.");
    }
    private long pendingCount() { return state.devices.stream().filter(d -> "pending".equals(status(d))).count(); }
    private String status(Device device) { return "pending".equals(device.status) && device.expiresAt <= clock.getAsLong() ? "expired" : device.status; }
    private Map<String, Object> view(Device d) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", d.id); result.put("name", d.name); result.put("role", d.role); result.put("status", status(d));
        result.put("createdAt", d.createdAt); result.put("expiresAt", d.expiresAt); result.put("lastSeen", d.lastSeen);
        result.put("lastIp", d.lastIp); result.put("requestIp", d.requestIp);
        result.put("verification", d.tokenHash.substring(0, 12).toUpperCase());
        result.put("active", "approved".equals(d.status) && d.lastSeen > 0 && clock.getAsLong() - d.lastSeen < 90_000);
        return result;
    }
    private Device device(String token, String name, String ip, String role, String status) {
        Device d = new Device(); d.id = UUID.randomUUID().toString(); d.name = name; d.tokenHash = hash(token);
        d.role = role; d.status = status; d.createdAt = clock.getAsLong(); d.requestIp = ip; return d;
    }
    private String actorName(Principal actor) { return actor.bootstrap() ? "Ключ восстановления" : byId(state, actor.id()).name; }
    private static Device byId(State source, String id) { return source.devices.stream().filter(d -> d.id.equals(id)).findFirst().orElseThrow(() -> new Denied(404, "ACCESS_DEVICE_NOT_FOUND", "Device not found. Request a new invitation.")); }
    private Device find(String token) {
        if (token == null || !token.matches("[a-f0-9]{64}")) return null;
        String hash = hash(token);
        return state.devices.stream().filter(d -> constant(d.tokenHash, hash)).findFirst().orElse(null);
    }
    private boolean isRoot(String token) {
        return token != null && config.adminToken != null && !config.adminToken.isBlank() && !"change-me".equals(config.adminToken)
            && constant(config.adminToken, token);
    }
    private static boolean constant(String a, String b) { return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8)); }
    private static String hash(String text) { return Hashes.sha256(text.getBytes(StandardCharsets.UTF_8)); }
    private static void validateToken(String token) { if (token == null || !token.matches("[a-f0-9]{64}")) throw new ApiException(400, "ACCESS_DEVICE_KEY_INVALID", "A random 256-bit device key is required."); }
    private static String name(String value) {
        if (value == null || value.isBlank() || value.trim().length() > 64 || value.chars().anyMatch(Character::isISOControl)) throw new ApiException(400, "ACCESS_DEVICE_NAME_INVALID", "Device name must contain 1 to 64 characters and no control characters.");
        return value.trim();
    }
    private static String secret() { byte[] bytes = new byte[32]; RANDOM.nextBytes(bytes); return HexFormat.of().formatHex(bytes); }
    private void rateLimit(String ip) {
        long now = clock.getAsLong();
        attempts.entrySet().removeIf(e -> e.getValue().until <= now);
        if (!attempts.containsKey(ip) && attempts.size() >= 2048) throw new Denied(429, "ACCESS_RATE_LIMIT", "Too many attempts. Wait one minute.");
        Window window = attempts.computeIfAbsent(ip, ignored -> new Window(now + 60_000));
        if (++window.count > 12) throw new Denied(429, "ACCESS_RATE_LIMIT", "Too many attempts. Wait one minute.");
    }
    private void capacity(State next) {
        if (next.devices.stream().filter(d -> List.of("approved", "pending").contains(status(d))).count() >= 100) throw new Denied(429, "ACCESS_DEVICE_LIMIT", "The 100-device limit has been reached. Revoke unused access first.");
        while (next.devices.size() >= 200) {
            Device stale = next.devices.stream().filter(d -> !List.of("approved", "pending").contains(status(d))).findFirst().orElseThrow();
            next.devices.remove(stale);
        }
    }
    private void event(State next, String id, String name, String action, String ip, String detail, int status) {
        next.events.add(Map.of("at", clock.getAsLong(), "deviceId", id, "name", name, "action", action, "ip", ip, "detail", detail, "status", status));
        while (next.events.size() > 250) next.events.remove(0);
    }
    /**
     * Signs the registry for the identity the project has now. For a restore at pairing, where
     * nothing in the registry was admitted under the old identity and nothing should be lost.
     */
    public synchronized void rebind() throws IOException {
        State next = copy(); next.binding = binding(); commit(next);
    }
    private State copy() { return GSON.fromJson(GSON.toJson(state), State.class); }
    private String binding() { return hash(config.packId + "\n" + config.manifestPublicKey + "\n" + config.adminToken); }
    private Path path() throws IOException { return ManagedPaths.internal(gameDir, "admin-access.json"); }
    private void commit(State next) throws IOException {
        Path path = path(); Files.createDirectories(path.getParent());
        Path temporary = Files.createTempFile(path.getParent(), "access-", ".tmp");
        try {
            Files.writeString(temporary, GSON.toJson(next), StandardCharsets.UTF_8);
            try { Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (AtomicMoveNotSupportedException ignored) { Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING); }
            state = next; lastSaved = clock.getAsLong();
        } finally { Files.deleteIfExists(temporary); }
    }
    private static final class State {
        int schema = 1;
        String binding;
        List<Device> devices = new ArrayList<>();
        List<Invitation> invites = new ArrayList<>();
        List<Map<String, Object>> events = new ArrayList<>();
    }
    private static final class Device {
        String id, name, tokenHash, role, status;
        String inviteHash = "", requestIp = "", lastIp = "";
        long createdAt, expiresAt, lastSeen;
    }
    private static final class Invitation { String id, hash; long expiresAt; boolean used; }
    private static final class Window { long until; int count; Window(long until) { this.until = until; } }
}
