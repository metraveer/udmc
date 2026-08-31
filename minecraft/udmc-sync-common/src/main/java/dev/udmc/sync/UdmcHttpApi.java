package dev.udmc.sync;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedServer;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.management.ManagementFactory;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.ArrayList;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Semaphore;

public final class UdmcHttpApi {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final int MAX_COMMAND_LENGTH = 512;

    private final Path gameDir;
    private final UdmcConfig config;
    private final ManifestStore store;
    private final AgentDistribution agents;
    private volatile MinecraftServer minecraftServer;
    private HttpServer server;
    private AdminAccess access;
    private final AdminWorkspace workspace = new AdminWorkspace();
    private final long loadedReleaseSequence;
    private volatile Map<String, Object> pendingPower;
    private volatile Thread powerTimer;
    private ThreadPoolExecutor workers;
    private final Semaphore uploads = new Semaphore(2);

    public UdmcHttpApi(Path gameDir, UdmcConfig config, ManifestStore store) {
        this.gameDir = gameDir;
        this.config = config;
        this.store = store;
        this.agents = new AgentDistribution(gameDir, config);
        // The release the running process was started with: while it lags behind the
        // published sequence, players still receive the previous pack.
        long loaded = -1L;
        try {
            loaded = store.loadPublished().releaseSequence;
        } catch (Exception error) {
            UdmcSync.LOGGER.warn("Could not read the published release sequence at startup", error);
        }
        this.loadedReleaseSequence = loaded;
        // Before the login check reads the published client: it compares what a player has
        // against what this server offers, and what it offers is now this very file.
        agents.publishSelf();
        AgentLoginProtocol.configureServer(config, agents);
    }

    public void attachServer(MinecraftServer minecraftServer) {
        this.minecraftServer = minecraftServer;
        UdmcSync.LOGGER.info("UDMC attached to the dedicated server runtime.");
    }

    public void start() throws IOException {
        access = new AdminAccess(gameDir, config);
        server = HttpServer.create(new InetSocketAddress(config.apiHost, config.apiPort), 0);
        server.createContext("/", this::handle);
        workers = new ThreadPoolExecutor(8, 8, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32), task -> {
            Thread thread = new Thread(task, "UDMC HTTP");
            thread.setDaemon(true);
            return thread;
        }, new ThreadPoolExecutor.CallerRunsPolicy());
        server.setExecutor(workers);
        server.start();
        UdmcSync.LOGGER.info("UDMC API listening on {}:{}", config.apiHost, config.apiPort);

        if ("change-me".equals(config.adminToken)) {
            UdmcSync.LOGGER.warn("UDMC adminToken is still change-me. Edit config/udmc-sync.json.");
        }
    }

    public void stop() {
        // The login check hands players this server's download URL: when the API is gone the
        // URL leads nowhere, so the check stands down with it rather than sending them there.
        AgentLoginProtocol.clearServer();
        if (server != null) server.stop(0);
        if (workers != null) workers.shutdownNow();
    }
    int port() { return server.getAddress().getPort(); }

    private void handle(HttpExchange exchange) throws IOException {
        AdminAccess.Principal actor = null;
        String path = exchange.getRequestURI().getPath();
        String method = exchange.getRequestMethod();
        String ip = exchange.getRemoteAddress().getAddress().getHostAddress();
        try {
            cors(exchange);

            if ("OPTIONS".equals(exchange.getRequestMethod())) {
                respond(exchange, 204, "");
                return;
            }

            if ("GET".equals(method) && "/".equals(path)) {
                respondJson(exchange, 200, Map.of(
                    "service", "udmc-sync-" + config.loaderType,
                    "role", "minecraft-server-api"
                ));
                return;
            }

            if ("GET".equals(method) && "/health".equals(path)) {
                respondJson(exchange, 200, Map.of(
                    "ok", true,
                    "accessControl", true,
                    "service", "udmc-sync-" + config.loaderType
                ));
                return;
            }

            // "/udmc" is the address a rejected player retypes from the disconnect screen,
            // where the link cannot be clicked; it reaches the same public instructions.
            if ("GET".equals(method) && (path.startsWith("/agents/") || "/udmc".equals(path))) {
                handlePublicAgents(exchange, path);
                return;
            }

            if ("GET".equals(method) && "/manifest".equals(path)) {
                String body = GSON.toJson(store.loadPublished());
                if (!config.manifestPrivateKey.isBlank()) {
                    exchange.getResponseHeaders().set("x-udmc-signature", ManifestSecurity.sign(
                        body.getBytes(StandardCharsets.UTF_8), config.manifestPrivateKey));
                } else if (config.requireSignedManifest) {
                    throw new ApiException(500, "MANIFEST_SIGNING_KEY_MISSING", "Manifest signing key is missing.");
                }
                exchange.getResponseHeaders().set("cache-control", "no-store");
                respond(exchange, 200, body);
                return;
            }

            if ("GET".equals(method) && path.startsWith("/files/")) {
                handleDownload(exchange, path.substring("/files/".length()));
                return;
            }

            if ("POST".equals(method) && "/access/request".equals(path)) {
                AccessRequest body = parseBody(exchange, AccessRequest.class);
                if (body == null) throw new ApiException(400, "ACCESS_REQUEST_BODY_REQUIRED", "Access request details are required.");
                respondJson(exchange, 202, access.request(body.invite, body.token, body.name, ip));
                return;
            }
            if ("GET".equals(method) && "/access/status".equals(path)) {
                respondJson(exchange, 200, access.statusFor(token(exchange), ip));
                return;
            }
            if ("POST".equals(method) && "/access/cancel".equals(path)) {
                access.cancel(token(exchange), ip);
                respondJson(exchange, 200, Map.of("ok", true));
                return;
            }

            // Claiming a server needs no token: the code is the proof, and it is spent here.
            // Unauthenticated on purpose, and only answerable while nobody has claimed this server.
            if ("POST".equals(method) && "/pair".equals(path)) {
                PairRequest body = parseBody(exchange, PairRequest.class);
                respondJson(exchange, 200, ServerIdentity.claim(gameDir, config,
                    body == null ? "" : body.code, ip, body == null ? null : body.project));
                return;
            }
            if ("GET".equals(method) && "/pair".equals(path)) {
                // Lets a panel see whether this server is waiting before asking anyone for a code.
                respondJson(exchange, 200, Map.of(
                    "unpaired", ServerIdentity.unpaired(config),
                    "packName", config.packName,
                    "minecraftVersion", config.minecraftVersion,
                    "loaderType", config.loaderType
                ));
                return;
            }

            if (path.startsWith("/admin/")) {
                actor = access.authenticate(token(exchange), ip);
                synchronized (store) {
                    workspace.seen(actor, session(exchange), String.valueOf(access.me(actor).get("name")));
                }
                if ("GET".equals(method) && "/admin/workspace".equals(path)) {
                    synchronized (store) { respondJson(exchange, 200, workspace.snapshot(actor, session(exchange))); }
                    return;
                }
                if ("POST".equals(method) && ("/admin/workspace/heartbeat".equals(path) || "/admin/workspace/release".equals(path))) {
                    synchronized (store) {
                        if (path.endsWith("/release")) {
                            if (workspace.revision().equals(firstHeader(exchange, "x-udmc-revision"))) workspace.release(actor, session(exchange));
                        }
                        else workspace.heartbeat(actor, session(exchange));
                        respondJson(exchange, 200, workspace.snapshot(actor, session(exchange)));
                    }
                    return;
                }
                if ("GET".equals(method) && "/admin/access/me".equals(path)) {
                    respondJson(exchange, 200, access.me(actor));
                    return;
                }
                if ("GET".equals(method) && "/admin/access".equals(path)) {
                    respondJson(exchange, 200, access.list(actor));
                    return;
                }
                if ("POST".equals(method) && "/admin/access/owner".equals(path)) {
                    AccessRequest body = parseBody(exchange, AccessRequest.class);
                    if (body == null) throw new ApiException(400, "ACCESS_DEVICE_BODY_REQUIRED", "Device details are required.");
                    respondJson(exchange, 201, access.enrollOwner(actor, body.token, body.name, ip));
                    return;
                }
                if ("POST".equals(method) && "/admin/access/invitations".equals(path)) {
                    respondJson(exchange, 201, access.invite(actor, ip));
                    return;
                }
                if ("POST".equals(method) && "/admin/access/invitations/revoke".equals(path)) {
                    AccessRequest body = parseBody(exchange, AccessRequest.class);
                    if (body == null) throw new ApiException(400, "ACCESS_INVITATION_BODY_REQUIRED", "Invitation details are required.");
                    access.revokeInvite(actor, body.id, ip);
                    respondJson(exchange, 200, Map.of("ok", true));
                    return;
                }
                if ("POST".equals(method) && "/admin/access/decision".equals(path)) {
                    AccessRequest body = parseBody(exchange, AccessRequest.class);
                    if (body == null) throw new ApiException(400, "ACCESS_DECISION_BODY_REQUIRED", "Access decision details are required.");
                    access.decide(actor, body.id, body.action, ip);
                    if ("revoke".equals(body.action)) synchronized (store) { workspace.revoke(body.id); }
                    respondJson(exchange, 200, Map.of("ok", true));
                    return;
                }

                if ("GET".equals(method) && "/admin/files".equals(path)) {
                    synchronized (store) {
                        markRevision(exchange);
                        respondJson(exchange, 200, store.draftState());
                    }
                    return;
                }

                if ("GET".equals(method) && "/admin/status".equals(path)) {
                    handleStatus(exchange, actor);
                    return;
                }

                if ("GET".equals(method) && "/admin/project/backup".equals(path)) {
                    // The only request that hands out the signing key, so only the owner may ask.
                    if (!actor.owner()) throw new ApiException(403, "ACCESS_OWNER_REQUIRED", "Only the project owner can save a backup.");
                    exchange.getResponseHeaders().set("cache-control", "no-store");
                    respondJson(exchange, 200, ServerIdentity.backup(config));
                    return;
                }
                if ("GET".equals(method) && "/admin/agents".equals(path)) {
                    synchronized (store) { markRevision(exchange); respondJson(exchange, 200, agents.describe()); }
                    return;
                }
                if ("POST".equals(method) && ("/admin/agents/client".equals(path) || "/admin/agents/update".equals(path))) {
                    handleAgentUpload(exchange, path.endsWith("/update"));
                    return;
                }

                if ("GET".equals(method) && "/admin/server/commands".equals(path)) {
                    handleCommandCatalog(exchange);
                    return;
                }
                if ("GET".equals(method) && "/admin/server/files".equals(path)) {
                    respondJson(exchange, 200, store.inventory());
                    return;
                }
                if ("GET".equals(method) && "/admin/validation".equals(path)) {
                    synchronized (store) {
                        markRevision(exchange);
                        respondJson(exchange, 200, store.validation("server".equals(queryParam(exchange, "target"))));
                    }
                    return;
                }
                if ("POST".equals(method) && "/admin/files".equals(path)) {
                    handleUpload(exchange);
                    return;
                }
                if (isWorkspaceMutation(method, path)) {
                    synchronized (store) { guardMutation(exchange, false); }
                    byte[] body = readBody(exchange);
                    synchronized (store) {
                        guardMutation(exchange, true);
                        handleMutation(exchange, path, body);
                    }
                    return;
                }
            }

            respondError(exchange, 404, "NOT_FOUND", "API endpoint not found.");
        } catch (AdminWorkspace.Conflict error) {
            Map<String, Object> payload = new LinkedHashMap<>(error.payload());
            if (actor != null) synchronized (store) { payload.put("workspace", workspace.snapshot(actor, session(exchange))); }
            respondJson(exchange, error.status, payload);
        } catch (AdminAccess.Denied error) {
            if (error.status == 401 || error.status == 403 || error.status == 429) {
                try { access.denied(ip, method + " " + path.substring(0, Math.min(path.length(), 256)), error.status); }
                catch (IOException auditError) { UdmcSync.LOGGER.error("Cannot persist UDMC denied-access audit", auditError); }
            }
            respondJson(exchange, error.status, error.payload());
        } catch (ApiException error) {
            respondJson(exchange, error.status, error.payload());
        } catch (ManifestStore.UploadTooLarge error) {
            respondError(exchange, 413, "UPLOAD_TOO_LARGE", error.getMessage());
        } catch (IllegalArgumentException | com.google.gson.JsonParseException error) {
            respondError(exchange, 400, "INVALID_REQUEST", String.valueOf(error.getMessage()));
        } catch (Exception error) {
            UdmcSync.LOGGER.error("UDMC API request failed.", error);
            if (exchange.getResponseCode() == -1) respondError(exchange, 500, "INTERNAL_ERROR", "Internal server error.");
        } finally {
            if (actor != null && !"GET".equals(method) && !path.startsWith("/admin/access/") && !path.startsWith("/admin/workspace/")) {
                try { access.audit(actor, ip, method + " " + path.substring(0, Math.min(path.length(), 256)), exchange.getResponseCode()); }
                catch (IOException error) { UdmcSync.LOGGER.error("Cannot persist UDMC access audit", error); }
            }
            exchange.close();
        }
    }

    private static boolean isWorkspaceMutation(String method, String path) {
        return ("DELETE".equals(method) && "/admin/files".equals(path)) || ("POST".equals(method) && switch (path) {
            case "/admin/server/files/import", "/admin/server/files/remove", "/admin/files/update", "/admin/files/revert", "/admin/draft/reset",
                "/admin/publish", "/admin/settings", "/admin/server/command", "/admin/server/restart", "/admin/server/stop", "/admin/agents/settings",
                "/admin/files/detach" -> true;
            default -> false;
        });
    }

    private void handleMutation(HttpExchange exchange, String path, byte[] body) throws IOException {
        switch (path) {
            case "/admin/agents/settings" -> {
                var settings = parseBody(body, AgentSettings.class);
                if (settings == null || (settings.requireClient == null && settings.gameAddress == null && settings.serverUrl == null)) {
                    throw new ApiException(400, "CLIENT_AGENT_POLICY_REQUIRED", "Client agent policy is required.");
                }
                if (settings.requireClient != null) agents.setRequired(settings.requireClient);
                if (settings.gameAddress != null) agents.setGameAddress(settings.gameAddress);
                if (settings.serverUrl != null) agents.setServerUrl(settings.serverUrl);
                respondJson(exchange, 200, agents.describe());
            }
            case "/admin/server/files/import" -> {
                var request = parseBody(body, ImportRequest.class);
                if (request == null) throw new ApiException(400, "SERVER_FILE_IMPORT_BODY_REQUIRED", "Server file import details are required.");
                respondJson(exchange, 201, Map.of("file", store.importServerFile(request.path, request.side, request.sha256)));
            }
            case "/admin/server/files/remove" -> {
                var request = parseBody(body, ImportRequest.class);
                if (request == null) throw new ApiException(400, "SERVER_FILE_REMOVAL_BODY_REQUIRED", "Server file removal details are required.");
                respondJson(exchange, 200, store.removeServerFile(request.path, request.sha256));
            }
            case "/admin/files" -> handleDelete(exchange);
            case "/admin/files/update" -> handleFileUpdate(exchange, body);
            case "/admin/files/revert" -> handleFileRevert(exchange, body);
            case "/admin/files/detach" -> {
                var request = parseBody(body, ImportRequest.class);
                if (request == null || request.path == null) throw new ApiException(400, "FILE_PATH_REQUIRED", "A file path is required.");
                respondJson(exchange, 200, store.detachFile(request.path));
            }
            case "/admin/draft/reset" -> respondJson(exchange, 200, store.resetDraft());
            case "/admin/publish" -> handlePublish(exchange, body);
            case "/admin/settings" -> handleSettings(exchange, body);
            case "/admin/server/command" -> handleCommand(exchange, body);
            case "/admin/server/restart" -> handlePowerAction(exchange, true, body);
            case "/admin/server/stop" -> handlePowerAction(exchange, false, body);
            default -> throw new ApiException(400, "OPERATION_UNKNOWN", "Unknown operation.");
        }
    }

    private String session(HttpExchange exchange) { return firstHeader(exchange, "x-udmc-session"); }
    private void markRevision(HttpExchange exchange) { exchange.getResponseHeaders().set("x-udmc-revision", workspace.revision()); }

    private void guardMutation(HttpExchange exchange, boolean commit) throws IOException {
        // Recheck access after slow uploads, including revocations made while the body was arriving.
        var actor = access.authenticate(token(exchange), exchange.getRemoteAddress().getAddress().getHostAddress());
        String name = String.valueOf(access.me(actor).get("name"));
        String expected = firstHeader(exchange, "x-udmc-revision");
        String operation = exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath();
        if (commit) workspace.commit(actor, session(exchange), expected, name, operation);
        else workspace.claim(actor, session(exchange), expected, name, operation);
        markRevision(exchange);
    }

    private void handleStatus(HttpExchange exchange, AdminAccess.Principal actor) throws IOException {
        MinecraftServer current = minecraftServer;
        Runtime runtime = Runtime.getRuntime();
        long usedMemory = runtime.totalMemory() - runtime.freeMemory();
        long maxMemory = runtime.maxMemory();

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("access", access.me(actor));
        synchronized (store) { payload.put("workspace", workspace.snapshot(actor, session(exchange))); }
        payload.put("state", current == null ? "starting" : current.isShutdown() ? "stopping" : "online");
        payload.put("minecraftVersion", config.minecraftVersion);
        payload.put("loader", Map.of("type", config.loaderType, "version", config.loaderVersion));
        payload.put("javaVersion", System.getProperty("java.version"));
        payload.put("agentProtocol", 1);
        payload.put("security", Map.of("signedManifest", !config.manifestPrivateKey.isBlank(), "algorithm", "Ed25519"));
        payload.put("uptimeSeconds", ManagementFactory.getRuntimeMXBean().getUptime() / 1000L);
        payload.put("loadedReleaseSequence", loadedReleaseSequence);
        Map<String, Object> power = pendingPower;
        if (power != null) payload.put("power", power);
        payload.put("performance", Map.of(
            "memoryUsedBytes", usedMemory,
            "memoryMaxBytes", maxMemory,
            "averageTickMs", current == null ? 0.0 : round(current.getAverageTickTimeNanos() / 1_000_000.0),
            "tps", current == null ? 0.0 : calculateTps(current.getAverageTickTimeNanos())
        ));

        if (current == null) {
            payload.put("motd", "Minecraft server is starting");
            payload.put("gamePort", 0);
            payload.put("worlds", 0);
            payload.put("players", Map.of("online", 0, "max", 0, "names", new String[0]));
            payload.put("rcon", Map.of("enabled", false, "port", 25575));
            payload.put("capabilities", Map.of("commands", false, "powerActions", false));
            respondJson(exchange, 200, payload);
            return;
        }

        int worldCount = 0;
        for (Object ignored : current.getAllLevels()) {
            worldCount++;
        }

        int maxPlayers = current.getPlayerList() == null ? 0 : current.getPlayerList().getMaxPlayers();
        payload.put("motd", current.getMotd());
        payload.put("gamePort", current.getPort());
        payload.put("worlds", worldCount);
        payload.put("players", Map.of(
            "online", current.getPlayerCount(),
            "max", maxPlayers,
            "names", Arrays.asList(current.getPlayerNames())
        ));

        if (current instanceof DedicatedServer dedicated) {
            payload.put("rcon", Map.of(
                "enabled", dedicated.getProperties().enableRcon,
                "port", dedicated.getProperties().rconPort
            ));
            payload.put("capabilities", Map.of(
                "commands", true,
                "modValidation", true,
                // Whether this runtime can be stopped and restarted at all, not whether someone
                // ticked a box. An administrator who can reach this API can already type "stop"
                // into the console, so a separate switch withheld the button and nothing else.
                "powerActions", true
            ));
        } else {
            payload.put("rcon", Map.of("enabled", false, "port", 25575));
            payload.put("capabilities", Map.of("commands", false, "powerActions", false));
        }

        respondJson(exchange, 200, payload);
    }

    private void handleCommand(HttpExchange exchange, byte[] body) throws IOException {
        MinecraftServer current = minecraftServer;

        if (!(current instanceof DedicatedServer dedicated) || current.isShutdown()) {
            respondError(exchange, 503, "MINECRAFT_NOT_READY", "Minecraft server is not ready.");
            return;
        }

        CommandRequest request = parseBody(body, CommandRequest.class);
        String command = request == null || request.command == null ? "" : request.command.trim();

        while (command.startsWith("/")) {
            command = command.substring(1);
        }

        if (command.isBlank() || command.length() > MAX_COMMAND_LENGTH || command.contains("\n") || command.contains("\r") || command.contains("\0")) {
            respondError(exchange, 400, "SERVER_COMMAND_INVALID", "Invalid server command.");
            return;
        }

        String output = dedicated.runCommand(command);
        respondJson(exchange, 200, Map.of(
            "command", command,
            "output", output == null ? "" : output
        ));
    }

    private void handleCommandCatalog(HttpExchange exchange) throws Exception {
        MinecraftServer current = minecraftServer;
        if (current == null || current.isShutdown()) {
            respondError(exchange, 503, "MINECRAFT_NOT_READY", "Minecraft server is not ready.");
            return;
        }
        CompletableFuture<Object> result = new CompletableFuture<>();
        current.execute(() -> {
            try {
                var dispatcher = current.getCommands().getDispatcher();
                var source = current.createCommandSourceStack();
                var commands = new ArrayList<Map<String, Object>>();
                for (var node : dispatcher.getRoot().getChildren()) {
                    if (!node.canUse(source)) continue;
                    var usages = new ArrayList<String>();
                    for (String usage : dispatcher.getSmartUsage(node, source).values()) {
                        usages.add(node.getName() + " " + usage);
                    }
                    if (usages.isEmpty()) usages.add(node.getName());
                    commands.add(Map.of("name", node.getName(), "usage", usages));
                }
                result.complete(Map.of("source", "server-dispatcher", "minecraftVersion", config.minecraftVersion, "commands", commands));
            } catch (Exception error) { result.completeExceptionally(error); }
        });
        respondJson(exchange, 200, result.get(5, TimeUnit.SECONDS));
    }

    private void handlePowerAction(HttpExchange exchange, boolean restart, byte[] body) throws IOException {
        MinecraftServer current = minecraftServer;
        PowerRequest request = parseBody(body, PowerRequest.class);
        if (request != null && Boolean.TRUE.equals(request.cancel)) {
            cancelPendingPower(current, true);
            respondJson(exchange, 200, Map.of("cancelled", true));
            return;
        }

        if (current == null || current.isShutdown()) {
            respondError(exchange, 503, "MINECRAFT_NOT_READY", "Minecraft server is not ready.");
            return;
        }

        int delay = request == null || request.delaySeconds == null ? 0 : request.delaySeconds;
        if (delay < 0 || delay > 600) {
            respondError(exchange, 400, "POWER_DELAY_INVALID", "The power action delay must be between 0 and 600 seconds.");
            return;
        }

        cancelPendingPower(current, false);
        if (delay == 0) {
            respondJson(exchange, 202, Map.of("accepted", true, "action", restart ? "restart" : "stop"));
            executePowerAction(current, restart, 750L, null);
            return;
        }

        String action = restart ? "restart" : "stop";
        Map<String, Object> pending = Map.of("action", action, "executeAt", System.currentTimeMillis() + delay * 1000L, "delaySeconds", delay);
        pendingPower = pending;
        Thread timer = new Thread(() -> runCountdown(current, restart, delay, pending), "UDMC Power Countdown");
        powerTimer = timer;
        timer.setDaemon(true);
        timer.start();
        respondJson(exchange, 202, Map.of("accepted", true, "action", action, "delaySeconds", delay));
    }

    // Chat marks players actually get to see; every value greater than the delay is skipped.
    static int[] countdownMarks(int delay) {
        return java.util.stream.IntStream.of(delay, 60, 30, 10, 5, 4, 3, 2, 1)
            .filter(mark -> mark <= delay).distinct().sorted().toArray();
    }

    private void runCountdown(MinecraftServer current, boolean restart, int delay, Map<String, Object> pending) {
        String what = restart ? "Перезапуск сервера / Server restart" : "Остановка сервера / Server stop";
        try {
            announce(current, "[UDMC] " + what + ": " + delay + " c/s. "
                + (restart ? "После перезапуска перезайдите, перезапустив игру / Relaunch your game to rejoin after the restart." : ""));
            int[] marks = countdownMarks(delay);
            int remaining = delay;
            for (int index = marks.length - 1; index >= 0; index--) {
                int mark = marks[index];
                if (mark == delay) continue;
                Thread.sleep((remaining - mark) * 1000L);
                if (powerTimer != Thread.currentThread() || pendingPower != pending) return;
                announce(current, "[UDMC] " + what + ": " + mark + " c/s");
                remaining = mark;
            }
            Thread.sleep(remaining * 1000L);
            if (powerTimer != Thread.currentThread() || pendingPower != pending) return;
            pendingPower = null;
            executePowerAction(current, restart, 0L, Thread.currentThread());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        } catch (Exception error) {
            UdmcSync.LOGGER.warn("The scheduled power action failed", error);
            if (pendingPower == pending) pendingPower = null;
        }
    }

    private void cancelPendingPower(MinecraftServer current, boolean announceCancellation) {
        Thread timer = powerTimer;
        Map<String, Object> pending = pendingPower;
        powerTimer = null;
        pendingPower = null;
        if (timer != null) timer.interrupt();
        if (announceCancellation && pending != null && current != null && !current.isShutdown()) {
            announce(current, "[UDMC] Отменено / Cancelled: " + ("restart".equals(pending.get("action")) ? "перезапуск / restart" : "остановка / stop"));
        }
    }

    private void announce(MinecraftServer current, String message) {
        try {
            if (current instanceof DedicatedServer dedicated && !current.isShutdown()) dedicated.runCommand("say " + message);
        } catch (Exception error) {
            UdmcSync.LOGGER.warn("Could not announce the power countdown", error);
        }
    }

    private void executePowerAction(MinecraftServer current, boolean restart, long graceMs, Thread reuse) {
        Runnable halt = () -> {
            try {
                if (graceMs > 0) Thread.sleep(graceMs);
                Path marker = gameDir.resolve("udmc-sync").resolve("restart-requested");
                if (restart) {
                    Files.createDirectories(marker.getParent());
                    Files.writeString(marker, TimeUtil.nowIso(), StandardCharsets.UTF_8);
                } else {
                    Files.deleteIfExists(marker);
                }
                current.halt(false);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } catch (Exception error) {
                UdmcSync.LOGGER.warn("The power action failed", error);
            }
        };
        if (reuse != null) { halt.run(); return; }
        Thread shutdownThread = new Thread(halt, restart ? "UDMC Server Restart" : "UDMC Server Stop");
        shutdownThread.setDaemon(true);
        shutdownThread.start();
    }

    private void handleDownload(HttpExchange exchange, String rawBlobName) throws IOException {
        String blobName = URLDecoder.decode(rawBlobName, StandardCharsets.UTF_8);
        Path blobPath = store.blobPath(blobName);

        if (!Files.exists(blobPath)) {
            respondError(exchange, 404, "FILE_NOT_FOUND", "File not found.");
            return;
        }

        exchange.getResponseHeaders().set("content-type", "application/octet-stream");
        exchange.getResponseHeaders().set("cache-control", "public, max-age=31536000, immutable");
        long size = Files.size(blobPath);
        try (var input = Files.newInputStream(blobPath)) {
            exchange.sendResponseHeaders(200, size == 0 ? -1 : size);
            try (OutputStream output = exchange.getResponseBody()) {
                input.transferTo(output);
            }
        }
    }

    private void handleAgentUpload(HttpExchange exchange, boolean update) throws IOException {
        if (!uploads.tryAcquire()) { respondError(exchange, 503, "UPLOAD_BUSY", "Another upload is in progress."); return; }
        Path temporary = null;
        try {
            synchronized (store) { guardMutation(exchange, false); }
            temporary = AgentPackages.receive(exchange.getRequestBody(), ManagedPaths.internal(gameDir, "agent-incoming"));
            synchronized (store) {
                guardMutation(exchange, true);
                var result = update ? agents.update(temporary) : agents.publishClient(temporary);
                respondJson(exchange, update ? 202 : 201, result);
            }
        } finally {
            if (temporary != null) Files.deleteIfExists(temporary);
            uploads.release();
        }
    }

    private void handlePublicAgents(HttpExchange exchange, String path) throws IOException {
        if (path.equals("/agents/info")) {
            // Public join hints for synced clients; the address is a convenience, not a trust anchor.
            respondJson(exchange, 200, Map.of("packName", config.packName, "gameAddress", config.gameAddress));
            return;
        }
        if (path.equals("/agents/client")) {
            var release = agents.release();
            if (release == null) respondError(exchange, 404, "CLIENT_AGENT_NOT_READY", "Client agent is not ready.");
            else respondJson(exchange, 200, release);
            return;
        }
        // Two paths for one page: /udmc is short enough to retype from the disconnect
        // screen, where the link cannot be clicked; /agents/install keeps older links alive.
        if (path.equals("/udmc") || path.equals("/agents/install")) {
            byte[] body = installPage().getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "text/html; charset=utf-8");
            exchange.getResponseHeaders().set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            return;
        }
        Path file;
        try {
            if (path.equals("/agents/download")) file = agents.latestFile();
            else if (path.startsWith("/agents/files/")) file = agents.publicFile(path.substring("/agents/files/".length()));
            else { respondError(exchange, 404, "NOT_FOUND", "API endpoint not found."); return; }
        } catch (java.nio.file.NoSuchFileException error) { respondError(exchange, 404, "CLIENT_AGENT_NOT_READY", "Client agent is not ready."); return; }
        exchange.getResponseHeaders().set("content-type", "application/java-archive");
        exchange.getResponseHeaders().set("content-disposition", "attachment; filename=\"udmc-sync-client.jar\"");
        exchange.getResponseHeaders().set("x-content-type-options", "nosniff");
        exchange.getResponseHeaders().set("cache-control", path.equals("/agents/download") ? "no-store" : "public, max-age=31536000, immutable");
        try (var input = Files.newInputStream(file)) {
            exchange.sendResponseHeaders(200, Files.size(file));
            input.transferTo(exchange.getResponseBody());
        }
    }

    private static final class AgentSettings { Boolean requireClient; String gameAddress; String serverUrl; }

    private void handleUpload(HttpExchange exchange) throws IOException {
        String managedPath = firstHeader(exchange, "x-udmc-path");
        if (managedPath == null) {
            managedPath = queryParam(exchange, "path");
        }
        String side = firstHeader(exchange, "x-udmc-side");
        String sourceHeader = firstHeader(exchange, "x-udmc-source");
        if (sourceHeader != null && sourceHeader.length() > 1024) throw new ApiException(400, "CATALOG_SOURCE_TOO_LARGE", "Catalog source metadata is too large.");
        var source = sourceHeader == null ? null : GSON.fromJson(sourceHeader, ManifestModels.FileSource.class);
        String length = firstHeader(exchange, "content-length");
        if (length != null && Long.parseLong(length) > ManifestStore.MAX_UPLOAD_BYTES) {
            respondError(exchange, 413, "UPLOAD_TOO_LARGE", "File is larger than 512 MiB.");
            return;
        }
        if (!uploads.tryAcquire()) {
            exchange.getResponseHeaders().set("retry-after", "5");
            respondError(exchange, 503, "UPLOAD_BUSY", "The server is receiving other files. Retry the upload later.");
            return;
        }
        try {
            synchronized (store) { guardMutation(exchange, false); }
            ManifestModels.ManifestFile file = store.upsertFile(managedPath, side == null ? "both" : side,
                exchange.getRequestBody(), () -> guardMutation(exchange, true), source);
            respondJson(exchange, 201, Map.of("file", file));
        } catch (ApiException error) {
            // A refusal before the body was read closes the socket mid-stream and panels see a raw
            // network failure. Drain a catalog-sized body first so they receive the typed error.
            try (var body = exchange.getRequestBody()) {
                long drained = 0;
                byte[] scratch = new byte[65536];
                while (drained < 64L * 1024 * 1024) {
                    int read = body.read(scratch);
                    if (read < 0) break;
                    drained += read;
                }
            } catch (IOException ignored) {
                // The client may already be gone; the typed response below is best-effort.
            }
            throw error;
        } finally {
            uploads.release();
        }
    }

    private void handleDelete(HttpExchange exchange) throws IOException {
        String managedPath = queryParam(exchange, "path");
        int removed = store.deleteFile(managedPath);
        respondJson(exchange, 200, Map.of(
            "removed", removed,
            "path", ManagedPaths.normalize(managedPath)
        ));
    }

    private void handleFileUpdate(HttpExchange exchange, byte[] body) throws IOException {
        ManifestStore.FileUpdate request = parseBody(body, ManifestStore.FileUpdate.class);
        if (request == null) {
            throw new ApiException(400, "FILE_UPDATE_BODY_REQUIRED", "File update details are required.");
        }
        respondJson(exchange, 200, Map.of("file", store.updateFile(request)));
    }

    private void handleFileRevert(HttpExchange exchange, byte[] body) throws IOException {
        FilePathRequest request = parseBody(body, FilePathRequest.class);
        if (request == null || request.path == null) {
            throw new ApiException(400, "FILE_PATH_REQUIRED", "File path is required.");
        }
        respondJson(exchange, 200, store.revertFile(request.path));
    }

    private void handlePublish(HttpExchange exchange, byte[] body) throws IOException {
        PublishRequest request = parseBody(body, PublishRequest.class);
        ManifestModels.Manifest manifest;
        // Keep the revision check and publication under the same lock as all draft edits.
        synchronized (store) {
            if (request != null && request.expectedRevision != null && !request.expectedRevision.equals(store.draftState().revision)) {
                respondError(exchange, 409, "DRAFT_STALE", "Another administrator changed the draft. Review the updated pack and confirm publication again.");
                return;
            }
            manifest = store.publish(request == null ? null : request.version);
        }
        respondJson(exchange, 200, Map.of(
            "pack", manifest.pack,
            "publishedAt", manifest.publishedAt
        ));
    }

    private void handleSettings(HttpExchange exchange, byte[] body) throws IOException {
        ManifestStore.SettingsUpdate request = parseBody(body, ManifestStore.SettingsUpdate.class);
        ManifestModels.Manifest manifest = store.updateSettings(request == null ? new ManifestStore.SettingsUpdate() : request);
        respondJson(exchange, 200, Map.of(
            "pack", manifest.pack,
            "minecraft", manifest.minecraft
        ));
    }

    private String token(HttpExchange exchange) {
        String token = firstHeader(exchange, "x-udmc-token");
        String authorization = firstHeader(exchange, "authorization");

        if ((token == null || token.isBlank()) && authorization != null && authorization.startsWith("Bearer ")) {
            token = authorization.substring("Bearer ".length());
        }

        return token;
    }

    private <T> T parseBody(HttpExchange exchange, Class<T> type) throws IOException {
        return parseBody(readBody(exchange), type);
    }

    private byte[] readBody(HttpExchange exchange) throws IOException {
        byte[] body = exchange.getRequestBody().readNBytes(65537);
        if (body.length > 65536) throw new ApiException(413, "JSON_BODY_TOO_LARGE", "JSON request body is too large.");
        return body;
    }

    private <T> T parseBody(byte[] body, Class<T> type) {
        if (body.length == 0) {
            return null;
        }

        return GSON.fromJson(new String(body, StandardCharsets.UTF_8), type);
    }

    private String queryParam(HttpExchange exchange, String key) {
        String query = exchange.getRequestURI().getRawQuery();

        if (query == null || query.isBlank()) {
            return null;
        }

        for (String pair : query.split("&")) {
            int index = pair.indexOf('=');

            if (index < 0) {
                continue;
            }

            String name = URLDecoder.decode(pair.substring(0, index), StandardCharsets.UTF_8);

            if (key.equals(name)) {
                return URLDecoder.decode(pair.substring(index + 1), StandardCharsets.UTF_8);
            }
        }

        return null;
    }

    private String firstHeader(HttpExchange exchange, String name) {
        return exchange.getRequestHeaders().getFirst(name);
    }

    private void cors(HttpExchange exchange) {
        exchange.getResponseHeaders().set("access-control-allow-origin", "*");
        exchange.getResponseHeaders().set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
        exchange.getResponseHeaders().set(
            "access-control-allow-headers",
            "authorization,content-type,x-udmc-path,x-udmc-side,x-udmc-token,x-udmc-session,x-udmc-revision,x-udmc-source"
        );
        exchange.getResponseHeaders().set("access-control-expose-headers", "x-udmc-revision");
    }

    private void respondJson(HttpExchange exchange, int status, Object payload) throws IOException {
        exchange.getResponseHeaders().set("cache-control", "no-store");
        respond(exchange, status, GSON.toJson(payload));
    }

    private void respondError(HttpExchange exchange, int status, String code, String fallback, Object... args) throws IOException {
        respondJson(exchange, status, new ApiException(status, code, fallback, args).payload());
    }

    private void respond(HttpExchange exchange, int status, String bodyText) throws IOException {
        if (status == 204) { exchange.sendResponseHeaders(status, -1); return; }
        byte[] body = bodyText.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, body.length);

        try (OutputStream output = exchange.getResponseBody()) {
            output.write(body);
        }
    }

    /**
     * The page a rejected player lands on. It is the only instruction most of them will
     * read, so it names the file, the folder and the order of steps outright, in both
     * languages, and works on a phone screen without any external resources.
     */
    private String installPage() {
        String url = escapeHtml(agents.downloadUrl());
        String pack = escapeHtml(config.packName);
        // The version is the first thing an administrator compares when a player is turned
        // away, so the page states it instead of leaving them to guess from a file date.
        String offered = "";
        try { var release = agents.release(); if (release != null) offered = release.verify(config, "client").getProperty("version", ""); }
        catch (IOException | RuntimeException error) { offered = ""; }
        String versions = escapeHtml("UDMC " + (offered.isBlank() ? "-" : offered) + " · " + config.packId);
        String loader = escapeHtml(config.loaderType.substring(0, 1).toUpperCase(Locale.ROOT) + config.loaderType.substring(1));
        String environment = escapeHtml("Minecraft " + config.minecraftVersion + " · " + loader + " " + config.loaderVersion);
        return "<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            + "<title>UDMC - установка клиента</title><style>"
            + "body{margin:0;padding:24px 16px;background:#16181d;color:#e6e8ec;font:16px/1.6 system-ui,Segoe UI,sans-serif}"
            + "main{max-width:620px;margin:0 auto}h1{margin:0 0 4px;font-size:24px}"
            + ".sub{margin:0 0 24px;color:#9aa0ab;font-size:14px}"
            + ".get{display:inline-block;margin:0 0 28px;padding:14px 22px;border-radius:10px;background:#e0431f;color:#fff;font-weight:700;text-decoration:none}"
            + "ol{margin:0;padding-left:22px}li{margin-bottom:14px}"
            + "code{padding:2px 6px;border-radius:4px;background:#242832;font-size:14px}"
            + "h2{margin:28px 0 8px;font-size:15px;color:#9aa0ab;text-transform:uppercase;letter-spacing:.06em}"
            + ".en{color:#9aa0ab;font-size:14px}.note{margin-top:28px;padding-top:16px;border-top:1px solid #2b2f39;color:#9aa0ab;font-size:14px}"
            + "</style><body><main>"
            + "<h1>UDMC</h1><p class=\"sub\">" + pack + " &middot; " + environment + "<br>" + versions + "</p>"
            + "<p><a class=\"get\" href=\"" + url + "\" download=\"udmc-sync-client.jar\">Скачать мод (udmc-sync-client.jar)</a></p>"
            + "<h2>Что делать дальше</h2><ol>"
            + "<li>Закройте Minecraft, если он запущен.</li>"
            + "<li>Откройте папку <code>mods</code> вашего игрового профиля. В стандартном лаунчере это <code>%appdata%\\.minecraft\\mods</code>, в сторонних - папка выбранной сборки.</li>"
            + "<li>Положите туда скачанный файл. Если там уже лежит старый <code>udmc-sync-client.jar</code>, замените его - двух файлов быть не должно.</li>"
            + "<li>Профиль должен быть на " + environment + ". Запустите игру и зайдите на сервер: остальные моды UDMC докачает сам.</li>"
            + "</ol>"
            + "<h2 lang=\"en\">In English</h2><ol class=\"en\" lang=\"en\">"
            + "<li>Close Minecraft.</li>"
            + "<li>Open the <code>mods</code> folder of your game profile.</li>"
            + "<li>Put the downloaded file there, replacing any older <code>udmc-sync-client.jar</code>.</li>"
            + "<li>The profile must run " + environment + ". Start the game and join: UDMC downloads the rest of the pack itself.</li>"
            + "</ol>"
            + "<p class=\"note\">Устанавливайте моды только с серверов, которым доверяете. / Install mods only from servers you trust.</p>"
            + "</main></body></html>";
    }

    private static String escapeHtml(String value) {
        return String.valueOf(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private static double calculateTps(long averageTickNanos) {
        if (averageTickNanos <= 0) {
            return 20.0;
        }

        double averageTickMs = averageTickNanos / 1_000_000.0;
        return round(Math.min(20.0, 1000.0 / averageTickMs));
    }

    private static double round(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    private static final class PublishRequest {
        public String version;
        public String expectedRevision;
    }

    private static final class CommandRequest {
        public String command;
    }

    private static final class PowerRequest {
        public Integer delaySeconds;
        public Boolean cancel;
    }

    private static final class FilePathRequest {
        public String path;
    }

    private static final class ImportRequest {
        public String path;
        public String side;
        public String sha256;
    }

    private static final class AccessRequest {
        public String id, invite, token, name, action;
    }

    private static final class PairRequest {
        public String code;
        /** A project saved from another server, put back in place of the one this one made. */
        public Map<String, Object> project;
    }
}
