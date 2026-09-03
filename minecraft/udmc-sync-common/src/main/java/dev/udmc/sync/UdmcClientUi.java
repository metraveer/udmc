package dev.udmc.sync;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.MultiLineTextWidget;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;
import net.minecraft.client.gui.screens.multiplayer.SafetyScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.ServerList;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.network.chat.Component;
import java.nio.file.Path;
import java.util.List;

public final class UdmcClientUi {
    private record State(Component title, Component message, List<ClientModCheck.Conflict> conflicts, boolean running, boolean restart, boolean success, String gameAddress,
                         ClientProject.Offer offer) {
        State(Component title, Component message, List<ClientModCheck.Conflict> conflicts, boolean running, boolean restart) {
            this(title, message, conflicts, running, restart, false, "", null);
        }
        State(Component title, Component message, List<ClientModCheck.Conflict> conflicts, boolean running, boolean restart, boolean success) {
            this(title, message, conflicts, running, restart, success, "", null);
        }
        State(Component title, Component message, List<ClientModCheck.Conflict> conflicts, boolean running, boolean restart, boolean success, String gameAddress) {
            this(title, message, conflicts, running, restart, success, gameAddress, null);
        }
    }
    private static volatile State state;
    private static volatile boolean dismissed;
    /** The address the server publishes, waiting to be put into the player's own server list. */
    private static volatile String offerServer = "";
    private static Path gameDir;
    private static UdmcConfig config;
    private static long lastProgress;

    static void start(Path directory, UdmcConfig settings) { start(directory, settings, false); }

    /**
     * @param announce whether the player is owed an answer. A launch is not: if the pack is
     *     already correct there is nothing to say, and saying it cost a screen and a click
     *     every single time. Having just agreed to something is: they acted, and silence
     *     after an action reads as a failure.
     */
    static void start(Path directory, UdmcConfig settings, boolean announce) {
        gameDir = directory;
        config = settings;
        dismissed = false;
        // One mod for everybody means a fresh client belongs to nothing until it joins a
        // server and the player accepts what that server offers. Until then there is no
        // project to sync against, and guessing one from a leftover config is how a client
        // ends up answering for a server nobody serves.
        if (!ClientProject.configured(settings)) {
            // Nothing to announce: a client that belongs to nobody yet is not a problem, and
            // the server it joins will offer itself. Saying so on every launch is noise.
            state = null;
            return;
        }
        state = new State(text("udmc_sync.title.check"), text("udmc_sync.message.connecting"), List.of(), true, false);
        Thread worker = new Thread(() -> {
            try {
                if (AgentUpdater.checkClient(gameDir, config, (file, done, total) -> {
                    state = new State(text("udmc_sync.title.agent_update"), Component.literal(file + (total > 0 ? " · " + done * 100 / total + "%" : "")), List.of(), true, false);
                })) {
                    state = new State(text("udmc_sync.title.agent_ready"), text("udmc_sync.message.agent_ready"), List.of(), false, true);
                    return;
                }
                SyncResult result = ModSynchronizer.syncClient(gameDir, config, new ModSynchronizer.Progress() {
                    @Override public void update(String file, long done, long total) {
                    long now = System.nanoTime();
                    if (now - lastProgress < 250_000_000L && done != total) return;
                    lastProgress = now;
                    String progress = total > 0 ? " · " + (done * 100 / total) + "%" : "";
                    state = new State(text("udmc_sync.title.sync"), Component.literal(file + progress), List.of(), true, false);
                    }
                    @Override public void stage(Messages.Message message) {
                        state = new State(text("udmc_sync.title.sync"), component(message), List.of(), true, false);
                    }
                });
                UdmcSync.LOGGER.info("Client sync: downloaded={}, skipped={}, removed={}", result.downloaded, result.skipped, result.removed);
                // Changed files mean the game has to be restarted before they load - that is
                // worth a screen. Nothing changed means the player can just play, and the
                // screen that said so was in the way of every single launch. The one useful
                // thing it carried - the server the owner published - is put where a player
                // looks for a server anyway, instead of behind a screen of ours.
                String address = ModSynchronizer.fetchGameAddress(config);
                offerServer = address;
                // A file of the player's own that the pack now runs on is said on whatever
                // screen the sync has anyway, and earns a screen of its own the first time:
                // silence about it would leave the player guessing when the server disagrees.
                Component standIns = standIns(result);
                state = result.changed()
                    ? new State(text("udmc_sync.title.ready"), withStandIns(text("udmc_sync.message.ready"), standIns), List.of(), false, true)
                    : announce || !result.newStandIns.isEmpty()
                        ? new State(text("udmc_sync.title.verified"), withStandIns(text("udmc_sync.message.verified"), standIns), List.of(), false, false, true, address)
                        : null;
            } catch (ClientModCheck.Conflicts error) {
                state = new State(text("udmc_sync.title.conflicts"), Component.empty(), error.files, false, false);
                UdmcSync.LOGGER.warn("Local mod conflicts: {}", error.getMessage());
            } catch (Exception error) {
                state = new State(text("udmc_sync.title.failed"), component(Messages.failure(error)), List.of(), false, false);
                UdmcSync.LOGGER.error("UDMC client sync failed", error);
            }
        }, "UDMC Client Sync");
        worker.setDaemon(true);
        worker.start();
    }

    static Component component(Messages.Message message) {
        return Component.translatableWithFallback(message.key(), message.fallback(), message.args().toArray());
    }

    /** One line per file of the player's own that a pack entry defers to: which, instead of which, and what to do if it fails. */
    private static Component standIns(SyncResult result) {
        var lines = Component.empty();
        for (var standIn : result.standIns) {
            lines.append("\n\n").append(text("udmc_sync.message.stand_in", standIn.theirs(), standIn.theirVersion(), standIn.ours(), standIn.ourVersion()));
        }
        return lines;
    }

    private static Component withStandIns(Component message, Component standIns) {
        return Component.empty().append(message).append(standIns);
    }

    private static Component text(String key, Object... args) { return component(Messages.of(key, args)); }

    public static void tick() {
        // A project decision belongs between sessions, not on top of a game the player is in
        // the middle of. The offer waits in the protocol until they come back - and being
        // turned away counts as coming back, or the player is sent to look for a question
        // that is waiting on a screen they have to guess their way to.
        Screen screen = ClientPlatform.screen();
        boolean title = screen instanceof TitleScreen;
        boolean list = screen instanceof JoinMultiplayerScreen;
        // A player the server has just turned away is reading our own reason for it. The
        // question that answers that reason belongs on that screen and not one click later:
        // being told to leave a screen in order to be asked something is two screens for one
        // decision. Somebody else's disconnect is left alone - it is checked by our own name
        // in the message, the same way the buttons on that screen are.
        boolean turnedAway = screen instanceof DisconnectedScreen
            && screen.getNarrationMessage().getString().contains("UDMC");
        if (!title && !list && !turnedAway) return;
        // On the game thread, where touching the saved server list is safe.
        if (!offerServer.isEmpty()) {
            String address = offerServer;
            offerServer = "";
            findOrAddServer(Minecraft.getInstance(), address);
        }
        if (config != null) consider(AgentLoginProtocol.takeOffer());
        State pending = state;
        if (pending == null || dismissed) return;
        if (!presentable(title, list || turnedAway, pending.offer() != null)) return;
        ClientPlatform.open(new StatusScreen());
    }

    /**
     * Whether something waiting to be shown may take over the screen the player is on.
     *
     * <p>The title screen takes anything. The screen a player was turned away on, and the
     * server list they land on next, take only the question about a project - it is the answer
     * to why they are there. Someone merely choosing a server must not have the list pulled
     * out from under them by a synchronisation that happened to finish.
     */
    static boolean presentable(boolean title, boolean waiting, boolean question) {
        if (!title && !waiting) return false;
        return title || question;
    }

    private static ServerData findOrAddServer(Minecraft minecraft, String address) {
        String name = config != null && config.packName != null && !config.packName.isBlank() ? config.packName : "UDMC";
        try {
            ServerList list = new ServerList(minecraft);
            list.load();
            for (int i = 0; i < list.size(); i++) {
                ServerData entry = list.get(i);
                if (address.equals(entry.ip)) return entry;
            }
            ServerData created = new ServerData(name, address, ServerData.Type.OTHER);
            list.add(created, false);
            list.save();
            return created;
        } catch (RuntimeException error) {
            UdmcSync.LOGGER.warn("Cannot update the saved server list", error);
            return new ServerData(name, address, ServerData.Type.OTHER);
        }
    }

    /** Turns what the last server said about itself into something the player can answer. */
    private static void consider(ClientProject.Offer offer) {
        if (offer == null) return;
        String name = offer.packName().isEmpty() ? offer.packId() : offer.packName();
        ClientProject.Verdict verdict = ClientProject.reconcile(gameDir, config, offer);
        UdmcSync.LOGGER.info("UDMC decided about project {}: {}", offer.packId(), verdict);
        switch (verdict) {
            case NEW_PROJECT -> show(new State(text("udmc_sync.title.setup"),
                text("udmc_sync.message.setup", name, spaced(offer.fingerprint())), List.of(), false, false, false, "", offer));
            case OTHER_PROJECT -> show(new State(text("udmc_sync.title.other_project"),
                text("udmc_sync.message.other_project", config.packName, name), List.of(), false, false));
            case KEY_CHANGED -> show(new State(text("udmc_sync.title.key_changed"),
                text("udmc_sync.message.key_changed", name, spaced(offer.fingerprint())), List.of(), false, false));
            default -> { }
        }
    }

    private static void show(State next) {
        dismissed = false;
        state = next;
    }

    /** A 64-character hash is compared by eye, so it is read in groups rather than as a wall. */
    private static String spaced(String fingerprint) {
        return fingerprint.replaceAll("(.{4})(?=.)", "$1 ");
    }

    private static final class StatusScreen extends Screen {
        private State displayed;
        private int index;
        StatusScreen() { super(Component.literal("UDMC")); }

        @Override
        protected void init() {
            displayed = state;
            if (displayed == null) return;
            int contentWidth = Math.max(140, Math.min(width - 32, 540));
            int x = (width - contentWidth) / 2;
            addRenderableWidget(new MultiLineTextWidget(x, 18, Component.literal("UDMC · ").append(displayed.title), font).setMaxWidth(contentWidth).setCentered(true));
            boolean conflict = !displayed.conflicts.isEmpty();
            index = Math.min(index, Math.max(0, displayed.conflicts.size() - 1));
            var file = conflict ? displayed.conflicts.get(index) : null;
            Component message = displayed.message;
            if (conflict) {
                // What the player is actually waiting for. Without this line the screen reads as a
                // warning, and the question it leaves behind - "so why are the server's mods not
                // arriving?" - has to be asked out loud before anyone answers it.
                var details = Component.empty().append(text("udmc_sync.message.conflict_blocking")).append("\n\n")
                    .append(Component.literal((index + 1) + " / " + displayed.conflicts.size() + "\n" + file.path()));
                for (var reason : file.reasons()) details.append("\n").append(component(reason));
                details.append("\n").append(file.path().isBlank() ? text("udmc_sync.message.admin_conflict") : text("udmc_sync.message.conflict_backup"));
                message = details;
            }
            addRenderableWidget(new MultiLineTextWidget(x, 50, message, font).setMaxWidth(contentWidth).setMaxRows(Math.max(3, (height - 158) / 9)));
            int y = height - 72;
            int half = (contentWidth - 8) / 2;
            if (conflict) {
                Button remove = Button.builder(text("udmc_sync.button.disable"), b -> confirm(file)).bounds(x, y, contentWidth, 20).build();
                remove.active = !file.path().isBlank(); addRenderableWidget(remove);
                Button previous = Button.builder(text("udmc_sync.button.previous"), b -> { index--; rebuildWidgets(); }).bounds(x, y + 24, half, 20).build();
                previous.active = index > 0; addRenderableWidget(previous);
                Button next = Button.builder(text("udmc_sync.button.next"), b -> { index++; rebuildWidgets(); }).bounds(x + half + 8, y + 24, half, 20).build();
                next.active = index + 1 < displayed.conflicts.size(); addRenderableWidget(next);
            } else if (displayed.offer != null) {
                addRenderableWidget(Button.builder(text("udmc_sync.button.accept"), b -> {
                    ClientProject.accept(gameDir, config, displayed.offer);
                    start(gameDir, config, true);
                }).bounds(x, y, contentWidth, 20).build());
                addRenderableWidget(Button.builder(text("udmc_sync.button.decline"), b -> {
                    state = null;
                    dismissed = true;
                    ClientPlatform.open(new TitleScreen());
                }).bounds(x, y + 24, contentWidth, 20).build());
            } else if (!displayed.running) {
                boolean direct = displayed.success && !displayed.gameAddress.isBlank();
                if (direct) {
                    Button connect = Button.builder(text("udmc_sync.button.connect"), b -> connect(displayed.gameAddress))
                        .bounds(x, y, contentWidth, 20)
                        .tooltip(Tooltip.create(Component.literal(displayed.gameAddress)))
                        .build();
                    restrictToMultiplayer(connect);
                    addRenderableWidget(connect);
                }
                Button primary = Button.builder(displayed.restart ? text("udmc_sync.button.quit") : displayed.success ? text("udmc_sync.button.multiplayer") : text("udmc_sync.button.retry"), b -> {
                    if (displayed.restart) Minecraft.getInstance().stop();
                    else if (displayed.success) {
                        if (!Minecraft.getInstance().allowsMultiplayer()) return;
                        dismissed = true;
                        Screen parent = new TitleScreen();
                        ClientPlatform.open(Minecraft.getInstance().options.skipMultiplayerWarning
                            ? new JoinMultiplayerScreen(parent) : new SafetyScreen(parent));
                    } else start(gameDir, config);
                }).bounds(x, direct ? y + 24 : y, contentWidth, 20).build();
                if (displayed.success && !Minecraft.getInstance().allowsMultiplayer()) restrictToMultiplayer(primary);
                addRenderableWidget(primary);
            }
            if (!displayed.restart) {
                Button close = Button.builder(displayed.running ? text("udmc_sync.button.checking") : text("udmc_sync.button.menu"), b -> onClose()).bounds(x, height - 24, contentWidth, 20).build();
                close.active = !displayed.running; addRenderableWidget(close);
            }
        }

        private static void restrictToMultiplayer(Button button) {
            if (Minecraft.getInstance().allowsMultiplayer()) return;
            button.active = false;
            button.setTooltip(Tooltip.create(Component.translatable("title.multiplayer.disabled")));
        }

        // Joins the published game address with the vanilla safeguards intact: parental/account limits keep
        // the button disabled, and an enabled third-party warning shows the stock SafetyScreen first, whose
        // flow lands on the multiplayer list where the saved entry is ready to join.
        private void connect(String address) {
            Minecraft minecraft = Minecraft.getInstance();
            if (!minecraft.allowsMultiplayer()) return;
            dismissed = true;
            ServerData server = findOrAddServer(minecraft, address);
            Screen parent = new TitleScreen();
            if (!minecraft.options.skipMultiplayerWarning) {
                ClientPlatform.open(new SafetyScreen(parent));
                return;
            }
            ConnectScreen.startConnecting(new JoinMultiplayerScreen(parent), minecraft, ServerAddress.parseString(address), server, false, null);
        }

        private void confirm(ClientModCheck.Conflict file) {
            ClientPlatform.open(new net.minecraft.client.gui.screens.ConfirmScreen(confirmed -> {
                if (!confirmed) { ClientPlatform.open(this); return; }
                state = new State(text("udmc_sync.title.disabling"), Component.literal(file.path()), List.of(), true, false);
                ClientPlatform.open(this);
                Thread worker = new Thread(() -> {
                    try {
                        Path backup = ClientModCheck.disable(gameDir, file);
                        state = new State(text("udmc_sync.title.disabled"), text("udmc_sync.message.disabled", file.path(), gameDir.relativize(backup)), List.of(), false, true);
                    } catch (Exception e) {
                        UdmcSync.LOGGER.error("Cannot disable personal mod {}", file.path(), e);
                        state = new State(text("udmc_sync.title.disable_failed"), component(Messages.failure(e)), List.of(), false, true);
                    }
                }, "UDMC File Backup");
                worker.setDaemon(true); worker.start();
            }, text("udmc_sync.title.confirm_disable"), text("udmc_sync.message.confirm_disable", file.path()), text("udmc_sync.button.disable"), text("udmc_sync.button.cancel")));
        }

        @Override public void tick() {
            if (displayed == state) return;
            // The last thing to say has been said: close instead of standing there empty.
            if (state == null) { dismissed = true; ClientPlatform.open(new TitleScreen()); return; }
            rebuildWidgets();
        }
        @Override public boolean shouldCloseOnEsc() { return state != null && !state.running && !state.restart; }
        @Override public void onClose() { if (shouldCloseOnEsc()) { dismissed = true; ClientPlatform.open(new TitleScreen()); } }
    }
}
