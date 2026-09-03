package dev.udmc.sync;

public final class SyncResult {
    /**
     * A file of the player's own that a pack entry defers to: the same mod at a version the
     * pack's mods are content with, kept in place with nothing installed over it.
     */
    public record StandIn(String theirs, String theirVersion, String ours, String ourVersion) {}

    public String packVersion;
    public java.util.List<StandIn> standIns = java.util.List.of();
    /** The stand-ins decided for the first time on this run - the ones the player has not been told about yet. */
    public java.util.List<StandIn> newStandIns = java.util.List.of();
    public int downloaded;
    public int skipped;
    public int removed;
    public int retainedModified;

    public boolean changed() {
        return downloaded > 0 || removed > 0;
    }
}
