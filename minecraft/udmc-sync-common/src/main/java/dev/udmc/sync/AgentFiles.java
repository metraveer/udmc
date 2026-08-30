package dev.udmc.sync;

import java.io.IOException;
import java.nio.file.Path;
import java.util.zip.ZipException;
import java.util.zip.ZipFile;

public final class AgentFiles {
    private AgentFiles() {
    }

    public static boolean isAgent(Path path) throws IOException {
        try (ZipFile zip = new ZipFile(path.toFile())) {
            if (zip.getEntry("udmc-bootstrap.json") != null) return true;
            return LoaderPlatform.isAgent(zip);
        } catch (ZipException notAnArchive) {
            return false;
        }
    }
}
