package dev.udmc.sync;

import java.nio.file.Path;
import java.nio.file.Files;
import java.util.List;
import java.util.Set;

public final class ManagedPaths {
    private static final List<String> ALLOWED_ROOTS = List.of("mods/", "config/", "resourcepacks/", "shaderpacks/");
    private static final Set<String> VALID_SIDES = Set.of("client", "server", "both");

    private ManagedPaths() {
    }

    public static String normalize(String rawPath) {
        String path = rawPath == null ? "" : rawPath.trim().replace('\\', '/');

        if (path.isEmpty()) {
            throw new ApiException(400, "MANAGED_PATH_REQUIRED", "Managed path is required.");
        }

        if (path.startsWith("/") || path.contains("\0") || path.matches("^[A-Za-z]:.*")) {
            throw new ApiException(400, "MANAGED_PATH_RELATIVE", "Managed path must be relative: " + rawPath, rawPath);
        }

        if (!ALLOWED_ROOTS.stream().anyMatch(path::startsWith)) {
            throw new ApiException(400, "MANAGED_PATH_ROOT", "Managed path must start with mods/, config/, resourcepacks/, or shaderpacks/.");
        }

        for (String part : path.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")
                || part.matches(".*[<>:\"|?*\\x00-\\x1f].*")
                || part.endsWith(".") || part.endsWith(" ")
                || part.matches("(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?$")) {
                throw new ApiException(400, "MANAGED_PATH_UNSAFE", "Unsafe managed path: " + rawPath, rawPath);
            }
        }

        if (path.equalsIgnoreCase("config/udmc-sync.json") || path.endsWith("/.udmc-managed.json")) {
            throw new ApiException(400, "UDMC_SERVICE_FILE", "UDMC service files cannot be distributed.");
        }

        return path;
    }

    public static Path resolve(Path gameDir, String managedPath) {
        return resolveValidated(gameDir, normalize(managedPath));
    }

    static Path internal(Path gameDir, String relative) {
        String validated = normalize("config/" + relative).substring("config/".length());
        return resolveValidated(gameDir, "udmc-sync/" + validated);
    }

    private static Path resolveValidated(Path gameDir, String managedPath) {
        Path result = gameDir;

        for (String part : managedPath.split("/")) {
            result = result.resolve(part);
            if (Files.isSymbolicLink(result)) {
                throw new ApiException(400, "MANAGED_PATH_SYMLINK", "Managed path must not contain symbolic links: " + managedPath, managedPath);
            }
        }

        Path normalizedGameDir = gameDir.toAbsolutePath().normalize();
        Path normalizedResult = result.toAbsolutePath().normalize();

        if (!normalizedResult.startsWith(normalizedGameDir)) {
            throw new ApiException(400, "MANAGED_PATH_ESCAPE", "Managed path escapes the game directory: " + managedPath, managedPath);
        }

        return normalizedResult;
    }

    public static String requireSide(String side) {
        if (side == null || !VALID_SIDES.contains(side)) {
            throw new ApiException(400, "FILE_SIDE_INVALID", "Invalid file destination: " + side, side);
        }

        return side;
    }

    public static boolean neededFor(String fileSide, String targetSide) {
        return "both".equals(fileSide) || targetSide.equals(fileSide);
    }

    public static String safeExtension(String managedPath) {
        String fileName = managedPath.substring(managedPath.lastIndexOf('/') + 1);
        int dot = fileName.lastIndexOf('.');

        if (dot < 0) {
            return ".bin";
        }

        String extension = fileName.substring(dot);
        return extension.matches("\\.[A-Za-z0-9_-]{1,16}") ? extension : ".bin";
    }

    public static String modsRelativePath(String managedPath) {
        String normalized = normalize(managedPath);
        return normalized.startsWith("mods/") ? normalized.substring("mods/".length()) : null;
    }
}
