package dev.udmc.sync;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.MultiLineTextWidget;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.ConnectScreen;
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
    private record State(Component title, Component message, List<ClientModCheck.Conflict> conflicts, boolean running, boolean restart, boolean success, String gameAddress) {
        State(Component title, Component message, List<ClientModCheck.Conflict> conflicts, boolean running, boolean restart) {
            this(title, message, conflicts, running, restart, false, "");
        }
        State(Component title, Component message, List<ClientModCheck.Conflict> conflicts, boolean running, boolean restart, boolean success) {
            this(title, message, conflicts, running, restart, success, "");
        }
    }
    private static volatile State state;
    private static volatile boolean dismissed;
    private static Path gameDir;
    private static UdmcConfig config;
    private static long lastProgress;

    static void start(Path directory, UdmcConfig settings) {
        gameDir = directory;
        config = settings;
        dismissed = false;
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
                state = result.changed()
                    ? new State(text("udmc_sync.title.ready"), text("udmc_sync.message.ready"), List.of(), false, true)
                    : new State(text("udmc_sync.title.verified"), text("udmc_sync.message.verified"), List.of(), false, false, true,
                        ModSynchronizer.fetchGameAddress(config));
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

    private static Component text(String key, Object... args) { return component(Messages.of(key, args)); }

    public static void tick() {
        if (state == null || dismissed || !(ClientPlatform.screen() instanceof TitleScreen)) return;
        ClientPlatform.open(new StatusScreen());
    }

    private static final class StatusScreen extends Screen {
        private State displayed;
        private int index;
        StatusScreen() { super(Component.literal("UDMC Sync")); }

        @Override
        protected void init() {
            displayed = state;
            if (displayed == null) return;
            int contentWidth = Math.max(140, Math.min(width - 32, 540));
            int x = (width - contentWidth) / 2;
            addRenderableWidget(new MultiLineTextWidget(x, 18, Component.literal("UDMC Sync · ").append(displayed.title), font).setMaxWidth(contentWidth).setCentered(true));
            boolean conflict = !displayed.conflicts.isEmpty();
            index = Math.min(index, Math.max(0, displayed.conflicts.size() - 1));
            var file = conflict ? displayed.conflicts.get(index) : null;
            Component message = displayed.message;
            if (conflict) {
                var details = Component.literal((index + 1) + " / " + displayed.conflicts.size() + "\n" + file.path());
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

        @Override public void tick() { if (displayed != state) rebuildWidgets(); }
        @Override public boolean shouldCloseOnEsc() { return state != null && !state.running && !state.restart; }
        @Override public void onClose() { if (shouldCloseOnEsc()) { dismissed = true; ClientPlatform.open(new TitleScreen()); } }
    }
}
