package dev.udmc.sync;

public final class SyncResult {
    public String packVersion;
    public int downloaded;
    public int skipped;
    public int removed;
    public int retainedModified;

    public boolean changed() {
        return downloaded > 0 || removed > 0;
    }
}
