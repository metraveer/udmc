package dev.udmc.sync;

import java.util.ArrayList;
import java.util.List;

public final class ManifestModels {
    private ManifestModels() {
    }

    public static final class Manifest {
        public int schemaVersion = 1;
        public long releaseSequence = 0;
        public PackInfo pack = new PackInfo();
        public MinecraftInfo minecraft = new MinecraftInfo();
        public String publishedAt = TimeUtil.nowIso();
        public List<ManifestFile> files = new ArrayList<>();
        // Private draft operations, always cleared before publishing a manifest to clients.
        public List<ManifestFile> serverRemovals = new ArrayList<>();
        // Paths leaving the pack while their file stays on the server untouched.
        public List<String> detached = new ArrayList<>();
    }

    public static final class PackInfo {
        public String id = "udmc-main";
        public String name = "UDMC Main Modpack";
        public String version = "0.1.0";
    }

    public static final class MinecraftInfo {
        public String version = PlatformDefaults.get("minecraft");
        public LoaderInfo loader = new LoaderInfo();
    }

    public static final class LoaderInfo {
        public String type = LoaderPlatform.TYPE;
        public String version = PlatformDefaults.get("loaderVersion");
    }

    public static final class ManifestFile {
        public FileSource source;
        public String path;
        public String side;
        public String sha256;
        public long size;
        public String downloadPath;
        public String updatedAt;
    }

    public static final class FileSource {
        public String provider;
        public String projectId;
        public String versionId;
        public String environment;
    }

    public static final class DraftState {
        public String revision;
        public Manifest published;
        public Manifest draft;
        public List<DraftFile> files = new ArrayList<>();
        public ChangeSummary changes = new ChangeSummary();
    }

    public static final class DraftFile {
        public FileSource source;
        public String path;
        public String side;
        public String sha256;
        public long size;
        public String downloadPath;
        public String updatedAt;
        public String change;
        public boolean serverRemoval;
        /** Leaves the pack on publish while the file itself stays on the server. */
        public boolean detached;
    }

    public static final class ChangeSummary {
        public int added;
        public int updated;
        public int removed;
        public int total;
        public boolean dirty;
        public boolean serverRestartRecommended;
    }

    public static final class ManagedState {
        public int schemaVersion = 1;
        public String managedBy = "udmc-sync";
        public String mode = "minecraft-content";
        public String packId;
        public String packVersion;
        public String syncedAt;
        public long releaseSequence;
        public List<ManagedFile> files = new ArrayList<>();
    }

    public static final class ManagedFile {
        public boolean borrowed = false;
        public String manifestPath;
        public String destPath;
        public String sha256;
    }
}
