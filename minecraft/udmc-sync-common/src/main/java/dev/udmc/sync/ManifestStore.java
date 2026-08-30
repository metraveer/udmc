package dev.udmc.sync;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.io.Reader;
import java.io.InputStream;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.nio.file.LinkOption;

public final class ManifestStore {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    static final long MAX_UPLOAD_BYTES = 512L * 1024 * 1024;

    private final Path gameDir;
    private final Path rootDir;
    private final Path blobsDir;
    private final Path manifestPath;
    private final Path draftPath;
    private final UdmcConfig config;

    public ManifestStore(Path gameDir, UdmcConfig config) {
        this.gameDir = gameDir;
        this.rootDir = gameDir.resolve("udmc-sync");
        this.blobsDir = rootDir.resolve("blobs");
        this.manifestPath = rootDir.resolve("manifest.json");
        this.draftPath = rootDir.resolve("draft.json");
        this.config = config;
    }

    public synchronized ManifestModels.Manifest load() throws IOException {
        return loadPublished();
    }

    public synchronized ManifestModels.Manifest loadPublished() throws IOException {
        ensure();

        if (!Files.exists(manifestPath)) {
            ManifestModels.Manifest manifest = defaultManifest();
            savePublished(manifest);
            return manifest;
        }

        return readManifest(manifestPath);
    }

    public synchronized ManifestModels.Manifest loadDraft() throws IOException {
        ensure();

        if (!Files.exists(draftPath)) {
            ManifestModels.Manifest draft = copy(loadPublished());
            saveDraft(draft);
            return draft;
        }

        return readManifest(draftPath);
    }

    public synchronized ManifestModels.DraftState draftState() throws IOException {
        return buildDraftState(loadPublished(), loadDraft());
    }

    public ManifestModels.ManifestFile upsertFile(String managedPath, String side, byte[] body) throws IOException {
        return upsertFile(managedPath, side, new ByteArrayInputStream(body));
    }

    public ManifestModels.ManifestFile upsertFile(String managedPath, String side, InputStream body) throws IOException {
        return upsertFile(managedPath, side, body, () -> {});
    }

    @FunctionalInterface
    public interface CommitCheck { void run() throws IOException; }

    public ManifestModels.ManifestFile upsertFile(String managedPath, String side, InputStream body, CommitCheck check) throws IOException {
        return stageUpload(managedPath, side, body, null, check, null);
    }

    public ManifestModels.ManifestFile upsertFile(String managedPath, String side, InputStream body, CommitCheck check, ManifestModels.FileSource source) throws IOException {
        if (source != null && !validSource(source)) {
            throw new ApiException(400, "CATALOG_SOURCE_INVALID", "Invalid catalog source metadata.");
        }
        return stageUpload(managedPath, side, body, null, check, source);
    }

    private static boolean validSource(ManifestModels.FileSource source) {
        if (source.projectId == null || source.versionId == null || source.environment == null) return false;
        if ("github".equals(source.provider)) return source.projectId.matches("[a-zA-Z0-9-]{1,39}/[a-zA-Z0-9_.-]{1,100}")
            && !source.projectId.endsWith("/.") && !source.projectId.endsWith("/..") && source.versionId.matches("[1-9][0-9]{0,19}")
            && List.of("client_only", "server_only", "jar_universal", "manual").contains(source.environment);
        if ("curseforge".equals(source.provider)) return source.projectId.matches("[1-9][0-9]{0,19}")
            && source.versionId.matches("[1-9][0-9]{0,19}")
            && List.of("client_only", "server_only", "jar_universal", "manual").contains(source.environment);
        return "modrinth".equals(source.provider) && source.projectId.matches("[a-zA-Z0-9_-]{1,128}")
            && source.versionId.matches("[a-zA-Z0-9_-]{1,128}")
            && List.of("client_only", "server_only", "dedicated_server_only", "client_and_server", "client_only_server_optional",
                "server_only_client_optional", "client_or_server", "client_or_server_prefers_both", "legacy_optional").contains(source.environment);
    }

    private ManifestModels.ManifestFile stageUpload(String managedPath, String side, InputStream body, String expectedHash, CommitCheck check, ManifestModels.FileSource source) throws IOException {
        String normalizedPath = ManagedPaths.normalize(managedPath);
        String normalizedSide = ManagedPaths.requireSide(side);
        ensure();
        // Slow transfers stay outside the store lock and outside public blob storage.
        Path staged = Files.createTempFile(rootDir, "upload-", ".tmp");
        try {
            try (var output = Files.newOutputStream(staged)) {
                byte[] buffer = new byte[64 * 1024];
                long size = 0;
                int count;
                while ((count = body.read(buffer)) != -1) {
                    size += count;
                    if (size > MAX_UPLOAD_BYTES) throw new UploadTooLarge();
                    output.write(buffer, 0, count);
                }
            }
            if (AgentFiles.isAgent(staged)) throw new ApiException(400, "UDMC_AGENT_PACK_FORBIDDEN", "UDMC agents cannot be distributed through the modpack. Export a client JAR from Control.");
            String sha256 = Hashes.sha256(staged);
            if (expectedHash != null && !Objects.equals(expectedHash, sha256)) {
                throw new ApiException(409, "SERVER_FILE_CHANGED", "Server file changed. Refresh the inventory before importing.");
            }
            synchronized (this) {
                check.run();
                return commitUpload(normalizedPath, normalizedSide, staged, sha256, source);
            }
        } finally {
            Files.deleteIfExists(staged);
        }
    }

    private synchronized ManifestModels.ManifestFile commitUpload(String normalizedPath, String normalizedSide, Path staged, String sha256, ManifestModels.FileSource source) throws IOException {
        ManifestModels.Manifest draft = loadDraft();
        assertUniquePath(draft, normalizedPath, normalizedPath);
        assertNotPendingRemoval(draft, normalizedPath);
        String blobName = sha256 + ManagedPaths.safeExtension(normalizedPath);
        long size = Files.size(staged);
        try {
            Files.move(staged, blobsDir.resolve(blobName), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(staged, blobsDir.resolve(blobName), StandardCopyOption.REPLACE_EXISTING);
        }
        draft.files.removeIf(file -> Objects.equals(file.path, normalizedPath));

        ManifestModels.ManifestFile entry = new ManifestModels.ManifestFile();
        entry.source = source;
        entry.path = normalizedPath;
        entry.side = normalizedSide;
        entry.sha256 = sha256;
        entry.size = size;
        entry.downloadPath = "/files/" + blobName;
        entry.updatedAt = TimeUtil.nowIso();
        draft.files.add(entry);
        saveDraft(draft);
        return entry;
    }

    public synchronized int deleteFile(String managedPath) throws IOException {
        String normalizedPath = ManagedPaths.normalize(managedPath);
        ManifestModels.Manifest draft = loadDraft();
        int before = draft.files.size();
        draft.files.removeIf(file -> Objects.equals(file.path, normalizedPath));
        saveDraft(draft);
        return before - draft.files.size();
    }

    public synchronized ManifestModels.ManifestFile updateFile(FileUpdate update) throws IOException {
        String currentPath = ManagedPaths.normalize(update.path);
        String nextPath = ManagedPaths.normalize(update.newPath == null ? currentPath : update.newPath);
        String nextSide = ManagedPaths.requireSide(update.side);
        ManifestModels.Manifest draft = loadDraft();
        ManifestModels.ManifestFile existing = find(draft, currentPath);

        if (existing == null) {
            throw new ApiException(404, "DRAFT_FILE_NOT_FOUND", "Draft file not found: " + currentPath, currentPath);
        }

        assertUniquePath(draft, nextPath, currentPath);
        assertNotPendingRemoval(draft, nextPath);
        if (!currentPath.equals(nextPath) && currentPath.equalsIgnoreCase(nextPath)) {
            throw new ApiException(409, "DRAFT_PATH_EXISTS", "A draft file already uses path: " + nextPath, nextPath);
        }

        existing.path = nextPath;
        existing.side = nextSide;
        existing.updatedAt = TimeUtil.nowIso();
        saveDraft(draft);
        return existing;
    }

    public synchronized ManifestModels.DraftState revertFile(String managedPath) throws IOException {
        String normalizedPath = ManagedPaths.normalize(managedPath);
        ManifestModels.Manifest published = loadPublished();
        ManifestModels.Manifest draft = loadDraft();
        ManifestModels.ManifestFile publishedFile = find(published, normalizedPath);

        draft.serverRemovals.removeIf(file -> Objects.equals(file.path, normalizedPath));
        draft.detached.remove(normalizedPath);
        draft.files.removeIf(file -> Objects.equals(file.path, normalizedPath));
        if (publishedFile != null) {
            draft.files.add(copy(publishedFile));
        }

        saveDraft(draft);
        return buildDraftState(published, draft);
    }

    public synchronized ManifestModels.DraftState resetDraft() throws IOException {
        ManifestModels.Manifest published = loadPublished();
        ManifestModels.Manifest draft = copy(published);
        saveDraft(draft);
        return buildDraftState(published, draft);
    }

    public synchronized ManifestModels.Manifest publish(String version) throws IOException {
        ManifestModels.Manifest published = loadPublished();
        ManifestModels.Manifest draft = loadDraft();
        ManifestModels.DraftState state = buildDraftState(published, draft);

        if (!state.changes.dirty) {
            throw new ApiException(409, "DRAFT_NO_CHANGES", "Draft has no changes.");
        }

        validateDraftBlobs(draft);
        validateServerRemovals(draft);
        validateDraftMods(published, draft);
        String nextVersion = version == null || version.isBlank() ? bumpPatch(published.pack.version) : version.trim();
        if (!nextVersion.matches("^[A-Za-z0-9][A-Za-z0-9._+\\-]{0,63}$")) {
            throw new ApiException(400, "PACK_VERSION_INVALID", "Invalid pack version.");
        }

        ManifestModels.Manifest nextPublished = copy(draft);
        nextPublished.serverRemovals.clear();
        nextPublished.detached.clear();
        nextPublished.pack.version = nextVersion;
        nextPublished.publishedAt = TimeUtil.nowIso();
        nextPublished.releaseSequence = Math.addExact(published.releaseSequence, 1);
        ServerBackups backups = captureServerBackups(published, draft);
        String previousConfigVersion = config.packVersion;
        boolean preserveBackups = false;

        try {
            applyServerChanges(published, draft);
            savePublished(nextPublished);
            saveDraft(copy(nextPublished));
            config.packVersion = nextPublished.pack.version;
            config.save(gameDir);
            preserveBackups = !draft.serverRemovals.isEmpty();
            return nextPublished;
        } catch (IOException | RuntimeException error) {
            restoreServerBackups(backups, error);
            restoreManifestState(published, draft, previousConfigVersion, error);
            preserveBackups = error.getSuppressed().length > 0;
            throw error;
        } finally {
            if (!preserveBackups) {
                cleanupBackups(backups.directory());
            }
        }
    }

    public synchronized ManifestModels.Manifest syncRuntimeMetadata() throws IOException {
        ManifestModels.Manifest published = loadPublished();
        ManifestModels.Manifest draft = loadDraft();
        applyRuntimeMetadata(published);
        applyRuntimeMetadata(draft);
        savePublished(published);
        saveDraft(draft);
        return published;
    }

    public synchronized ManifestModels.Manifest updateSettings(SettingsUpdate update) throws IOException {
        ManifestModels.Manifest published = loadPublished();
        ManifestModels.Manifest draft = loadDraft();

        if (update.packName != null && !update.packName.isBlank()) {
            published.pack.name = update.packName.trim();
            draft.pack.name = published.pack.name;
            config.packName = published.pack.name;
        }

        if (update.allowRemotePowerActions != null) {
            config.allowRemotePowerActions = update.allowRemotePowerActions;
        }

        config.save(gameDir);
        savePublished(published);
        saveDraft(draft);
        return published;
    }

    public Path blobPath(String blobName) {
        if (!blobName.matches("^[a-f0-9]{64}(\\.[A-Za-z0-9_-]{1,16})?$")) {
            throw new ApiException(400, "FILE_BLOB_INVALID", "Invalid file identifier.");
        }

        return blobsDir.resolve(blobName);
    }

    public synchronized Map<String, Object> inventory() throws IOException {
        var draft = loadDraft();
        var published = loadPublished();
        List<Map<String, Object>> files = new ArrayList<>();
        boolean truncated = false;
        for (String root : List.of("mods", "config", "resourcepacks", "shaderpacks")) {
            Path directory = gameDir.resolve(root);
            if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) continue;
            try (var paths = Files.walk(directory, 12)) {
                var iterator = paths.iterator();
                while (iterator.hasNext()) {
                    Path path = iterator.next();
                    if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) continue;
                    String relative = gameDir.toAbsolutePath().normalize().relativize(path.toAbsolutePath().normalize()).toString().replace('\\', '/');
                    try { ManagedPaths.resolve(gameDir, relative); } catch (IllegalArgumentException ignored) { continue; }
                    if (find(draft, relative) != null || find(published, relative) != null || Files.size(path) > 512L * 1024 * 1024) continue;
                    if (AgentFiles.isAgent(path)) continue;
                    if (files.size() >= 1000) { truncated = true; break; }
                    files.add(Map.of("path", relative, "size", Files.size(path), "sha256", Hashes.sha256(path),
                        "removalPending", draft.serverRemovals.stream().anyMatch(file -> file.path.equals(relative))));
                }
            }
            if (truncated) break;
        }
        return Map.of("files", files, "truncated", truncated);
    }

    public synchronized ManifestModels.ManifestFile importServerFile(String managedPath, String side, String expectedHash) throws IOException {
        Path path = ManagedPaths.resolve(gameDir, managedPath);
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) > 512L * 1024 * 1024) {
            throw new ApiException(404, "SERVER_FILE_MISSING_OR_LARGE", "Server file is missing or too large.");
        }
        if (expectedHash == null || !expectedHash.matches("[a-f0-9]{64}")) {
            throw new ApiException(409, "SERVER_FILE_CHANGED", "Server file changed. Refresh the inventory before importing.");
        }
        if (find(loadDraft(), ManagedPaths.normalize(managedPath)) != null) {
            throw new ApiException(409, "FILE_ALREADY_MANAGED", "This file is already managed by the modpack.");
        }
        try (var input = Files.newInputStream(path)) {
            return stageUpload(managedPath, side, input, expectedHash, () -> {}, null);
        }
    }

    public synchronized ManifestModels.DraftState removeServerFile(String managedPath, String expectedHash) throws IOException {
        String normalized = ManagedPaths.normalize(managedPath);
        var draft = loadDraft();
        if (find(draft, normalized) != null || find(loadPublished(), normalized) != null) {
            throw new ApiException(409, "FILE_MANAGED_USE_DRAFT", "This file is managed. Remove it from the modpack instead.");
        }
        assertNotPendingRemoval(draft, normalized);
        var entry = new ManifestModels.ManifestFile();
        entry.path = normalized; entry.sha256 = expectedHash; entry.side = "server";
        Path target = checkedServerRemoval(entry);
        entry.size = Files.size(target); entry.updatedAt = TimeUtil.nowIso();
        draft.serverRemovals.add(entry);
        saveDraft(draft);
        return draftState();
    }

    /** Takes a managed file out of the pack and leaves it on the server as an ordinary file. */
    public synchronized ManifestModels.DraftState detachFile(String managedPath) throws IOException {
        String normalized = ManagedPaths.normalize(managedPath);
        var draft = loadDraft();
        var published = loadPublished();
        var entry = find(draft, normalized);
        if (entry == null) entry = find(published, normalized);
        if (entry == null) throw new ApiException(404, "FILE_NOT_IN_PACK", "This file is not part of the modpack.");
        // Players delete managed files that leave the manifest, so detaching a file they
        // received would remove it from their game: only server-side files can stay behind.
        if (!"server".equals(entry.side)) {
            throw new ApiException(409, "DETACH_SERVER_SIDE_ONLY",
                "Only server-side files can leave the modpack without being deleted. Set the file to \"Server only\", publish, then detach it.");
        }
        assertNotPendingRemoval(draft, normalized);
        draft.files.removeIf(file -> Objects.equals(file.path, normalized));
        if (!draft.detached.contains(normalized)) draft.detached.add(normalized);
        saveDraft(draft);
        return buildDraftState(published, draft);
    }

    private void validateServerRemovals(ManifestModels.Manifest draft) throws IOException {
        for (var file : draft.serverRemovals) checkedServerRemoval(file);
    }

    private Path checkedServerRemoval(ManifestModels.ManifestFile file) throws IOException {
        Path target = ManagedPaths.resolve(gameDir, file.path);
        if (file.sha256 == null || !file.sha256.matches("[a-f0-9]{64}") || !Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)
            || Files.size(target) > MAX_UPLOAD_BYTES || !file.sha256.equals(Hashes.sha256(target))) {
            throw new ApiException(409, "SERVER_FILE_CHANGED_OR_MISSING", "Server file changed or is missing. Refresh and confirm the exact file again: " + file.path, file.path);
        }
        if (AgentFiles.isAgent(target)) throw new ApiException(400, "UDMC_AGENT_REMOVE_FORBIDDEN", "The UDMC agent cannot be removed through the modpack.");
        return target;
    }

    private static void assertNotPendingRemoval(ManifestModels.Manifest draft, String path) {
        if (draft.serverRemovals.stream().anyMatch(file -> file.path.equalsIgnoreCase(path))) {
            throw new ApiException(409, "SERVER_FILE_REMOVAL_PENDING", "Cancel the pending server file removal first: " + path, path);
        }
    }

    private ManifestModels.Manifest defaultManifest() {
        ManifestModels.Manifest manifest = new ManifestModels.Manifest();
        manifest.pack.id = config.packId;
        manifest.pack.name = config.packName;
        manifest.pack.version = config.packVersion;
        manifest.minecraft.version = config.minecraftVersion;
        manifest.minecraft.loader.type = config.loaderType;
        manifest.minecraft.loader.version = config.loaderVersion;
        manifest.publishedAt = TimeUtil.nowIso();
        return manifest;
    }

    private ManifestModels.Manifest readManifest(Path path) throws IOException {
        try (Reader reader = Files.newBufferedReader(path)) {
            ManifestModels.Manifest manifest = GSON.fromJson(reader, ManifestModels.Manifest.class);
            if (manifest == null) {
                throw new IOException("Manifest is empty: " + path);
            }
            if (manifest.files == null) {
                manifest.files = new ArrayList<>();
            }
            if (manifest.serverRemovals == null) manifest.serverRemovals = new ArrayList<>();
            if (manifest.detached == null) manifest.detached = new ArrayList<>();
            return manifest;
        }
    }

    private void savePublished(ManifestModels.Manifest manifest) throws IOException {
        saveManifest(manifestPath, manifest);
    }

    private void saveDraft(ManifestModels.Manifest manifest) throws IOException {
        saveManifest(draftPath, manifest);
    }

    private void saveManifest(Path path, ManifestModels.Manifest manifest) throws IOException {
        ensure();
        manifest.files.sort(Comparator.comparing(file -> file.path));
        Path temporary = path.resolveSibling(path.getFileName() + ".tmp");
        Files.writeString(temporary, GSON.toJson(manifest) + System.lineSeparator(), StandardCharsets.UTF_8);

        try {
            Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private ManifestModels.DraftState buildDraftState(
        ManifestModels.Manifest published,
        ManifestModels.Manifest draft
    ) {
        ManifestModels.DraftState state = new ManifestModels.DraftState();
        state.revision = Hashes.sha256(GSON.toJson(draft).getBytes(StandardCharsets.UTF_8));
        state.published = published;
        state.draft = draft;
        Map<String, ManifestModels.ManifestFile> publishedFiles = indexByPath(published);
        Map<String, ManifestModels.ManifestFile> draftFiles = indexByPath(draft);
        List<String> paths = new ArrayList<>();
        paths.addAll(publishedFiles.keySet());
        draftFiles.keySet().stream().filter(path -> !publishedFiles.containsKey(path)).forEach(paths::add);
        paths.sort(String::compareTo);

        for (String path : paths) {
            ManifestModels.ManifestFile publishedFile = publishedFiles.get(path);
            ManifestModels.ManifestFile draftFile = draftFiles.get(path);
            String change;
            ManifestModels.ManifestFile source;

            if (publishedFile == null) {
                change = "added";
                source = draftFile;
                state.changes.added++;
            } else if (draftFile == null) {
                change = "removed";
                source = publishedFile;
                state.changes.removed++;
            } else if (!sameFile(publishedFile, draftFile)) {
                change = "updated";
                source = draftFile;
                state.changes.updated++;
            } else {
                change = "unchanged";
                source = draftFile;
            }

            var row = toDraftFile(source, change);
            if (change.equals("removed") && draft.detached.contains(path)) row.detached = true;
            state.files.add(row);
            if (!sameContent(publishedFile, draftFile) && ManagedPaths.neededFor(source.side, "server")) {
                state.changes.serverRestartRecommended = true;
            }
            if (!sameContent(publishedFile, draftFile) && neededForServer(publishedFile)) {
                state.changes.serverRestartRecommended = true;
            }
        }

        for (var file : draft.serverRemovals) {
            var row = toDraftFile(file, "removed"); row.serverRemoval = true;
            state.files.add(row); state.changes.removed++; state.changes.serverRestartRecommended = true;
        }
        state.changes.total = state.changes.added + state.changes.updated + state.changes.removed;
        state.changes.dirty = state.changes.total > 0;
        return state;
    }

    private void validateDraftMods(ManifestModels.Manifest published, ManifestModels.Manifest draft) throws IOException {
        var issues = inspectMods(published, draft, false);
        if (issues.isEmpty()) return;
        // An invalid composition is an expected, fixable refusal: it must reach panels as a stable code, not a 500.
        throw new ApiException(409, "PUBLISH_BLOCKED_BY_VALIDATION",
            "Publication was refused: the composition check found " + issues.size() + " problem(s). Review the validation tab.\n"
                + String.join("\n", issues.stream().limit(30)
                    .map(issue -> "[" + issue.get("side") + "] " + issue.get("message")).toList()),
            issues.size());
    }

    public synchronized Map<String, Object> validation(boolean installed) throws IOException {
        var draft = loadDraft();
        var issues = inspectMods(loadPublished(), draft, installed);
        if (!installed) {
            try { validateDraftBlobs(draft); validateServerRemovals(draft); }
            catch (ApiException error) {
                issues.add(Map.of("side", "server", "code", error.code, "args", error.args, "message", error.getMessage()));
            } catch (IOException | IllegalArgumentException error) {
                UdmcSync.LOGGER.warn("Could not verify the UDMC draft files", error);
                issues.add(Map.of("side", "server", "code", "DRAFT_VALIDATION_FAILED", "args", List.of(),
                    "message", "The draft files could not be verified. Check the server log and retry."));
            }
        }
        return Map.of("target", installed ? "server" : "draft", "revision", draftState().revision,
            "ok", issues.isEmpty(), "issues", issues, "checkedAt", TimeUtil.nowIso());
    }

    private List<Map<String, Object>> inspectMods(ManifestModels.Manifest published, ManifestModels.Manifest draft, boolean installed) throws IOException {
        List<Map<String, Object>> issues = new ArrayList<>();
        for (String side : List.of("client", "server")) {
            if (installed && side.equals("client")) continue;
            List<ModMetadata.Mod> mods = new ArrayList<>();
            for (var file : installed ? List.<ManifestModels.ManifestFile>of() : draft.files) {
                if (!file.path.startsWith("mods/") || !file.path.toLowerCase(java.util.Locale.ROOT).endsWith(".jar") || !ManagedPaths.neededFor(file.side, side)) continue;
                inspectMod(blobPath(file.downloadPath.replaceFirst("^/files/", "")), file.path, side, mods, issues);
            }
            if (side.equals("server")) {
                var oldFiles = indexByPath(published);
                var nextFiles = indexByPath(draft);
                Path directory = ManagedPaths.resolve(gameDir, "mods/.udmc-scan").getParent();
                if (Files.isDirectory(directory)) try (var paths = Files.walk(directory, 8)) {
                    var jars = paths.filter(p -> Files.isRegularFile(p, java.nio.file.LinkOption.NOFOLLOW_LINKS)
                        && p.getFileName().toString().toLowerCase(java.util.Locale.ROOT).endsWith(".jar")).limit(2001).toList();
                    if (jars.size() > 2000) throw new IOException("Too many server mods to inspect");
                    for (Path path : jars) {
                        String relative = gameDir.relativize(path).toString().replace('\\', '/');
                        ManagedPaths.resolve(gameDir, relative);
                        if (AgentFiles.isAgent(path)) continue;
                        String hash = Hashes.sha256(path);
                        var old = installed ? null : oldFiles.get(relative);
                        var next = installed ? null : nextFiles.get(relative);
                        if (!installed && draft.serverRemovals.stream().anyMatch(file -> file.path.equals(relative) && file.sha256.equals(hash))) continue;
                        if (neededForServer(old) && hash.equals(old.sha256)) continue;
                        if (neededForServer(next)) {
                            if (!hash.equals(next.sha256)) issues.add(Messages.of("udmc_sync.diagnostic.overwrite", relative).issue(side));
                            continue;
                        }
                        // Loaders only read jars directly in mods/. Nested directories such as
                        // mods/luckperms/libs hold mod-owned libraries and are not mods to inspect.
                        if (!directory.equals(path.getParent())) continue;
                        inspectMod(path, relative, side, mods, issues);
                    }
                }
            }
            for (var problem : ModMetadata.diagnostics(mods, side, config)) issues.add(problem.detail().issue(side));
        }
        return issues;
    }

    private static void inspectMod(Path path, String display, String side, List<ModMetadata.Mod> mods, List<Map<String, Object>> issues) {
        try {
            var metadata = ModMetadata.read(path, display);
            for (var mod : metadata) if (!mod.nested() && !mod.environment().equals("*") && !mod.environment().equals(side)) {
                issues.add(Messages.of("udmc_sync.diagnostic.side", display, side, mod.environment()).issue(side));
            }
            mods.addAll(metadata);
        } catch (IOException | IllegalArgumentException error) {
            issues.add(Messages.of("udmc_sync.diagnostic.inspect", display, error.getMessage()).issue(side));
        }
    }

    private void validateDraftBlobs(ManifestModels.Manifest draft) throws IOException {
        for (ManifestModels.ManifestFile file : draft.files) {
            String blobName = file.downloadPath == null ? "" : file.downloadPath.replaceFirst("^/files/", "");
            Path blob = blobPath(blobName);
            if (!Files.isRegularFile(blob)) {
                throw new ApiException(409, "DRAFT_BLOB_MISSING", "Draft data is missing for " + file.path, file.path);
            }
            if (!Objects.equals(Hashes.sha256(blob), file.sha256)) {
                throw new ApiException(409, "DRAFT_BLOB_HASH_MISMATCH", "Draft data hash mismatch for " + file.path, file.path);
            }
        }
    }

    private ServerBackups captureServerBackups(
        ManifestModels.Manifest published,
        ManifestModels.Manifest draft
    ) throws IOException {
        Map<Path, Path> backups = new LinkedHashMap<>();
        Path directory = Files.createTempDirectory(rootDir, "publish-backup-");
        Map<String, ManifestModels.ManifestFile> oldFiles = indexByPath(published);
        Map<String, ManifestModels.ManifestFile> newFiles = indexByPath(draft);

        try {
            for (String path : changedPaths(oldFiles, newFiles)) {
                ManifestModels.ManifestFile oldFile = oldFiles.get(path);
                ManifestModels.ManifestFile newFile = newFiles.get(path);
                if (neededForServer(oldFile) || neededForServer(newFile)) {
                    Path target = ManagedPaths.resolve(gameDir, path);
                    Path backup = null;
                    if (Files.exists(target)) {
                        if (!Files.isRegularFile(target)) {
                            throw new IOException("Server path is not a file: " + path);
                        }
                        backup = directory.resolve(path);
                        Files.createDirectories(backup.getParent());
                        Files.copy(target, backup);
                    }
                    backups.put(target, backup);
                }
            }
            for (var file : draft.serverRemovals) {
                Path target = checkedServerRemoval(file);
                Path backup = directory.resolve(file.path);
                Files.createDirectories(backup.getParent()); Files.copy(target, backup);
                backups.put(target, backup);
            }
            return new ServerBackups(directory, backups);
        } catch (IOException | RuntimeException error) {
            cleanupBackups(directory);
            throw error;
        }
    }

    private void applyServerChanges(
        ManifestModels.Manifest published,
        ManifestModels.Manifest draft
    ) throws IOException {
        Map<String, ManifestModels.ManifestFile> oldFiles = indexByPath(published);
        Map<String, ManifestModels.ManifestFile> newFiles = indexByPath(draft);
        List<String> changedPaths = changedPaths(oldFiles, newFiles);

        for (var file : draft.serverRemovals) Files.delete(checkedServerRemoval(file));
        for (String path : changedPaths) {
            ManifestModels.ManifestFile oldFile = oldFiles.get(path);
            ManifestModels.ManifestFile newFile = newFiles.get(path);
            // A detached path leaves the pack but keeps its file: never delete it here.
            if (draft.detached.contains(path)) continue;
            if (neededForServer(oldFile) && !neededForServer(newFile)) {
                removeManagedServerFile(oldFile);
            }
        }

        for (String path : changedPaths) {
            ManifestModels.ManifestFile oldFile = oldFiles.get(path);
            ManifestModels.ManifestFile newFile = newFiles.get(path);
            if (neededForServer(newFile) && !sameContent(oldFile, newFile)) {
                Path target = ManagedPaths.resolve(gameDir, path);
                if (Files.exists(target)) {
                    String currentHash = Hashes.sha256(target);
                    if (!Objects.equals(currentHash, newFile.sha256)
                        && (!neededForServer(oldFile) || !Objects.equals(currentHash, oldFile.sha256))) {
                        throw new IOException("Local server file would be overwritten: " + path);
                    }
                }
                String blobName = newFile.downloadPath.replaceFirst("^/files/", "");
                writeManagedServerFile(path, blobPath(blobName));
            }
        }
    }

    private void restoreServerBackups(ServerBackups backups, Exception original) {
        for (Map.Entry<Path, Path> backup : backups.files().entrySet()) {
            try {
                if (backup.getValue() == null) {
                    Files.deleteIfExists(backup.getKey());
                } else {
                    Files.createDirectories(backup.getKey().getParent());
                    Files.copy(backup.getValue(), backup.getKey(), StandardCopyOption.REPLACE_EXISTING);
                }
            } catch (IOException restoreError) {
                original.addSuppressed(restoreError);
            }
        }
    }

    private void restoreManifestState(
        ManifestModels.Manifest published,
        ManifestModels.Manifest draft,
        String previousConfigVersion,
        Exception original
    ) {
        try {
            savePublished(published);
            saveDraft(draft);
            config.packVersion = previousConfigVersion;
            config.save(gameDir);
        } catch (IOException | RuntimeException restoreError) {
            original.addSuppressed(restoreError);
        }
    }

    private void cleanupBackups(Path directory) {
        try (var paths = Files.walk(directory)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        } catch (IOException error) {
            UdmcSync.LOGGER.warn("Could not clean publication backups at {}", directory, error);
        }
    }

    private void applyRuntimeMetadata(ManifestModels.Manifest manifest) {
        manifest.minecraft.version = config.minecraftVersion;
        manifest.minecraft.loader.type = config.loaderType;
        manifest.minecraft.loader.version = config.loaderVersion;
    }

    private void writeManagedServerFile(String managedPath, Path source) throws IOException {
        Path target = ManagedPaths.resolve(gameDir, managedPath);
        Files.createDirectories(target.getParent());
        Files.copy(source, target, StandardCopyOption.REPLACE_EXISTING);
        UdmcSync.LOGGER.warn("Updated server-side managed file {}. Restart may be required.", target);
    }

    private void removeManagedServerFile(ManifestModels.ManifestFile file) throws IOException {
        Path target = ManagedPaths.resolve(gameDir, file.path);

        if (!Files.exists(target)) {
            return;
        }

        String currentHash = Hashes.sha256(target);
        if (!Objects.equals(currentHash, file.sha256)) {
            UdmcSync.LOGGER.warn("Keeping modified server file {} while removing it from the manifest.", target);
            return;
        }

        Files.delete(target);
        UdmcSync.LOGGER.warn("Removed server-side managed file {}. Restart may be required.", target);
    }

    private void ensure() throws IOException {
        Files.createDirectories(blobsDir);
    }

    private static List<String> changedPaths(
        Map<String, ManifestModels.ManifestFile> oldFiles,
        Map<String, ManifestModels.ManifestFile> newFiles
    ) {
        List<String> paths = new ArrayList<>();
        paths.addAll(oldFiles.keySet());
        newFiles.keySet().stream().filter(path -> !oldFiles.containsKey(path)).forEach(paths::add);
        return paths.stream().filter(path -> !sameContent(oldFiles.get(path), newFiles.get(path))).sorted().toList();
    }

    private static Map<String, ManifestModels.ManifestFile> indexByPath(ManifestModels.Manifest manifest) {
        Map<String, ManifestModels.ManifestFile> result = new HashMap<>();
        for (ManifestModels.ManifestFile file : manifest.files) {
            result.put(file.path, file);
        }
        return result;
    }

    private static ManifestModels.ManifestFile find(ManifestModels.Manifest manifest, String path) {
        return manifest.files.stream().filter(file -> Objects.equals(file.path, path)).findFirst().orElse(null);
    }

    private static void assertUniquePath(ManifestModels.Manifest manifest, String path, String currentPath) {
        if (manifest.files.stream().anyMatch(file -> !file.path.equals(currentPath) && file.path.equalsIgnoreCase(path))) {
            throw new ApiException(409, "DRAFT_PATH_EXISTS", "A draft file already uses path: " + path, path);
        }
    }

    private record ServerBackups(Path directory, Map<Path, Path> files) {
    }

    private static boolean neededForServer(ManifestModels.ManifestFile file) {
        return file != null && ManagedPaths.neededFor(file.side, "server");
    }

    private static boolean sameFile(ManifestModels.ManifestFile left, ManifestModels.ManifestFile right) {
        return sameContent(left, right) && (left == null || GSON.toJsonTree(left.source).equals(GSON.toJsonTree(right.source)));
    }

    private static boolean sameContent(ManifestModels.ManifestFile left, ManifestModels.ManifestFile right) {
        if (left == null || right == null) {
            return left == right;
        }
        return Objects.equals(left.path, right.path)
            && Objects.equals(left.side, right.side)
            && Objects.equals(left.sha256, right.sha256)
            && left.size == right.size
            && Objects.equals(left.downloadPath, right.downloadPath);
    }

    private static ManifestModels.Manifest copy(ManifestModels.Manifest manifest) {
        return GSON.fromJson(GSON.toJson(manifest), ManifestModels.Manifest.class);
    }

    private static ManifestModels.ManifestFile copy(ManifestModels.ManifestFile file) {
        return GSON.fromJson(GSON.toJson(file), ManifestModels.ManifestFile.class);
    }

    private static ManifestModels.DraftFile toDraftFile(ManifestModels.ManifestFile file, String change) {
        ManifestModels.DraftFile result = new ManifestModels.DraftFile();
        result.source = file.source;
        result.path = file.path;
        result.side = file.side;
        result.sha256 = file.sha256;
        result.size = file.size;
        result.downloadPath = file.downloadPath;
        result.updatedAt = file.updatedAt;
        result.change = change;
        return result;
    }

    private static String bumpPatch(String version) {
        String[] pieces = String.valueOf(version).split("\\.");

        if (pieces.length >= 3) {
            try {
                int patch = Integer.parseInt(pieces[2]);
                return pieces[0] + "." + pieces[1] + "." + (patch + 1);
            } catch (NumberFormatException ignored) {
            }
        }

        return version + ".1";
    }

    public static final class SettingsUpdate {
        public String packName;
        public Boolean allowRemotePowerActions;
    }

    static final class UploadTooLarge extends IOException {
        UploadTooLarge() { super("File is larger than 512 MiB."); }
    }

    public static final class FileUpdate {
        public String path;
        public String newPath;
        public String side;
    }
}
